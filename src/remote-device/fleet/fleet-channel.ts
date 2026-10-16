import { sign } from 'node:crypto';
import { canonicalHostname, handshakePayload } from './identity.js';
import { MAX_FLEET_FRAME_BYTES } from './wire-limits.js';

export type FleetScopeKind = 'project' | 'machine_control';

export interface FleetChannelExecutorContext {
    scopeKind: FleetScopeKind;
    projectId: string | null;
    machineApproval: boolean;
    hostname: string;
    callId: string;
    generation: number;
    signal: AbortSignal;
}

export type FleetChannelExecutor = (
    toolName: string,
    args: Record<string, unknown>,
    context: FleetChannelExecutorContext,
) => Promise<unknown>;

export interface FleetChannelOptions {
    url: string;
    hostname: string;
    policyRevision: string;
    agentVersion?: string;
    publicKeyPem: string;
    privateKey: Parameters<typeof sign>[2];
    authorize: (projectId: string, hostname: string) => boolean | Promise<boolean>;
    authorizeMachine?: (hostname: string, explicitAuthorization: boolean) => boolean | Promise<boolean>;
    execute: FleetChannelExecutor;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    heartbeatMs?: number;
    heartbeatTimeoutMs?: number;
    callTimeoutMs?: number;
    maxInFlight?: number;
    completedResultCacheSize?: number;
    random?: () => number;
    socketFactory?: (url: string) => WebSocket;
}

export interface FleetChannelState {
    started: boolean;
    connected: boolean;
    authenticated: boolean;
    hostname: string;
    sessionId: string | null;
    generation: number | null;
    inFlight: number;
    reconnectAttempt: number;
}

type FleetWireMessage = Record<string, unknown> & { type?: unknown };

type PendingCall = {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    generation: number;
};

const WS_OPEN = 1;

export class FleetChannel {
    private readonly hostname: string;
    private readonly options: Required<Pick<
        FleetChannelOptions,
        | 'reconnectBaseMs'
        | 'reconnectMaxMs'
        | 'heartbeatMs'
        | 'heartbeatTimeoutMs'
        | 'callTimeoutMs'
        | 'maxInFlight'
        | 'completedResultCacheSize'
    >> & FleetChannelOptions;

    private socket: WebSocket | null = null;
    private started = false;
    private authenticated = false;
    private sessionId: string | null = null;
    private generation: number | null = null;
    private highestAcceptedGeneration = 0;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private connectDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private lastGatewaySeenAt = 0;
    private readonly pendingCalls = new Map<string, PendingCall>();
    private readonly completedResults = new Map<string, FleetWireMessage>();

    constructor(options: FleetChannelOptions) {
        this.hostname = canonicalHostname(options.hostname);
        this.options = {
            ...options,
            reconnectBaseMs: options.reconnectBaseMs ?? 500,
            reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
            heartbeatMs: options.heartbeatMs ?? 10_000,
            heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 35_000,
            callTimeoutMs: options.callTimeoutMs ?? 30_000,
            maxInFlight: options.maxInFlight ?? 16,
            completedResultCacheSize: options.completedResultCacheSize ?? 256,
        };
    }

    getState(): FleetChannelState {
        return {
            started: this.started,
            connected: this.socket?.readyState === WS_OPEN,
            authenticated: this.authenticated,
            hostname: this.hostname,
            sessionId: this.sessionId,
            generation: this.generation,
            inFlight: this.pendingCalls.size,
            reconnectAttempt: this.reconnectAttempt,
        };
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.connect();
    }

    async stop(): Promise<void> {
        if (!this.started && !this.socket) return;
        this.started = false;
        this.authenticated = false;
        this.clearReconnectTimer();
        this.clearConnectDeadline();
        this.stopHeartbeat();
        for (const pending of this.pendingCalls.values()) {
            clearTimeout(pending.timer);
            pending.controller.abort(new Error('fleet channel stopped'));
        }
        this.pendingCalls.clear();
        const socket = this.socket;
        this.socket = null;
        this.sessionId = null;
        this.generation = null;
        if (socket && socket.readyState < 2) {
            socket.close(1000, 'fleet channel stopped');
        }
    }

