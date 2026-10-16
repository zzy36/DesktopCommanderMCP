import { randomBytes, randomUUID } from 'node:crypto';
import { FleetAuditSink, NullAuditSink } from './audit-log.js';
import { FleetGenerationStore, MemoryGenerationStore } from './gateway-state.js';
import {
    canonicalHostname,
    fingerprintPublicKey,
    handshakePayload,
    verifyChallengeSignature,
} from './identity.js';
import { AgentDescriptor, DeviceBinding, FleetRoutingError, ProjectBinding } from './protocol.js';
import { FleetRouter } from './router.js';

export interface FleetGatewaySocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onMessage(handler: (data: unknown) => void): void;
    onClose(handler: (code?: number, reason?: string) => void): void;
    onError?(handler: (error: Error) => void): void;
}

export interface FleetGatewayOptions {
    devices: DeviceBinding[];
    projects?: ProjectBinding[];
    generationStore?: FleetGenerationStore;
    audit?: FleetAuditSink;
    callTimeoutMs?: number;
    maxPendingCalls?: number;
    callRecordLimit?: number;
    heartbeatTimeoutMs?: number;
    heartbeatSweepMs?: number;
}

export interface FleetGatewayDeviceStatus {
    hostname: string;
    online: boolean;
    sessionId: string | null;
    generation: number | null;
    policyRevision: string | null;
    agentVersion: string | null;
    connectedAtMs: number | null;
    lastSeenAtMs: number | null;
}

export type FleetGatewayCallStatus = 'pending' | 'completed' | 'failed' | 'timeout' | 'canceled';

export interface FleetGatewayCallRecord {
    callId: string;
    scopeKind: 'project' | 'machine_control' | 'device';
    projectId: string | null;
    hostname: string;
    toolName: string;
    sessionId: string;
    generation: number;
    status: FleetGatewayCallStatus;
    createdAtMs: number;
    completedAtMs: number | null;
    code: string | null;
    error: string | null;
    result?: unknown;
}

type GatewayWireMessage = Record<string, unknown> & { type?: unknown };

type GatewaySession = {
    socket: FleetGatewaySocket;
    sessionId: string;
    challenge: string;
    authenticated: boolean;
    hostname: string | null;
    generation: number | null;
    policyRevision: string | null;
    agentVersion: string | null;
    publicKeyFingerprint: string | null;
    connectedAtMs: number;
    lastSeenAtMs: number;
};

type PendingCall = {
    callId: string;
    sessionId: string;
    generation: number;
    scopeKind: 'project' | 'machine_control' | 'device';
    projectId: string | null;
    hostname: string;
    toolName: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    createdAtMs: number;
};

const SOCKET_OPEN = 1;

export class FleetGatewayError extends Error {
    readonly code: string;
    readonly details: Readonly<Record<string, unknown>>;

    constructor(code: string, message: string, details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'FleetGatewayError';
        this.code = code;
        this.details = Object.freeze({ ...details });
    }
}

export class FleetGateway {
    private readonly router: FleetRouter;
    private readonly devices = new Map<string, DeviceBinding>();
    private readonly generationStore: FleetGenerationStore;
    private readonly audit: FleetAuditSink;
    private readonly callTimeoutMs: number;
    private readonly maxPendingCalls: number;
    private readonly callRecordLimit: number;
    private readonly heartbeatTimeoutMs: number;
    private readonly heartbeatSweepMs: number;
    private readonly sessionsById = new Map<string, GatewaySession>();
    private readonly activeByHost = new Map<string, GatewaySession>();
    private readonly lastByHost = new Map<string, GatewaySession>();
    private readonly pendingCalls = new Map<string, PendingCall>();
    private readonly callRecords = new Map<string, FleetGatewayCallRecord>();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    private readonly startedAtMs = Date.now();
    private readonly counters = { calls: 0, completed: 0, failed: 0, timeout: 0, canceled: 0, latencyTotalMs: 0, sentBytes: 0, receivedBytes: 0, connections: 0 };
    usageStats(): Record<string, unknown> { return { ...this.counters, uptime_ms: Date.now() - this.startedAtMs, in_flight: this.pendingCalls.size, online: this.listKnownDeviceStatuses().filter(d => d.online).length, average_call_latency_ms: (this.counters.completed + this.counters.failed + this.counters.timeout) ? this.counters.latencyTotalMs / (this.counters.completed + this.counters.failed + this.counters.timeout) : 0, counter_scope: 'gateway process lifetime' }; }

