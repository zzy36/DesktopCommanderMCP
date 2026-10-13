import { timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface FleetPluginDeviceView {
    hostname: string;
    online: boolean;
    policyRevision?: string;
}

export interface FleetPluginBackend {
    fleetStatus(projectId: string, hostname: string): Promise<Record<string, unknown>>;
    listDevices(projectId: string): Promise<FleetPluginDeviceView[]>;
    readTestFile(projectId: string, hostname: string): Promise<string>;
    writeTestFile(projectId: string, hostname: string, content: string): Promise<{ bytesWritten: number }>;
}

export interface FleetPluginMcpOptions {
    enforceOAuthScopes?: boolean;
}

export interface FleetPluginHttpOptions {
    bearerToken?: string;
}

function jsonResult(value: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    };
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
    res.setHeader('www-authenticate', 'Bearer realm="network-fleet-plugin"');
    sendJson(res, 401, {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
    });
}

function requireScope(extra: { authInfo?: { scopes?: string[] } }, scope: string, enabled: boolean): void {
    if (!enabled) return;
    if (!extra.authInfo?.scopes?.includes(scope)) {
        const error = new Error(`OAuth scope required: ${scope}`);
        Object.assign(error, { code: 'INSUFFICIENT_SCOPE' });
        throw error;
    }
}

export function createFleetPluginMcpServer(
    backend: FleetPluginBackend,
    options: FleetPluginMcpOptions = {},
): McpServer {
    const server = new McpServer({
        name: 'network-fleet-plugin',
        version: '0.1.0-poc',
    });
    const enforceScopes = options.enforceOAuthScopes === true;

    server.registerTool('fleet_status', {
        title: 'Fleet Status',
        description: 'Check the exact authorized fleet target for a project. Never falls back to another host.',
        inputSchema: {
            project_id: z.string().min(1),
            hostname: z.string().min(1),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
        },
    }, async ({ project_id, hostname }, extra) => {
        requireScope(extra, 'fleet:read', enforceScopes);
        return jsonResult(await backend.fleetStatus(project_id, hostname));
    });

    server.registerTool('list_devices', {
        title: 'List Fleet Devices',
        description: 'List devices visible to the requested project without exposing private keys or runtime account identifiers.',
        inputSchema: {
            project_id: z.string().min(1),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
        },
    }, async ({ project_id }, extra) => {
        requireScope(extra, 'fleet:read', enforceScopes);
        return jsonResult({
            project_id,
            devices: await backend.listDevices(project_id),
        });
    });

    server.registerTool('read_test_file', {
        title: 'Read Fleet Test File',
        description: 'Read only the dedicated Fleet Plugin test file on the exact authorized host.',
        inputSchema: {
            project_id: z.string().min(1),
            hostname: z.string().min(1),
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
        },
    }, async ({ project_id, hostname }, extra) => {
        requireScope(extra, 'fleet:read', enforceScopes);
        return jsonResult({
            project_id,
            hostname,
            content: await backend.readTestFile(project_id, hostname),
        });
    });

    server.registerTool('write_test_file', {
        title: 'Write Fleet Test File',
        description: 'Write only the dedicated Fleet Plugin test file on the exact authorized host. This PoC tool cannot choose an arbitrary path.',
        inputSchema: {
            project_id: z.string().min(1),
            hostname: z.string().min(1),
            content: z.string().max(4096),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
        },
    }, async ({ project_id, hostname, content }, extra) => {
        requireScope(extra, 'fleet:write', enforceScopes);
        return jsonResult({
            project_id,
            hostname,
            ...(await backend.writeTestFile(project_id, hostname, content)),
        });
    });

    return server;
}

async function handleMcpRequest(
    backend: FleetPluginBackend,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    const server = createFleetPluginMcpServer(backend);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
    } catch {
        if (!res.headersSent) {
            sendJson(res, 500, {
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            });
        }
    } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
    }
}

export function createFleetPluginHttpServer(
    backend: FleetPluginBackend,
    options: FleetPluginHttpOptions = {},
) {
    return createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');

        if (req.method === 'GET' && url.pathname === '/healthz') {
            sendJson(res, 200, { ok: true, service: 'network-fleet-plugin' });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/readyz') {
            sendJson(res, 200, { ok: true, service: 'network-fleet-plugin', ready: true });
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
            sendJson(res, 405, {
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Method not allowed.' },
                id: null,
            });
            return;
        }
        await handleMcpRequest(backend, req, res);
    });
}