    private connect(): void {
        if (!this.started || this.socket) return;
        const socketFactory = this.options.socketFactory ?? ((url: string) => new WebSocket(url));
        let socket: WebSocket;
        try {
            socket = socketFactory(this.options.url);
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        this.authenticated = false;
        this.sessionId = null;
        this.generation = null;
        this.lastGatewaySeenAt = Date.now();
        this.startConnectDeadline(socket);

        socket.addEventListener('message', (event) => {
            this.lastGatewaySeenAt = Date.now();
            void this.handleMessage(event.data).catch(() => {
                socket.close(4002, 'invalid fleet message');
            });
        });

        socket.addEventListener('close', () => {
            this.dropSocket(socket);
        });

        socket.addEventListener('error', () => {
            this.dropSocket(socket, 4007, 'fleet socket error');
        });
    }

    private async handleMessage(data: unknown): Promise<void> {
        const message = this.parseMessage(data);
        switch (message.type) {
            case 'challenge':
                this.handleChallenge(message);
                return;
            case 'accepted':
                this.handleAccepted(message);
                return;
            case 'heartbeat_ack':
                return;
            case 'call':
                await this.handleCall(message);
                return;
            case 'cancel':
                this.handleCancel(message);
                return;
            case 'rejected':
                this.socket?.close(4003, String(message.code ?? 'rejected'));
                return;
            case 'fenced':
                this.socket?.close(4009, String(message.reason ?? 'fenced session'));
                return;
            default:
                throw new Error(`unsupported fleet message type: ${String(message.type)}`);
        }
    }

    private handleChallenge(message: FleetWireMessage): void {
        const challenge = typeof message.challenge === 'string' ? message.challenge : null;
        if (!challenge) throw new Error('missing challenge');
        const payload = handshakePayload(challenge, this.hostname, this.options.policyRevision);
        const signature = sign(null, payload, this.options.privateKey).toString('base64');
        this.send({
            type: 'hello',
            hostname: this.hostname,
            policyRevision: this.options.policyRevision,
            publicKeyPem: this.options.publicKeyPem,
            agentVersion: this.options.agentVersion,
            signature,
        });
    }

    private handleAccepted(message: FleetWireMessage): void {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
        const generation = typeof message.generation === 'number' && Number.isInteger(message.generation)
            ? message.generation
            : null;
        if (!sessionId || generation === null || generation <= 0) {
            throw new Error('accepted message missing session fencing data');
        }
        if (generation <= this.highestAcceptedGeneration) {
            this.socket?.close(4009, 'stale session generation');
            return;
        }
        this.highestAcceptedGeneration = generation;
        this.sessionId = sessionId;
        this.generation = generation;
        this.authenticated = true;
        this.clearConnectDeadline();
        this.reconnectAttempt = 0;
        this.lastGatewaySeenAt = Date.now();
        this.startHeartbeat();
    }

    private async handleCall(message: FleetWireMessage): Promise<void> {
        const callId = typeof message.callId === 'string' ? message.callId : null;
        const scopeKind: FleetScopeKind = message.scopeKind === 'machine_control' ? 'machine_control' : 'project';
        const projectId = typeof message.projectId === 'string' && message.projectId.trim() ? message.projectId : null;
        const machineApproval = message.machineApproval === true;
        const hostname = typeof message.hostname === 'string' ? canonicalHostname(message.hostname) : null;
        const toolName = typeof message.toolName === 'string' ? message.toolName : null;
        const generation = typeof message.generation === 'number' ? message.generation : null;
        const args = this.isRecord(message.args) ? message.args : {};
        if (!callId || !hostname || !toolName || generation === null || (scopeKind === 'project' && !projectId)) {
            throw new Error('invalid call message');
        }

        const cached = this.completedResults.get(callId);
        if (cached) {
            this.send(cached);
            return;
        }
        if (!this.authenticated || this.generation === null || generation !== this.generation) {
            this.sendResult({ callId, generation, ok: false, code: 'FENCED_SESSION' });
            return;
        }
        if (hostname !== this.hostname) {
            this.sendResult({ callId, generation, ok: false, code: 'PROJECT_DEVICE_DENIED' });
            return;
        }
        try {
            if (scopeKind === 'machine_control') {
                if (!machineApproval || !this.options.authorizeMachine || !(await this.options.authorizeMachine(hostname, machineApproval))) {
                    this.sendResult({ callId, generation, ok: false, code: 'PROJECT_DEVICE_DENIED' });
                    return;
                }
            } else if (!(await this.options.authorize(projectId!, hostname))) {
                this.sendResult({ callId, generation, ok: false, code: 'PROJECT_DEVICE_DENIED' });
                return;
            }
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error
                ? String((error as { code?: unknown }).code ?? 'PROJECT_DEVICE_DENIED')
                : 'PROJECT_DEVICE_DENIED';
            this.sendResult({
                callId,
                generation,
                ok: false,
                code,
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        if (this.pendingCalls.has(callId)) {
            this.sendResult({ callId, generation, ok: false, code: 'DUPLICATE_CALL' });
            return;
        }
        if (this.pendingCalls.size >= this.options.maxInFlight) {
            this.sendResult({ callId, generation, ok: false, code: 'AGENT_BUSY' });
            return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort(new Error('fleet call timeout'));
        }, this.options.callTimeoutMs);
        this.pendingCalls.set(callId, { controller, timer, generation });

        let resultMessage: FleetWireMessage;
        try {
            const result = await Promise.race([
                this.options.execute(toolName, args, {
                    scopeKind,
                    projectId,
                    machineApproval,
                    hostname,
                    callId,
                    generation,
                    signal: controller.signal,
                }),
                this.abortPromise(controller.signal),
            ]);
            resultMessage = { type: 'result', callId, generation, ok: true, result };
        } catch (error) {
            const aborted = controller.signal.aborted;
            const propagated = error && typeof error === 'object' && 'code' in error
                ? String((error as { code?: unknown }).code ?? '')
                : '';
            const code = aborted
                ? 'CALL_CANCELED_OR_TIMED_OUT'
                : propagated === 'PROJECT_DEVICE_DENIED' || propagated === 'POLICY_SKEW'
                    ? propagated
                    : 'LOCAL_EXECUTION_FAILED';
            resultMessage = {
                type: 'result',
                callId,
                generation,
                ok: false,
                code,
                error: error instanceof Error ? error.message : String(error),
            };
        } finally {
            clearTimeout(timer);
            this.pendingCalls.delete(callId);
        }

        resultMessage = this.boundResult(resultMessage);
        this.cacheCompletedResult(callId, resultMessage);
        if (this.authenticated && this.generation === generation) this.send(resultMessage);
    }

    private handleCancel(message: FleetWireMessage): void {
        const callId = typeof message.callId === 'string' ? message.callId : null;
        const generation = typeof message.generation === 'number' ? message.generation : null;
        if (!callId || generation === null || generation !== this.generation) return;
        const pending = this.pendingCalls.get(callId);
        pending?.controller.abort(new Error('fleet call canceled by gateway'));
    }

    private sendResult(input: {
        callId: string;
        generation: number;
        ok: boolean;
        code?: string;
        result?: unknown;
        error?: string;
    }): void {
        const message = this.boundResult({ type: 'result', ...input });
        this.cacheCompletedResult(input.callId, message);
        this.send(message);
    }

    private boundResult(message: FleetWireMessage): FleetWireMessage {
        if (Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_FLEET_FRAME_BYTES) return message;
        return { type: 'result', callId: message.callId, generation: message.generation,
            ok: false, code: 'RESULT_TOO_LARGE',
            error: `Result exceeds ${MAX_FLEET_FRAME_BYTES} byte Fleet frame limit; read a bounded range or smaller output. The operation may already have executed; do not replay mutations.` };
    }

    private cacheCompletedResult(callId: string, message: FleetWireMessage): void {
        this.completedResults.set(callId, message);
        while (this.completedResults.size > this.options.completedResultCacheSize) {
            const oldest = this.completedResults.keys().next().value as string | undefined;
            if (!oldest) break;
            this.completedResults.delete(oldest);
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.authenticated || this.generation === null) return;
            const now = Date.now();
            if (now - this.lastGatewaySeenAt > this.options.heartbeatTimeoutMs) {
                const socket = this.socket;
                if (socket) this.dropSocket(socket, 4008, 'gateway heartbeat timeout');
                return;
            }
            this.send({ type: 'heartbeat', generation: this.generation, now });
        }, this.options.heartbeatMs);
    }

    private startConnectDeadline(socket: WebSocket): void {
        this.clearConnectDeadline();
        this.connectDeadlineTimer = setTimeout(() => {
            this.connectDeadlineTimer = null;
            if (this.socket !== socket || this.authenticated) return;
            this.dropSocket(socket, 4008, 'fleet authentication timeout');
        }, this.options.heartbeatTimeoutMs);
    }

    private clearConnectDeadline(): void {
        if (this.connectDeadlineTimer) clearTimeout(this.connectDeadlineTimer);
        this.connectDeadlineTimer = null;
    }

    private dropSocket(socket: WebSocket, code?: number, reason?: string): void {
        if (this.socket !== socket) return;
        this.socket = null;
        this.authenticated = false;
        this.sessionId = null;
        this.generation = null;
        this.clearConnectDeadline();
        this.stopHeartbeat();
        this.cancelPendingForDisconnect();
        if (socket.readyState < 2 && code !== undefined) {
            try {
                socket.close(code, reason);
            } catch {
                // The reconnect timer below is authoritative even if close() itself fails.
            }
        }
        this.scheduleReconnect();
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private cancelPendingForDisconnect(): void {
        for (const pending of this.pendingCalls.values()) {
            clearTimeout(pending.timer);
            pending.controller.abort(new Error('fleet gateway disconnected'));
        }
        this.pendingCalls.clear();
    }

    private scheduleReconnect(): void {
        if (!this.started || this.reconnectTimer) return;
        this.reconnectAttempt += 1;
        const exponential = Math.min(
            this.options.reconnectMaxMs,
            this.options.reconnectBaseMs * 2 ** Math.max(0, this.reconnectAttempt - 1),
        );
        const random = this.options.random ?? Math.random;
        const jittered = Math.max(1, Math.round(exponential * (0.5 + random())));
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, jittered);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private send(message: FleetWireMessage): void {
        if (!this.socket || this.socket.readyState !== WS_OPEN) return;
        this.socket.send(JSON.stringify(message));
    }

    private parseMessage(data: unknown): FleetWireMessage {
        let text: string;
        if (typeof data === 'string') text = data;
        else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
        else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
        else text = String(data);
        const parsed = JSON.parse(text);
        if (!this.isRecord(parsed)) throw new Error('fleet message must be an object');
        return parsed;
    }

    private abortPromise(signal: AbortSignal): Promise<never> {
        return new Promise((_, reject) => {
            if (signal.aborted) {
                reject(signal.reason ?? new Error('aborted'));
                return;
            }
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
        });
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
}
