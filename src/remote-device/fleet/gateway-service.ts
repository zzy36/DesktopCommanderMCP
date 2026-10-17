import { MAX_FLEET_FRAME_BYTES } from './wire-limits.js';
import { LocalAdminSecurity } from './local-admin-security.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { JsonlAuditSink } from './audit-log.js';
import { createFleetAdminHttpServer, type RdcAction, type RdcStatus } from './admin-server.js';
import { FleetGateway, FleetGatewaySocket } from './fleet-gateway.js';
import { FleetGatewayPluginBackend } from './gateway-plugin-backend.js';
import { FleetEnrollmentStore } from './enrollment-store.js';
import { FileGenerationStore } from './gateway-state.js';
import { createFleetOAuthPluginHttpServer } from './oauth-plugin-server.js';
import { createFleetPluginHttpServer } from './plugin-server.js';
import { SingleUserOAuthProvider } from './single-user-oauth.js';
import { ResolvedGatewayServiceConfig } from './service-config.js';

export interface RunningFleetGatewayService {
    gateway: FleetGateway;
    mcpAddress(): ReturnType<Server['address']>;
    agentAddress(): ReturnType<Server['address']>;
    adminAddress(): ReturnType<Server['address']> | null;
    close(): Promise<void>;
}

export async function startFleetGatewayService(
    config: ResolvedGatewayServiceConfig,
    env: NodeJS.ProcessEnv = process.env,
): Promise<RunningFleetGatewayService> {
    await mkdir(config.stateDir, { recursive: true });
    const enrollmentStore = new FleetEnrollmentStore(path.join(config.stateDir, 'enrollment.json'));
    await enrollmentStore.initialize();
    const devices = mergeDeviceBindings(config.devices, enrollmentStore.listApprovedDevices());

    const gateway = new FleetGateway({
        devices,
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

    for (const hostname of enrollmentStore.listRevokedDevices()) gateway.revokeDeviceBinding(hostname);
    const mcpRuntime = createMcpServer(config, backend, env);
    if (mcpRuntime.oauthProvider) await mcpRuntime.oauthProvider.bindingStatus();
    const adminOrigin = config.adminOrigin ?? (config.mcpAuth.type === 'oauth' ? config.mcpAuth.approvalUrl.origin : undefined);
    if (config.adminListenPort !== undefined && !adminOrigin) throw new Error('admin.origin is required');
    const security = adminOrigin ? await LocalAdminSecurity.load(adminOrigin, path.join(config.stateDir, 'admin-key')) : undefined;
    const mcpServer = mcpRuntime.server;
    const agentServer = createAgentHttpServer(config);
    const bridgeWindowModePath = path.join(config.stateDir, 'bridge-window-modes.json');
    const bridgeWindowModes = await loadBridgeWindowModes(bridgeWindowModePath);
    const adminServer = config.adminListenPort !== undefined && config.adminListenHost && config.adminBasePath
        ? createFleetAdminHttpServer(gateway, {
            security: security!,
            release: env.LCM_RELEASE ?? 'development',
            basePath: config.adminBasePath,
            projects: config.projects,
            enrollmentStore,
            onApproveDevice: (device) => { gateway.addDeviceBinding(device); },
            onRevokeDevice: async (hostname) => {
                await enrollmentStore.revokeDevice(hostname);
                gateway.revokeDeviceBinding(hostname);
            },
            bridgeWindowModes,
            onSetBridgeWindowMode: async (hostname, mode) => {
                const status = gateway.machineDeviceStatus(hostname);
                if (!status.online) throw new Error(`target ${hostname} is offline`);
                await gateway.dispatchDevice(hostname, 'start_process', {
                    command: bridgeWindowModeCommand(mode),
                    shell: 'powershell.exe',
                    timeout_ms: 15000,
                    execution_context: 'system',
                }, 20000);
                bridgeWindowModes[hostname.toUpperCase()] = mode;
                await saveBridgeWindowModes(bridgeWindowModePath, bridgeWindowModes);
            },
            onGetRdcStatuses: async () => {
                const output: Record<string, RdcStatus> = {};
                await Promise.all(gateway.listKnownDeviceStatuses().map(async (device) => {
                    if (!device.online) {
                        output[device.hostname] = { hostname: device.hostname, state: 'Offline', error: 'LCM agent offline' };
                        return;
                    }
                    try {
                        output[device.hostname] = await controlRdc(gateway, device.hostname, 'status');
                    } catch (error) {
                        output[device.hostname] = { hostname: device.hostname, state: 'Unknown', error: error instanceof Error ? error.message : String(error) };
                    }
                }));
                return output;
            },
            onControlRdc: async (hostname, action) => controlRdc(gateway, hostname, action),
            oauthProvider: mcpRuntime.oauthProvider,
        })
        : null;
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FLEET_FRAME_BYTES });

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
        if (adminServer && config.adminListenPort !== undefined && config.adminListenHost) {
            await listen(adminServer, config.adminListenPort, config.adminListenHost);
        }
    } catch (error) {
        await closeServer(mcpServer).catch(() => undefined);
        await closeServer(agentServer).catch(() => undefined);
        if (adminServer) await closeServer(adminServer).catch(() => undefined);
        throw error;
    }

    let closed = false;
    return {
        gateway,
        mcpAddress: () => mcpServer.address(),
        agentAddress: () => agentServer.address(),
        adminAddress: () => adminServer?.address() ?? null,
        close: async () => {
            if (closed) return;
            closed = true;
            await gateway.stop().catch(() => undefined);
            for (const client of wss.clients) client.close(1001, 'gateway service stopped');
            await new Promise<void>((resolve) => wss.close(() => resolve()));
            await Promise.all([
                closeServer(mcpServer),
                closeServer(agentServer),
                adminServer ? closeServer(adminServer) : Promise.resolve(),
            ]);
        },
    };
}

