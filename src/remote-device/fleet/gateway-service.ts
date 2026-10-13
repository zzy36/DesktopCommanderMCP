import { mkdir } from 'node:fs/promises';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { JsonlAuditSink } from './audit-log.js';
import { FleetGateway, FleetGatewaySocket } from './fleet-gateway.js';
import { FleetGatewayPluginBackend } from './gateway-plugin-backend.js';
import { FileGenerationStore } from './gateway-state.js';
import { createFleetOAuthPluginHttpServer } from './oauth-plugin-server.js';
import { createFleetPluginHttpServer } from './plugin-server.js';
import { verifyOwnerPasswordHash, SingleUserOAuthProvider } from './single-user-oauth.js';
import { ResolvedGatewayServiceConfig } from './service-config.js';

export interface RunningFleetGatewayService {
    gateway: FleetGateway;
    mcpAddress(): ReturnType<Server['address']>;
    agentAddress(): ReturnType<Server['address']>;
    close(): Promise<void>;
}

export async function startFleetGatewayService(
    config: ResolvedGatewayServiceConfig,
    env: NodeJS.ProcessEnv = process.env,
): Promise<RunningFleetGatewayService> {
    await mkdir(config.stateDir, { recursive: true });

    const gateway = new FleetGateway({
        devices: config.devices,
        projects: config.projects,
        generationStore: new FileGenerationStore(path.join(config.stateDir, 'generations.json')),
        audit: new JsonlAuditSink(path.join(config.stateDir, 'audit.jsonl')),
        callTimeoutMs: config.callTimeoutMs,
        maxPendingCalls: config.maxPendingCalls,
        callRecordLimit: config.callRecordLimit,
        heartbeatTimeoutMs: config.heartbeatTimeoutMs,
        heartbeatSweepMs: config.heartbeatSweepMs,
    });

    const backend = new FleetGatewayPluginBackend({
        gateway,
        probes: config.probes,
        callTimeoutMs: config.callTimeoutMs,
    });

    const mcpServer = createMcpServer(config, backend, env);
    const agentServer = createAgentHttpServer(config);
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

    wss.on('connection', (socket) => {
        try {
            gateway.acceptSocket(adaptWebSocket(socket));
        } catch {
            socket.close(1013, 'gateway unavailable');
        }
    });

    agentServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        let pathname = '';
        try {
            pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        } catch {
            socket.destroy();
            return;
        }
        if (pathname !== config.agentPath) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    await listen(mcpServer, config.mcpListenPort, config.mcpListenHost);
    try {
        await listen(agentServer, config.agentListenPort, config.agentListenHost);
    } catch (error) {
        await closeServer(mcpServer).catch(() => undefined);
        throw error;
    }

    let closed = false;
    return {
        gateway,
        mcpAddress: () => mcpServer.address(),
        agentAddress: () => agentServer.address(),
        close: async () => {
            if (closed) return;
            closed = true;
            await gateway.stop().catch(() => undefined);
            for (const client of wss.clients) client.close(1001, 'gateway service stopped');
            await new Promise<void>((resolve) => wss.close(() => resolve()));
            await Promise.all([
                closeServer(mcpServer),
                closeServer(agentServer),
            ]);
        },
    };
}

function createMcpServer(
    config: ResolvedGatewayServiceConfig,
    backend: FleetGatewayPluginBackend,
    env: NodeJS.ProcessEnv,
): Server {
    if (config.mcpAuth.type === 'bearer') {
        const bearerToken = env[config.mcpAuth.tokenEnv];
        if (!bearerToken) {
            throw new Error(`missing MCP bearer token in environment variable ${config.mcpAuth.tokenEnv}`);
        }
        return createFleetPluginHttpServer(backend, { bearerToken });
    }

    const ownerPasswordHash = env[config.mcpAuth.ownerPasswordHashEnv];
    if (!ownerPasswordHash) {
        throw new Error(`missing OAuth owner password hash in environment variable ${config.mcpAuth.ownerPasswordHashEnv}`);
    }
    const provider = new SingleUserOAuthProvider({
        statePath: path.join(config.stateDir, 'oauth-state.json'),
        issuerUrl: config.mcpAuth.issuerUrl,
        resourceUrl: config.mcpAuth.resourceUrl,
        verifyOwnerPassword: (password) => verifyOwnerPasswordHash(ownerPasswordHash, password),
    });
    return createFleetOAuthPluginHttpServer({
        backend,
        provider,
        issuerUrl: config.mcpAuth.issuerUrl,
        resourceUrl: config.mcpAuth.resourceUrl,
    });
}

function createAgentHttpServer(config: ResolvedGatewayServiceConfig): Server {
    return createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/healthz') {
            sendJson(res, 200, { ok: true, service: 'network-fleet-agent-ingress' });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/readyz') {
            sendJson(res, 200, { ok: true, service: 'network-fleet-agent-ingress', ready: true });
            return;
        }
        sendJson(res, 404, { error: 'not found' });
    });
}

async function listen(server: Server, port: number, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', Buffer.byteLength(body));
    res.end(body);
}

function adaptWebSocket(socket: WebSocket): FleetGatewaySocket {
    return {
        get readyState() {
            return socket.readyState;
        },
        send(data: string) {
            socket.send(data);
        },
        close(code?: number, reason?: string) {
            socket.close(code, reason);
        },
        onMessage(handler) {
            socket.on('message', (data) => handler(data));
        },
        onClose(handler) {
            socket.on('close', (code, reason) => handler(code, reason.toString()));
        },
        onError(handler) {
            socket.on('error', handler);
        },
    };
}