    constructor(options: FleetGatewayOptions) {

        const devices = options.devices.map((device) => ({
            ...device,
            hostname: canonicalHostname(device.hostname),
        }));
        for (const device of devices) {
            if (this.devices.has(device.hostname)) throw new Error(`duplicate device binding for ${device.hostname}`);
            this.devices.set(device.hostname, device);
        }
        this.router = new FleetRouter(devices, []);
        this.generationStore = options.generationStore ?? new MemoryGenerationStore();
        this.audit = options.audit ?? new NullAuditSink();
        this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
        this.maxPendingCalls = options.maxPendingCalls ?? 128;
        this.callRecordLimit = options.callRecordLimit ?? 500;
        this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 35_000;
        this.heartbeatSweepMs = options.heartbeatSweepMs ?? 5_000;
        this.startHeartbeatSweep();
    }

    acceptSocket(socket: FleetGatewaySocket): string {
        this.counters.connections++;
        if (this.stopped) throw new FleetGatewayError('GATEWAY_STOPPED', 'gateway is stopped');
        const session: GatewaySession = {
            socket,
            sessionId: randomUUID(),
            challenge: randomBytes(32).toString('base64'),
            authenticated: false,
            hostname: null,
            generation: null,
            policyRevision: null,
            agentVersion: null,
            publicKeyFingerprint: null,
            connectedAtMs: Date.now(),
            lastSeenAtMs: Date.now(),
        };
        this.sessionsById.set(session.sessionId, session);
        socket.onMessage((data) => {
            session.lastSeenAtMs = Date.now();
            void this.handleMessage(session, data).catch((error) => {
                void this.audit.record({
                    event: 'session_protocol_error',
                    sessionId: session.sessionId,
                    hostname: session.hostname ?? undefined,
                    generation: session.generation ?? undefined,
                    outcome: 'rejected',
                    code: error instanceof FleetGatewayError ? error.code : 'PROTOCOL_ERROR',
                    details: { message: error instanceof Error ? error.message : String(error) },
                });
                this.send(session, {
                    type: 'rejected',
                    code: error instanceof FleetGatewayError ? error.code : 'PROTOCOL_ERROR',
                });
                socket.close(4002, 'fleet protocol error');
            });
        });
        socket.onClose((code, reason) => {
            void this.handleClose(session, code, reason);
        });
        socket.onError?.((error) => {
            void this.audit.record({
                event: 'session_socket_error',
                sessionId: session.sessionId,
                hostname: session.hostname ?? undefined,
                generation: session.generation ?? undefined,
                outcome: 'error',
                details: { message: error.message },
            });
        });

        this.send(session, { type: 'challenge', challenge: session.challenge });
        void this.audit.record({ event: 'session_connected', sessionId: session.sessionId, outcome: 'pending_auth' });
        return session.sessionId;
    }

