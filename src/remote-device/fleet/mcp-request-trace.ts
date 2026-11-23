import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

export const TRACE_ID_HEADER = 'x-lcm-request-id';
export const TRACE_PROOF_HEADER = 'x-lcm-trace-proof';
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Stage = 'edge_received' | 'edge_forwarded' | 'edge_response' | 'edge_closed' |
    'edge_upstream_headers' | 'edge_upstream_first_byte' | 'edge_upstream_end' |
    'edge_upstream_aborted' | 'edge_upstream_error' | 'edge_upstream_socket' | 'edge_upstream_connected' | 'gateway_received' |
    'gateway_authenticated' | 'dispatch' | 'receipt' | 'dispatch_ended' | 'gateway_response' | 'gateway_closed';
type Outcome = 'ok' | 'error';
const SAFE_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE']);
const RPC_METHODS = ['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'] as const;
type RpcMethod = typeof RPC_METHODS[number] | 'other';

export function traceRpcMethod(value: unknown): RpcMethod {
    return RPC_METHODS.find(method => method === value) ?? 'other';
}

const context = new AsyncLocalStorage<McpRequestTrace>();
export const currentMcpTrace = () => context.getStore();

export function readTraceKey(value: string | undefined): Buffer | undefined {
    if (value === undefined) return undefined;
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('MCP trace key must be 32 hexadecimal bytes');
    return Buffer.from(value, 'hex');
}

export function traceProof(id: string, key: Buffer): string {
    return createHmac('sha256', key).update('lcm-mcp-trace-v1:' + id).digest('hex');
}

function verifiedEdgeId(headers: IncomingHttpHeaders, key: Buffer): string | undefined {
    const id = headers[TRACE_ID_HEADER];
    const proof = headers[TRACE_PROOF_HEADER];
    if (typeof id !== 'string' || !ID_PATTERN.test(id)
        || typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return undefined;
    return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(traceProof(id, key), 'hex')) ? id : undefined;
}

export class McpRequestTrace {
    private readonly started = performance.now();

    constructor(
        readonly requestId: string = randomUUID(),
        private readonly source: 'edge' | 'verified_edge' | 'gateway' = 'edge',
    ) {}

    stage(stage: Stage, details: { status?: number; outcome?: Outcome; rpcMethod?: RpcMethod; upstreamBytes?: number; errorCode?: string; reusedSocket?: boolean } = {}) {
        const { status, outcome, rpcMethod, upstreamBytes, errorCode, reusedSocket } = details;
        console.info(JSON.stringify({
            event: 'lcm_mcp_trace',
            requestId: this.requestId,
            source: this.source,
            stage,
            atMs: Date.now(),
            elapsedMs: Math.round(performance.now() - this.started),
            ...(status !== undefined ? { status } : {}),
            ...(outcome !== undefined ? { outcome } : {}),
            ...(rpcMethod !== undefined ? { rpcMethod } : {}),
            ...(Number.isSafeInteger(upstreamBytes) && upstreamBytes! >= 0 ? { upstreamBytes } : {}),
            ...(typeof errorCode === 'string' ? { errorCode: SAFE_ERROR_CODES.has(errorCode) ? errorCode : 'OTHER' } : {}),
            ...(typeof reusedSocket === 'boolean' ? { reusedSocket } : {}),
        }));
    }
}

export function traceGatewayRequest(req: IncomingMessage, res: ServerResponse, key: Buffer, next: () => void) {
    const id = verifiedEdgeId(req.headers, key);
    const trace = new McpRequestTrace(id, id ? 'verified_edge' : 'gateway');
    // These internal headers must not reach the MCP adapter or the bearer middleware.
    delete req.headers[TRACE_ID_HEADER];
    delete req.headers[TRACE_PROOF_HEADER];
    res.setHeader(TRACE_ID_HEADER, trace.requestId);
    trace.stage('gateway_received');
    res.once('finish', () => trace.stage('gateway_response', { status: res.statusCode }));
    res.once('close', () => {
        if (!res.writableFinished) trace.stage('gateway_closed');
    });
    context.run(trace, next);
}