function createMcpServer(
    config: ResolvedGatewayServiceConfig,
    backend: FleetGatewayPluginBackend,
    env: NodeJS.ProcessEnv,
): { server: Server; oauthProvider?: SingleUserOAuthProvider } {
    if (config.mcpAuth.type === 'bearer') {
        const bearerToken = env[config.mcpAuth.tokenEnv];
        if (!bearerToken) {
            throw new Error(`missing MCP bearer token in environment variable ${config.mcpAuth.tokenEnv}`);
        }
        return { server: createFleetPluginHttpServer(backend, { bearerToken }) };
    }

    const provider = new SingleUserOAuthProvider({
        statePath: path.join(config.stateDir, 'oauth-state.json'),
        issuerUrl: config.mcpAuth.issuerUrl,
        resourceUrl: config.mcpAuth.resourceUrl,
    });
    return { server: createFleetOAuthPluginHttpServer({
        backend,
        provider,
        issuerUrl: config.mcpAuth.issuerUrl,
        resourceUrl: config.mcpAuth.resourceUrl,
        approvalUrl: config.mcpAuth.approvalUrl,
    }), oauthProvider: provider };
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

function mergeDeviceBindings(
    configured: Array<{ hostname: string; publicKeyFingerprint: string }>,
    enrolled: Array<{ hostname: string; publicKeyFingerprint: string }>,
): Array<{ hostname: string; publicKeyFingerprint: string }> {
    const merged = new Map(configured.map((device) => [device.hostname, { ...device }]));
    for (const device of enrolled) {
        const existing = merged.get(device.hostname);
        if (existing && existing.publicKeyFingerprint !== device.publicKeyFingerprint) {
            throw new Error(`enrolled device ${device.hostname} conflicts with configured identity`);
        }
        if (!existing) merged.set(device.hostname, { ...device });
    }
    return [...merged.values()];
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


async function loadBridgeWindowModes(filePath: string): Promise<Record<string, 'hidden' | 'visible'>> {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
        const result: Record<string, 'hidden' | 'visible'> = {};
        for (const [hostname, value] of Object.entries(parsed)) {
            if (value === 'hidden' || value === 'visible') result[hostname.toUpperCase()] = value;
        }
        return result;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
    }
}

async function saveBridgeWindowModes(filePath: string, modes: Record<string, 'hidden' | 'visible'>): Promise<void> {
    const temp = `${filePath}.tmp-${process.pid}`;
    await writeFile(temp, JSON.stringify(modes, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temp, filePath);
}

async function controlRdc(gateway: FleetGateway, hostname: string, action: RdcAction): Promise<RdcStatus> {
    const status = gateway.machineDeviceStatus(hostname);
    if (!status.online) throw new Error(`target ${hostname} is offline`);
    const result = await gateway.dispatchDevice(hostname, 'start_process', {
        command: rdcControlCommand(action),
        shell: 'powershell.exe',
        timeout_ms: 15000,
        execution_context: 'system',
    }, 20000);
    return extractRdcStatus(result, hostname);
}

export function rdcControlCommand(action: RdcAction): string {
    return "$ErrorActionPreference='Stop'; $script=Join-Path $env:ProgramData 'LocalControlMCP-RDC\\Control-RDC.ps1'; if(-not(Test-Path -LiteralPath $script)){throw 'RDC supervisor not installed'}; & 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script -ExpectedHostname $env:COMPUTERNAME -Action " + action + "; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}";
}

export function extractRdcStatus(value: unknown, hostname: string): RdcStatus {
    const texts: string[] = [];
    const visit = (item: unknown): void => {
        if (typeof item === 'string') { texts.push(item); return; }
        if (Array.isArray(item)) { for (const child of item) visit(child); return; }
        if (item && typeof item === 'object') for (const child of Object.values(item as Record<string, unknown>)) visit(child);
    };
    visit(value);
    for (const text of texts.reverse()) {
        for (const line of text.split(/\r?\n/).reverse()) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
            try {
                const parsed = JSON.parse(trimmed) as RdcStatus;
                if (parsed && typeof parsed === 'object' && String(parsed.hostname ?? '').toUpperCase() === hostname.toUpperCase()) return parsed;
            } catch { /* keep scanning wrapped tool output */ }
        }
    }
    throw new Error(`RDC status payload missing for ${hostname}`);
}

function bridgeWindowModeCommand(mode: 'hidden' | 'visible'): string {
    return "$ErrorActionPreference='Stop'; $runtime=(Get-Content -LiteralPath (Join-Path $env:ProgramData 'LocalControlMCP\\runtime.json') -Raw | ConvertFrom-Json).runtimeRoot; $script=Join-Path $runtime 'deploy\\windows\\Set-LCMBridgeWindowMode.ps1'; & pwsh.exe -NoProfile -ExecutionPolicy Bypass -File $script -ExpectedHostname $env:COMPUTERNAME -Mode " + mode + "; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}";
}
