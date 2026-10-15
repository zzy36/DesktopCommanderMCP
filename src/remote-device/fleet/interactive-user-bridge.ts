import { StringDecoder } from 'node:string_decoder';
import { createHmac, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer, createConnection, Socket } from 'node:net';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopCommanderIntegration } from '../desktop-commander-integration.js';
import { ControlPolicyAuthorizer, ControlProjectAuthorization } from './control-policy.js';
import { canonicalHostname } from './identity.js';
import { ProjectResourceScope, scopeProjectToolArgs, validateProjectToolPaths } from './project-tool-contract.js';

const MAX_REQUEST = 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
const MAX_AGE = 120_000;
const error = (message: string, code = 'INTERACTIVE_SESSION_UNAVAILABLE') => Object.assign(new Error(message), { code });
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');
function authentic(secret: string, body: string, signature: unknown): boolean {
    const actual = Buffer.from(typeof signature === 'string' ? signature : '', 'hex');
    const expected = Buffer.from(sign(secret, body), 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
interface Manifest { schemaVersion: 1; pipe: string; secret: string; hostname: string; pid: number; updatedAt: number; username: string; sessionId: number; }
interface Request { id: string; timestamp: number; projectId: string; hostname: string; toolName: string; args: Record<string, unknown>; }
interface Engine {
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    callClientTool(name: string, args: Record<string, unknown>, meta?: any, options?: any): Promise<any>;
}
interface Authorizer { warmup(): Promise<void>; authorize(projectId: string, hostname: string): Promise<ControlProjectAuthorization>; stop(): Promise<void>; }
export interface InteractiveUserBridgeOptions {
    controlRoot: string; stateDir: string;
    desktop?: Engine; authorizer?: Authorizer;
    // Unix socket override is only for the cross-platform test fixture. Windows always uses a named pipe.
    testSocket?: string;
}

export async function startInteractiveUserBridge(options: InteractiveUserBridgeOptions) {
    const hostname = canonicalHostname(os.hostname());
    let sessionId = 1;
    if (process.platform === 'win32') {
        const result = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { windowsHide: true });
        sessionId = Number(result.stdout.trim());
        if (!Number.isInteger(sessionId) || sessionId <= 0 || os.userInfo().username.toLowerCase() === 'system') throw error('bridge requires a logged-in interactive user');
        if (options.testSocket) throw error('Windows bridge only permits a local named pipe');
    }
    const pipe = options.testSocket ?? `\\\\.\\pipe\\lcm-user-${hostname}-${randomBytes(16).toString('hex')}`;
    if (process.platform !== 'win32' && !options.testSocket) throw error('interactive user bridge is Windows-only');
    const desktop = options.desktop ?? new DesktopCommanderIntegration();
    const authorizer = options.authorizer ?? new ControlPolicyAuthorizer({ controlRoot: options.controlRoot });
    await authorizer.warmup();
    try { await desktop.initialize(); } catch (cause) { await authorizer.stop(); throw cause; }
    const manifest: Manifest = { schemaVersion: 1, pipe, secret: randomBytes(32).toString('base64url'), hostname, pid: process.pid, updatedAt: Date.now(), username: os.userInfo().username, sessionId };
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(options.stateDir, 'bridge.json');
    const publish = async () => {
        manifest.updatedAt = Date.now(); const temp = manifestPath + '.tmp-' + process.pid;
        await writeFile(temp, JSON.stringify(manifest), { mode: 0o600 }); await rename(temp, manifestPath);
    };
    const resources = new ProjectResourceScope();
    const used = new Map<string, number>();
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
        sockets.add(socket); const controller = new AbortController();
        socket.on('close', () => { sockets.delete(socket); controller.abort(); });
        socket.on('error', () => undefined);
        socket.setTimeout(60_000, () => socket.destroy());
        let bytes = 0; let chunks = ''; let received = false; const decoder = new StringDecoder('utf8');
        socket.on('data', chunk => {
            if (received) return socket.destroy();
            bytes += chunk.length; if (bytes > MAX_REQUEST) return socket.destroy();
            chunks += decoder.write(chunk); const newline = chunks.indexOf('\n'); if (newline < 0) return;
            received = true;
            void (async () => {
                let requestId = '';
                let response: Record<string, unknown>;
                try {
                    const envelope = JSON.parse(chunks.slice(0, newline));
                    if (typeof envelope.body !== 'string' || !authentic(manifest.secret, envelope.body, envelope.signature)) throw error('invalid interactive request authentication', 'PROJECT_DEVICE_DENIED');
                    const request = JSON.parse(envelope.body) as Request;
                    requestId = request.id;
                    if (!/^[0-9a-f-]{36}$/.test(request.id) || !Number.isFinite(request.timestamp) || Math.abs(Date.now() - request.timestamp) > 30_000) throw error('expired interactive request', 'PROJECT_DEVICE_DENIED');
                    for (const [id, time] of used) if (time < Date.now() - 60_000) used.delete(id);
                    if (used.has(request.id) || used.size >= 1000) throw error('interactive request replay denied', 'PROJECT_DEVICE_DENIED');
                    used.set(request.id, Date.now());
                    if (canonicalHostname(request.hostname) !== hostname) throw error('interactive target does not match this device', 'PROJECT_DEVICE_DENIED');
                    const authorization = await authorizer.authorize(request.projectId, hostname);
                    resources.assertOwned(request.toolName, request.projectId, request.args);
                    const args = await scopeProjectToolArgs(request.toolName, request.args, authorization);
                    await validateProjectToolPaths(request.toolName, args, authorization);
                    const result = await desktop.callClientTool(request.toolName, args, { project_id: request.projectId, local_control_mcp: true, fleet_hostname: hostname, execution_context: 'interactive' }, { signal: controller.signal, timeout: 30_000, maxTotalTimeout: 30_000 });
                    resources.record(request.toolName, request.projectId, result, args);
                    response = { id: requestId, ok: true, result: resources.transform(request.toolName, request.projectId, authorization, result, hostname), executionContext: 'interactive' };
                } catch (cause) {
                    response = { id: requestId, ok: false, error: cause instanceof Error ? cause.message : 'interactive execution failed', code: (cause as { code?: string })?.code ?? 'INTERACTIVE_EXECUTION_FAILED' };
                }
                const body = JSON.stringify(response);
                if (Buffer.byteLength(body) > MAX_RESPONSE) throw error('interactive result exceeds size limit');
                socket.end(JSON.stringify({ body, signature: sign(manifest.secret, body) }) + '\n');
            })().catch(() => socket.destroy());
        });
    });
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); }); await publish(); }
    catch (cause) { server.close(); await desktop.shutdown(); await authorizer.stop(); throw cause; }
    let publishing = false;
    const heartbeat = setInterval(() => { if (!publishing) { publishing = true; void publish().catch(() => undefined).finally(() => { publishing = false; }); } }, 30_000);
    let closed = false;
    return { hostname, username: manifest.username, sessionId, manifestPath,
        close: async () => {
            if (closed) return; closed = true; clearInterval(heartbeat);
            for (const socket of sockets) socket.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
            await desktop.shutdown(); await authorizer.stop();
            try { const current = JSON.parse(await readFile(manifestPath, 'utf8')); if (current.pipe === pipe) await rm(manifestPath); } catch { /* no active manifest */ }
        },
    };
}