    // Transitional source/API aliases; no project/device authorization in the transport.
    async dispatch(projectId: string, hostname: string, tool: string, args: Record<string, unknown> = {}, timeoutMs = this.callTimeoutMs): Promise<unknown> {
        return this.dispatchDevice(hostname, tool, { ...args, _lcm_context: { project_id: projectId } }, timeoutMs);
    }
    async dispatchMachine(hostname: string, tool: string, args: Record<string, unknown> = {}, _explicitAuthorization = false, timeoutMs = this.callTimeoutMs): Promise<unknown> {
        return this.dispatchDevice(hostname, tool, args, timeoutMs);
    }
    async dispatchDevice(
        hostnameInput: string,
        toolName: string,
        args: Record<string, unknown> = {},
        timeoutMs = this.callTimeoutMs,
        suppliedCallId?: string,
    ): Promise<unknown> {
        if (this.stopped) throw new FleetGatewayError('GATEWAY_STOPPED', 'gateway is stopped');
        if (this.pendingCalls.size >= this.maxPendingCalls) throw new FleetGatewayError('GATEWAY_BUSY', 'gateway has too many pending calls');
        const hostname = canonicalHostname(hostnameInput);
        if (!this.devices.has(hostname)) throw new FleetGatewayError('IDENTITY_MISMATCH', `Device is not enrolled: ${hostname}`, { hostname });
        const session = this.activeByHost.get(hostname);
        if (!session || !session.authenticated || session.generation === null || session.socket.readyState !== SOCKET_OPEN) {
            throw new FleetGatewayError('TARGET_OFFLINE', `target ${hostname} is offline`, { hostname, scopeKind: 'device' });
        }
        const callId = suppliedCallId ?? randomUUID();
        const generation = session.generation;
        const createdAtMs = Date.now();
        const record: FleetGatewayCallRecord = {
            callId, scopeKind: 'device', projectId: null, hostname, toolName, sessionId: session.sessionId, generation,
            status: 'pending', createdAtMs, completedAtMs: null, code: null, error: null,
        };
        this.setCallRecord(record);
        const response = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pendingCalls.get(callId);
                if (!pending) return;
                this.pendingCalls.delete(callId);
                this.send(session, { type: 'cancel', callId, generation });
                const error = new FleetGatewayError('CALL_TIMEOUT', `fleet call ${callId} timed out`, { callId, hostname, toolName, scopeKind: 'device' });
                this.finishCallRecord(callId, 'timeout', error.code, error.message);
                void this.auditCall(record, 'timeout', error.code, Date.now() - createdAtMs);
                reject(error);
            }, Math.max(1, timeoutMs));
            this.pendingCalls.set(callId, {
                callId, sessionId: session.sessionId, generation, scopeKind: 'device', projectId: null, hostname, toolName, timer, resolve, reject, createdAtMs,
            });
        });
        this.send(session, {
            type: 'call', callId, scopeKind: 'device', hostname, toolName, args, generation,
        });
        void this.auditCall(record, 'dispatched');
        return response;
    }

    beginDeviceCall(hostname: string, tool: string, args: Record<string, unknown>, timeoutMs = this.callTimeoutMs) {
        const callId = randomUUID();
        return { callId, result: this.dispatchDevice(hostname, tool, args, timeoutMs, callId) };
    }

    machineDeviceStatus(hostnameInput: string): FleetGatewayDeviceStatus {
        const hostname = canonicalHostname(hostnameInput);
        if (!this.devices.has(hostname)) throw new FleetGatewayError('IDENTITY_MISMATCH', `Device is not enrolled: ${hostname}`);
        const session = this.activeByHost.get(hostname) ?? this.lastByHost.get(hostname);
        const online = Boolean(session && session.authenticated && session.socket.readyState === SOCKET_OPEN);
        return {
            hostname, online, sessionId: online ? session!.sessionId : null, generation: online ? session!.generation : null,
            policyRevision: session?.policyRevision ?? null, agentVersion: session?.agentVersion ?? null,
            connectedAtMs: session?.connectedAtMs ?? null, lastSeenAtMs: session?.lastSeenAtMs ?? null,
        };
    }

    cancel(callId: string): boolean {
        const pending = this.pendingCalls.get(callId);
        if (!pending) return false;
        this.pendingCalls.delete(callId);
        clearTimeout(pending.timer);
        const session = this.sessionsById.get(pending.sessionId);
        if (session) this.send(session, { type: 'cancel', callId, generation: pending.generation });
        const error = new FleetGatewayError('CALL_CANCELED', `fleet call ${callId} canceled`, { callId });
        this.finishCallRecord(callId, 'canceled', error.code, error.message);
        void this.audit.record({
            event: 'call_canceled',
            callId,
            projectId: pending.projectId ?? undefined,
            hostname: pending.hostname,
            generation: pending.generation,
            toolName: pending.toolName,
            outcome: 'canceled',
            code: error.code,
            durationMs: Date.now() - pending.createdAtMs,
        });
        pending.reject(error);
        return true;
    }

    getCallRecord(callId: string): FleetGatewayCallRecord | null {
        const record = this.callRecords.get(callId);
        return record ? { ...record } : null;
    }

    listCallRecords(limit = 20): FleetGatewayCallRecord[] {
        const bounded = Math.max(1, Math.min(limit, this.callRecordLimit));
        return [...this.callRecords.values()].slice(-bounded).reverse().map((record) => ({ ...record }));
    }

    deviceStatus(_projectId: string, hostname: string): FleetGatewayDeviceStatus { return this.machineDeviceStatus(hostname); }
    listProjectDevices(_projectId: string): FleetGatewayDeviceStatus[] { return this.listKnownDeviceStatuses(); }

    addDeviceBinding(device: DeviceBinding): DeviceBinding {
        const hostname = canonicalHostname(device.hostname);
        const normalized = { ...device, hostname };
        const existing = this.devices.get(hostname);
        if (existing) {
            if (existing.publicKeyFingerprint !== normalized.publicKeyFingerprint) {
                throw new FleetGatewayError(
                    'IDENTITY_MISMATCH',
                    `device ${hostname} is already pinned to a different identity`,
                    { hostname },
                );
            }
            return { ...existing };
        }
        this.router.addDeviceBinding(normalized);
        this.devices.set(hostname, normalized);
        return { ...normalized };
    }

    revokeDeviceBinding(hostnameInput: string): void {
        const hostname = canonicalHostname(hostnameInput);
        this.devices.delete(hostname);
        this.router.revokeDeviceBinding(hostname);
        for (const session of [...this.sessionsById.values()]) {
            if (session.hostname !== hostname) continue;
            this.rejectPendingForSession(session.sessionId, 'TARGET_OFFLINE', 'device revoked');
            this.unregisterSession(session);
            session.socket.close(1008, 'device revoked');
        }
        void this.audit.record({ event: 'device_revoked', hostname, outcome: 'revoked' });
    }

    listKnownDeviceStatuses(): Array<FleetGatewayDeviceStatus & { publicKeyFingerprint: string }> {
        return [...this.devices.values()].map((device) => {
            const session = this.activeByHost.get(device.hostname) ?? this.lastByHost.get(device.hostname);
            const online = Boolean(
                session
                && session.authenticated
                && session.socket.readyState === SOCKET_OPEN
               ,
            );
            return {
                hostname: device.hostname,
                publicKeyFingerprint: device.publicKeyFingerprint,
                online,
                sessionId: online ? session!.sessionId : null,
                generation: online ? session!.generation : null,
                policyRevision: session?.policyRevision ?? null,
            agentVersion: session?.agentVersion ?? null,
                connectedAtMs: session?.connectedAtMs ?? null,
                lastSeenAtMs: session?.lastSeenAtMs ?? null,
            };
        });
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        for (const pending of [...this.pendingCalls.values()]) {
            clearTimeout(pending.timer);
            this.pendingCalls.delete(pending.callId);
            const error = new FleetGatewayError('GATEWAY_STOPPED', 'gateway stopped while call was pending');
            this.finishCallRecord(pending.callId, 'failed', error.code, error.message);
            pending.reject(error);
        }
        for (const session of [...this.sessionsById.values()]) {
            session.socket.close(1001, 'gateway stopped');
            this.unregisterSession(session);
        }
    }

    private async handleMessage(session: GatewaySession, data: unknown): Promise<void> {
        this.counters.receivedBytes += typeof data === 'string' ? Buffer.byteLength(data) : Buffer.isBuffer(data) ? data.length : 0;
        const message = this.parseMessage(data);
        if (!session.authenticated) {
            if (message.type !== 'hello') {
                throw new FleetGatewayError('AUTH_REQUIRED', 'agent must authenticate before sending messages');
            }
            await this.handleHello(session, message);
            return;
        }
        switch (message.type) {
            case 'heartbeat':
                this.handleHeartbeat(session, message);
                return;
            case 'result':
                this.handleResult(session, message);
                return;
            default:
                throw new FleetGatewayError('PROTOCOL_ERROR', `unsupported agent message: ${String(message.type)}`);
        }
    }

    private async handleHello(session: GatewaySession, message: GatewayWireMessage): Promise<void> {
        const hostname = typeof message.hostname === 'string' ? canonicalHostname(message.hostname) : '';
        const policyRevision = typeof message.policyRevision === 'string' ? message.policyRevision : '';
        const publicKeyPem = typeof message.publicKeyPem === 'string' ? message.publicKeyPem : '';
        const signature = typeof message.signature === 'string' ? message.signature : '';
        if (!hostname || !policyRevision || !publicKeyPem || !signature) {
            throw new FleetGatewayError('IDENTITY_MISMATCH', 'incomplete agent identity');
        }
        const binding = this.devices.get(hostname);
        if (!binding) throw new FleetGatewayError('IDENTITY_MISMATCH', `unknown device ${hostname}`);
        let fingerprint: string;
        try {
            const payload = handshakePayload(session.challenge, hostname, policyRevision);
            if (!verifyChallengeSignature(publicKeyPem, payload, signature)) {
                throw new Error('challenge signature verification failed');
            }
            fingerprint = fingerprintPublicKey(publicKeyPem);
        } catch (error) {
            throw new FleetGatewayError('IDENTITY_MISMATCH', 'invalid agent public key or signature', {
                hostname,
                cause: error instanceof Error ? error.message : String(error),
            });
        }
        if (fingerprint !== binding.publicKeyFingerprint) {
            throw new FleetGatewayError('IDENTITY_MISMATCH', `agent identity does not match pinned identity for ${hostname}`);
        }
        const previous = this.activeByHost.get(hostname);
        if (previous && previous.sessionId !== session.sessionId) {
            if (previous.authenticated && previous.socket.readyState === SOCKET_OPEN) {
                await this.audit.record({
                    event: 'session_ambiguous',
                    hostname,
                    sessionId: session.sessionId,
                    generation: previous.generation ?? undefined,
                    outcome: 'rejected',
                    code: 'TARGET_AMBIGUOUS',
                    details: { activeSessionId: previous.sessionId },
                });
                throw new FleetGatewayError(
                    'TARGET_AMBIGUOUS',
                    `target ${hostname} already has an active authenticated session`,
                    { hostname, activeSessionId: previous.sessionId },
                );
            }
            this.unregisterSession(previous);
        }

        const generation = await this.generationStore.next(hostname);
        const descriptor = this.router.registerAgent({
            sessionId: session.sessionId,
            hostname,
            publicKeyFingerprint: fingerprint,
            policyRevision,
            connectedAtMs: session.connectedAtMs,
        });
        session.authenticated = true;
        session.hostname = descriptor.hostname;
        session.generation = generation;
        session.policyRevision = policyRevision;
        session.publicKeyFingerprint = fingerprint;
        session.lastSeenAtMs = Date.now();
        session.agentVersion = typeof message.agentVersion === 'string' && /^[A-Za-z0-9._+-]{1,80}$/.test(message.agentVersion) ? message.agentVersion : null;
        this.activeByHost.set(hostname, session);
        this.lastByHost.set(hostname, session);
        this.send(session, { type: 'accepted', sessionId: session.sessionId, generation });
        await this.audit.record({
            event: 'session_authenticated',
            hostname,
            sessionId: session.sessionId,
            generation,
            outcome: 'accepted',
            details: { policyRevision, publicKeyFingerprint: fingerprint },
        });
    }

    private handleHeartbeat(session: GatewaySession, message: GatewayWireMessage): void {
        const generation = typeof message.generation === 'number' ? message.generation : null;
        if (generation === null || generation !== session.generation) {
            this.send(session, { type: 'fenced', generation: session.generation, reason: 'stale heartbeat generation' });
            session.socket.close(4009, 'stale generation');
            return;
        }
        session.lastSeenAtMs = Date.now();
        this.send(session, { type: 'heartbeat_ack', generation });
    }

    private handleResult(session: GatewaySession, message: GatewayWireMessage): void {
        const callId = typeof message.callId === 'string' ? message.callId : null;
        const generation = typeof message.generation === 'number' ? message.generation : null;
        if (!callId || generation === null) return;
        const pending = this.pendingCalls.get(callId);
        if (!pending) {
            void this.audit.record({
                event: 'call_result_orphaned',
                callId,
                hostname: session.hostname ?? undefined,
                sessionId: session.sessionId,
                generation,
                outcome: 'ignored',
            });
            return;
        }
        if (pending.sessionId !== session.sessionId || pending.generation !== generation || session.generation !== generation) {
            void this.audit.record({
                event: 'call_result_fenced',
                callId,
                projectId: pending.projectId ?? undefined,
                hostname: pending.hostname,
                sessionId: session.sessionId,
                generation,
                toolName: pending.toolName,
                outcome: 'ignored',
                code: 'FENCED_SESSION',
            });
            return;
        }

        clearTimeout(pending.timer);
        this.pendingCalls.delete(callId);
        const ok = message.ok === true;
        const durationMs = Date.now() - pending.createdAtMs;
        if (ok) {
            this.finishCallRecord(callId, 'completed', null, null, message.result);
            void this.audit.record({
                event: 'call_completed',
                callId,
                projectId: pending.projectId ?? undefined,
                hostname: pending.hostname,
                sessionId: pending.sessionId,
                generation,
                toolName: pending.toolName,
                outcome: 'completed',
                durationMs,
            });
            pending.resolve(message.result);
            return;
        }

        const code = typeof message.code === 'string' ? message.code : 'REMOTE_CALL_FAILED';
        const errorMessage = typeof message.error === 'string' ? message.error : `remote call failed: ${code}`;
        const error = new FleetGatewayError(code, errorMessage, { callId });
        this.finishCallRecord(callId, 'failed', code, errorMessage);
        void this.audit.record({
            event: 'call_failed',
            callId,
            projectId: pending.projectId ?? undefined,
            hostname: pending.hostname,
            sessionId: pending.sessionId,
            generation,
            toolName: pending.toolName,
            outcome: 'failed',
            code,
            durationMs,
        });
        pending.reject(error);
    }

    private async handleClose(session: GatewaySession, code?: number, reason?: string): Promise<void> {
        const wasCurrent = Boolean(
            session.hostname
            && this.activeByHost.get(session.hostname)?.sessionId === session.sessionId,
        );
        if (wasCurrent) this.rejectPendingForSession(session.sessionId, 'TARGET_OFFLINE', 'agent disconnected');
        this.unregisterSession(session);
        await this.audit.record({
            event: 'session_disconnected',
            hostname: session.hostname ?? undefined,
            sessionId: session.sessionId,
            generation: session.generation ?? undefined,
            outcome: wasCurrent ? 'offline' : 'stale_closed',
            details: { code: code ?? null, reason: reason ?? null },
        });
    }

    private unregisterSession(session: GatewaySession): void {
        this.sessionsById.delete(session.sessionId);
        if (session.hostname) {
            this.router.unregisterAgent(session.hostname, session.sessionId);
            if (this.activeByHost.get(session.hostname)?.sessionId === session.sessionId) {
                this.activeByHost.delete(session.hostname);
            }
        }
        session.authenticated = false;
    }

    private rejectPendingForSession(sessionId: string, code: string, message: string): void {
        for (const pending of [...this.pendingCalls.values()]) {
            if (pending.sessionId !== sessionId) continue;
            clearTimeout(pending.timer);
            this.pendingCalls.delete(pending.callId);
            const error = new FleetGatewayError(code, message, { callId: pending.callId });
            this.finishCallRecord(pending.callId, 'failed', code, message);
            pending.reject(error);
        }
    }

    private setCallRecord(record: FleetGatewayCallRecord): void {
        this.counters.calls++;
        this.callRecords.set(record.callId, record);
        while (this.callRecords.size > this.callRecordLimit) {
            const oldest = this.callRecords.keys().next().value as string | undefined;
            if (!oldest) break;
            this.callRecords.delete(oldest);
        }
    }

    private finishCallRecord(
        callId: string,
        status: FleetGatewayCallStatus,
        code: string | null,
        error: string | null,
        result?: unknown,
    ): void {
        const current = this.callRecords.get(callId);
        if (!current) return;
        if (current.status === 'pending' && status !== 'pending') {
            this.counters[status]++;
            this.counters.latencyTotalMs += Date.now() - current.createdAtMs;
        }
        this.callRecords.set(callId, {
            ...current,
            status,
            completedAtMs: Date.now(),
            code,
            error,
            ...(result === undefined ? {} : { result }),
        });
    }

    private auditCall(
        record: FleetGatewayCallRecord,
        outcome: string,
        code?: string,
        durationMs?: number,
    ): Promise<void> {
        return this.audit.record({
            event: outcome === 'dispatched' ? 'call_dispatched' : 'call_finished',
            callId: record.callId,
            projectId: record.projectId ?? undefined,
            hostname: record.hostname,
            sessionId: record.sessionId,
            generation: record.generation,
            toolName: record.toolName,
            outcome,
            code,
            durationMs,
        });
    }

    private startHeartbeatSweep(): void {
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            for (const session of [...this.activeByHost.values()]) {
                if (now - session.lastSeenAtMs <= this.heartbeatTimeoutMs) continue;
                this.rejectPendingForSession(session.sessionId, 'TARGET_OFFLINE', 'agent heartbeat timed out');
                this.unregisterSession(session);
                session.socket.close(4008, 'heartbeat timeout');
                void this.audit.record({
                    event: 'session_heartbeat_timeout',
                    hostname: session.hostname ?? undefined,
                    sessionId: session.sessionId,
                    generation: session.generation ?? undefined,
                    outcome: 'offline',
                });
            }
        }, this.heartbeatSweepMs);
    }

    private send(session: GatewaySession, message: GatewayWireMessage): void {
        if (session.socket.readyState !== SOCKET_OPEN) return;
        const body = JSON.stringify(message);
        this.counters.sentBytes += Buffer.byteLength(body);
        session.socket.send(body);
    }

    private parseMessage(data: unknown): GatewayWireMessage {
        let text: string;
        if (typeof data === 'string') text = data;
        else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
        else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
        else if (Buffer.isBuffer(data)) text = data.toString('utf8');
        else text = String(data);
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new FleetGatewayError('PROTOCOL_ERROR', 'agent message must be a JSON object');
        }
        return parsed as GatewayWireMessage;
    }
}
