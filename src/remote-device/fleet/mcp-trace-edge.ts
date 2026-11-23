import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { McpRequestTrace, TRACE_ID_HEADER, TRACE_PROOF_HEADER, traceProof } from './mcp-request-trace.js';

const HOP_HEADERS = [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
    'te', 'trailer', 'transfer-encoding', 'upgrade', TRACE_ID_HEADER, TRACE_PROOF_HEADER,
];

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
    const copy = { ...headers };
    const connectionHeaders = (headers.connection ?? '').split(',').map(name => name.trim().toLowerCase());
    for (const name of [...HOP_HEADERS, ...connectionHeaders]) delete copy[name];
    return copy;
}

/**
 * Loopback HTTP hop after TLS termination and before the FRP listener. It
 * attaches a trace only to MCP POSTs and never changes the authorization path.
 */
export function createMcpTraceEdge(upstreamPort: number, traceKey: Buffer) {
    return createServer({ keepAliveTimeout: 75_000 }, (req, res) => {
        const url = req.url ?? '/';
        if (!url.startsWith('/') || url.startsWith('//')) {
            res.writeHead(400).end();
            return;
        }
        const trace = req.method === 'POST' && url.split('?', 1)[0] === '/mcp' ? new McpRequestTrace() : undefined;
        const headers = forwardHeaders(req.headers);
        // Count upstream response bytes only; never retain bodies or headers.
        let upstreamBytes = 0;
        if (trace) {
            headers[TRACE_ID_HEADER] = trace.requestId;
            headers[TRACE_PROOF_HEADER] = traceProof(trace.requestId, traceKey);
            res.setHeader(TRACE_ID_HEADER, trace.requestId);
            trace.stage('edge_received');
            res.once('finish', () => trace.stage('edge_response', { status: res.statusCode, upstreamBytes }));
            res.once('close', () => {
                if (!res.writableFinished) trace.stage('edge_closed', { upstreamBytes });
            });
        }
        const upstream = request({
            host: '127.0.0.1', port: upstreamPort, method: req.method, path: url, headers,
        }, incoming => {
            trace?.stage('edge_upstream_headers', { status: incoming.statusCode ?? 502 });
            if (trace) {
                let firstByte = true;
                incoming.on('data', (chunk: Buffer | string) => {
                    upstreamBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
                    if (firstByte) {
                        firstByte = false;
                        trace.stage('edge_upstream_first_byte', { upstreamBytes });
                    }
                });
                incoming.once('end', () => trace.stage('edge_upstream_end', { upstreamBytes }));
                incoming.once('aborted', () => trace.stage('edge_upstream_aborted', { upstreamBytes, outcome: 'error' }));
            }
            res.writeHead(incoming.statusCode ?? 502, forwardHeaders(incoming.headers));
            incoming.on('error', () => res.destroy());
            incoming.pipe(res);
        });
        upstream.once('finish', () => trace?.stage('edge_forwarded'));
        upstream.once('error', () => {
            trace?.stage('edge_upstream_error', { upstreamBytes, outcome: 'error' });
            if (!res.headersSent && !res.destroyed) res.writeHead(502).end();
            else if (!res.writableFinished) res.destroy();
        });
        res.once('close', () => {
            if (!res.writableFinished) upstream.destroy();
        });
        req.once('error', () => upstream.destroy());
        req.pipe(upstream);
    });
}