export class InteractiveUserClient {
    constructor(private readonly stateDir: string) {}
    async callTool(toolName: string, args: Record<string, unknown>, projectId: string, hostname: string, signal?: AbortSignal): Promise<any> {
        let manifest: Manifest;
        try { manifest = JSON.parse(await readFile(path.join(this.stateDir, 'bridge.json'), 'utf8')); }
        catch { throw error('no interactive user session is available'); }
        const expected = canonicalHostname(hostname);
        if (manifest.schemaVersion !== 1 || manifest.hostname !== expected || expected !== canonicalHostname(os.hostname()) || Date.now() - manifest.updatedAt > MAX_AGE || manifest.updatedAt > Date.now() + 30_000 || manifest.secret?.length !== 43 || manifest.sessionId <= 0) throw error('interactive user session metadata is unavailable or invalid');
        if (process.platform === 'win32' && !manifest.pipe.startsWith(`\\\\.\\pipe\\lcm-user-${expected}-`)) throw error('interactive transport must be a local named pipe');
        const request: Request = { id: randomUUID(), timestamp: Date.now(), projectId, hostname: expected, toolName, args };
        const body = JSON.stringify(request); const frame = JSON.stringify({ body, signature: sign(manifest.secret, body) }) + '\n';
        if (Buffer.byteLength(frame) > MAX_REQUEST) throw error('interactive request exceeds size limit');
        return new Promise((resolve, reject) => {
            const socket = createConnection(manifest.pipe);
            let bytes = 0; let chunks = ''; let finished = false; const decoder = new StringDecoder('utf8');
            const finish = (cause?: Error, value?: unknown) => { if (finished) return; finished = true; signal?.removeEventListener('abort', abort); socket.destroy(); if (cause) reject(cause); else resolve(value); };
            const abort = () => finish(error('interactive call cancelled'));
            if (signal?.aborted) return abort(); signal?.addEventListener('abort', abort, { once: true });
            socket.setTimeout(45_000, () => finish(error('interactive execution timed out')));
            socket.on('error', () => finish(error('interactive user transport unavailable')));
            socket.on('close', () => { if (!finished) finish(error('interactive user session disconnected')); });
            socket.on('connect', () => socket.write(frame));
            socket.on('data', chunk => {
                bytes += chunk.length; if (bytes > MAX_RESPONSE * 2 + 4096) return finish(error('interactive response exceeds size limit'));
                chunks += decoder.write(chunk); const newline = chunks.indexOf('\n'); if (newline < 0) return;
                try {
                    const envelope = JSON.parse(chunks.slice(0, newline));
                    if (typeof envelope.body !== 'string' || !authentic(manifest.secret, envelope.body, envelope.signature)) throw error('interactive response authentication failed', 'PROJECT_DEVICE_DENIED');
                    const response = JSON.parse(envelope.body);
                    if (response.id !== request.id) throw error('interactive response belongs to another request', 'PROJECT_DEVICE_DENIED');
                    if (!response.ok) throw error(response.error, response.code);
                    finish(undefined, response.result);
                } catch (cause) { finish(cause instanceof Error ? cause : error('invalid interactive response')); }
            });
        });
    }
}
