import { timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LCM_REMOTE_TOOL_CATALOG } from './lcm-remote-tool-catalog.js';
import { localizeLcmTool, localizeLcmError } from './presentation-zh.js';
import { LCM_ICONS, LCM_BRAND_TITLE } from './branding.js';

export interface FleetPluginDeviceView {
    hostname: string;
    online: boolean;
    policyRevision?: string | null;
}

export interface FleetPluginBackend {
    fleetStatus(projectId: string, hostname: string): Promise<Record<string, unknown>>;
    listDevices(projectId: string): Promise<FleetPluginDeviceView[]>;
    callProjectTool(projectId: string, hostname: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
    callMachineTool(hostname: string, toolName: string, args: Record<string, unknown>, explicitAuthorization: boolean): Promise<unknown>;
    ping(projectId: string, hostname: string): Promise<Record<string, unknown>>;
    whoAmI(): Promise<Record<string, unknown>>;
    getToolResult(projectId: string, hostname: string, callId: string): Promise<Record<string, unknown>>;
    listRemoteToolCalls(projectId: string, hostname: string | undefined, limit: number): Promise<Record<string, unknown>[]>;
    callDeviceTool?(hostname: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
    usageStats?(): Promise<Record<string, unknown>>;
    readTestFile?(projectId: string, hostname: string): Promise<string>;
    writeTestFile?(projectId: string, hostname: string, content: string): Promise<{ bytesWritten: number }>;
}

export interface FleetPluginMcpOptions {
    enforceOAuthScopes?: boolean;
}

export interface FleetPluginHttpOptions {
    bearerToken?: string;
}

const control = (name: string, description: string, properties: any, required: string[] = []) => ({
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
});
const host = { type: 'string', minLength: 1, description: 'Exact enrolled hostname; never redirects to another device.' };
const FLEET_CONTROL_TOOLS: any[] = [
    control('fleet_status', 'Status of an exact Owner-enrolled device.', { hostname: host }, ['hostname']),
    control('list_devices', 'List all Owner-enrolled devices, online/offline, last seen, runtime and fingerprint.', {}),
    control('ping', 'Perform a real round-trip to the exact enrolled Agent.', { hostname: host }, ['hostname']),
    control('who_am_i', 'Report the private LCM product identity.', {}),
    control('get_tool_result', 'Read an Owner-scoped asynchronous call by call_id; optionally assert exact device.', { hostname: host, call_id: { type: 'string', minLength: 1 } }, ['call_id']),
    control('list_remote_tool_calls', 'Owner-scoped recent calls, optionally filtered to one device.', { hostname: host, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }),
    control('get_usage_stats', 'Local Gateway lifetime counters, health, latency, timeout, bytes and in-flight. No hosted billing.', {}),
];

const REMOTE_BY_NAME = new Map(LCM_REMOTE_TOOL_CATALOG.map((tool) => [tool.name, tool]));

function jsonResult(value: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', Buffer.byteLength(body));
    res.end(body);
}

function bearerMatches(req: IncomingMessage, expected: string | undefined): boolean {
    if (!expected) return true;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7), 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function rejectUnauthorized(res: ServerResponse): void {
    res.setHeader('www-authenticate', 'Bearer realm="local-control-mcp"');
    sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

function requireScope(extra: { authInfo?: { scopes?: string[] } }, scope: string, enabled: boolean): void {
    if (!enabled) return;
    if (!extra.authInfo?.scopes?.includes(scope)) {
        const error = new Error(`OAuth scope required: ${scope}`);
        Object.assign(error, { code: 'INSUFFICIENT_SCOPE' });
        throw error;
    }
}

function requiredString(args: Record<string, unknown>, key: string): string {
    const value = typeof args[key] === 'string' ? args[key].trim() : '';
    if (!value) throw Object.assign(new Error(`${key} is required`), { code: 'INVALID_ARGUMENT' });
    return value;
}

function toolError(error: unknown) {
    const code = typeof (error as any)?.code === 'string' ? `${(error as any).code}: ` : '';
    const message = localizeLcmError(error);
    return { content: [{ type: 'text' as const, text: `${code}${message}` }], isError: true };
}

export function createFleetPluginMcpServer(
    backend: FleetPluginBackend,
    options: FleetPluginMcpOptions = {},
): McpProtocolServer {
    const enforceScopes = options.enforceOAuthScopes === true;
    const server = new McpProtocolServer(
        { name: 'local-control-mcp-remote', title: LCM_BRAND_TITLE, icons: LCM_ICONS, version: '0.3.5' },
        { capabilities: { tools: {} }, instructions: 'Local Control MCP is an Owner-scoped device transport. list_devices needs no project. Select the exact enrolled hostname for execution; never redirect an offline device. Target governance is external. Use interactive for logged-in user tools; never downgrade to SYSTEM. Do not replay uncertain writes.' },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [...FLEET_CONTROL_TOOLS, ...LCM_REMOTE_TOOL_CATALOG].map(localizeLcmTool).map(tool => ({ ...tool, icons: LCM_ICONS })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const toolName = request.params.name;
        const args = request.params.arguments && typeof request.params.arguments === 'object'
            ? request.params.arguments as Record<string, unknown> : {};
        try {
            if (toolName === 'fleet_status') {
                requireScope(extra, 'fleet:read', enforceScopes);
                const projectId = '';
                const hostname = requiredString(args, 'hostname');
                return jsonResult(await backend.fleetStatus(projectId, hostname));
            }
            if (toolName === 'list_devices') {
                requireScope(extra, 'fleet:read', enforceScopes);
                const projectId = '';
                return jsonResult({ devices: await backend.listDevices(projectId) });
            }
            if (toolName === 'ping') {
                requireScope(extra, 'fleet:read', enforceScopes);
                return jsonResult(await backend.ping('', requiredString(args, 'hostname')));
            }
            if (toolName === 'who_am_i') {
                requireScope(extra, 'fleet:read', enforceScopes);
                return jsonResult(await backend.whoAmI());
            }
            if (toolName === 'get_tool_result') {
                requireScope(extra, 'fleet:read', enforceScopes);
                return jsonResult(await backend.getToolResult(
                    '',
                    typeof args.hostname === 'string' ? args.hostname : '',
                    requiredString(args, 'call_id'),
                ));
            }
            if (toolName === 'list_remote_tool_calls') {
                requireScope(extra, 'fleet:read', enforceScopes);
                const projectId = '';
                const hostname = typeof args.hostname === 'string' && args.hostname.trim() ? args.hostname.trim() : undefined;
                const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : 20;
                return jsonResult({ calls: await backend.listRemoteToolCalls(projectId, hostname, limit) });
            }

            if (toolName === 'get_usage_stats') {
                requireScope(extra, 'fleet:read', enforceScopes);
                return jsonResult(await backend.usageStats?.() ?? {});
            }
            const definition = REMOTE_BY_NAME.get(toolName);
            if (!definition) return toolError(Object.assign(new Error(`Unknown LCM tool: ${toolName}`), { code: 'INVALID_TOOL' }));
            requireScope(extra, definition.annotations?.readOnlyHint === true ? 'fleet:read' : 'fleet:write', enforceScopes);
            const hostname = requiredString(args, 'hostname');
            const forwarded = { ...args };
            delete forwarded.hostname;
            // Public device-first tools never accept legacy governance arguments.
            // Governance context, when present, is opaque MCP metadata only.
            delete forwarded.project_id; delete forwarded.scope_kind; delete forwarded.machine_approval;
            if (request.params._meta) forwarded._lcm_context = request.params._meta;
            if (backend.callDeviceTool) return await backend.callDeviceTool(hostname, toolName, forwarded) as any;
            return await backend.callMachineTool(hostname, toolName, forwarded, true) as any;

        } catch (error) {
            return toolError(error);
        }
    });

    return server;
}

async function handleMcpRequest(backend: FleetPluginBackend, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = createFleetPluginMcpServer(backend);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
    } catch {
        if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
    }
}

export function createFleetPluginHttpServer(backend: FleetPluginBackend, options: FleetPluginHttpOptions = {}) {
    return createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/healthz') {
            sendJson(res, 200, { ok: true, service: 'local-control-mcp-remote' });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/readyz') {
            sendJson(res, 200, { ok: true, service: 'local-control-mcp-remote', ready: true });
            return;
        }
        if (url.pathname !== '/mcp') {
            sendJson(res, 404, { error: 'not found' });
            return;
        }
        if (!bearerMatches(req, options.bearerToken)) {
            rejectUnauthorized(res);
            return;
        }
        if (req.method !== 'POST') {
            sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
            return;
        }
        await handleMcpRequest(backend, req, res);
    });
}
