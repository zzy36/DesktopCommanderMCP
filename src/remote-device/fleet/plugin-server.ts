import { timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LCM_REMOTE_TOOL_CATALOG } from './lcm-remote-tool-catalog.js';

export interface FleetPluginDeviceView {
    hostname: string;
    online: boolean;
    policyRevision?: string;
}

export interface FleetPluginBackend {
    fleetStatus(projectId: string, hostname: string): Promise<Record<string, unknown>>;
    listDevices(projectId: string): Promise<FleetPluginDeviceView[]>;
    callProjectTool(projectId: string, hostname: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
    readTestFile?(projectId: string, hostname: string): Promise<string>;
    writeTestFile?(projectId: string, hostname: string, content: string): Promise<{ bytesWritten: number }>;
}

export interface FleetPluginMcpOptions {
    enforceOAuthScopes?: boolean;
}

export interface FleetPluginHttpOptions {
    bearerToken?: string;
}

const FLEET_CONTROL_TOOLS: any[] = [
    {
        name: 'fleet_status',
        title: 'Fleet Status',
        description: 'Check the exact authorized Fleet target for an L3 project. Never falls back to another host.',
        inputSchema: {
            type: 'object',
            properties: {
                project_id: { type: 'string', minLength: 1 },
                hostname: { type: 'string', minLength: 1 },
            },
            required: ['project_id', 'hostname'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
        name: 'list_devices',
        title: 'List Fleet Devices',
        description: 'List devices visible to the exact L3 project without exposing private keys or runtime account identifiers.',
        inputSchema: {
            type: 'object',
            properties: { project_id: { type: 'string', minLength: 1 } },
            required: ['project_id'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
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
    if (!value) throw Object.assign(new Error(`${key} is required`), { code: 'PROJECT_DEVICE_DENIED' });
    return value;
}

function toolError(error: unknown) {
    const code = typeof (error as any)?.code === 'string' ? `${(error as any).code}: ` : '';
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: `${code}${message}` }], isError: true };
}

export function createFleetPluginMcpServer(
    backend: FleetPluginBackend,
    options: FleetPluginMcpOptions = {},
): McpProtocolServer {
    const enforceScopes = options.enforceOAuthScopes === true;
    const server = new McpProtocolServer(
        { name: 'local-control-mcp-remote', version: '0.3.0' },
        { capabilities: { tools: {} }, instructions: 'Remote Local Control MCP. Every project tool requires exact project_id + hostname and is re-authorized by the target Agent through local .control.' },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [...FLEET_CONTROL_TOOLS, ...LCM_REMOTE_TOOL_CATALOG],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const toolName = request.params.name;
        const args = request.params.arguments && typeof request.params.arguments === 'object'
            ? request.params.arguments as Record<string, unknown> : {};
        try {
            if (toolName === 'fleet_status') {
                requireScope(extra, 'fleet:read', enforceScopes);
                const projectId = requiredString(args, 'project_id');
                const hostname = requiredString(args, 'hostname');
                return jsonResult(await backend.fleetStatus(projectId, hostname));
            }
            if (toolName === 'list_devices') {
                requireScope(extra, 'fleet:read', enforceScopes);
                const projectId = requiredString(args, 'project_id');
                return jsonResult({ project_id: projectId, devices: await backend.listDevices(projectId) });
            }

            const definition = REMOTE_BY_NAME.get(toolName);
            if (!definition) return toolError(Object.assign(new Error(`tool is not exposed by Local Control MCP: ${toolName}`), { code: 'PROJECT_DEVICE_DENIED' }));
            requireScope(extra, definition.annotations?.readOnlyHint === true ? 'fleet:read' : 'fleet:write', enforceScopes);
            const projectId = requiredString(args, 'project_id');
            const hostname = requiredString(args, 'hostname');
            const forwarded = { ...args };
            delete forwarded.project_id;
            delete forwarded.hostname;
            return await backend.callProjectTool(projectId, hostname, toolName, forwarded) as any;
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
