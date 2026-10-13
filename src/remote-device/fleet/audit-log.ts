import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FleetAuditEvent {
    at: string;
    event: string;
    projectId?: string;
    hostname?: string;
    sessionId?: string;
    generation?: number;
    callId?: string;
    toolName?: string;
    outcome?: string;
    code?: string;
    durationMs?: number;
    details?: Record<string, unknown>;
}

export interface FleetAuditSink {
    record(event: Omit<FleetAuditEvent, 'at'> & { at?: string }): Promise<void>;
}

export class MemoryAuditSink implements FleetAuditSink {
    readonly events: FleetAuditEvent[] = [];

    async record(event: Omit<FleetAuditEvent, 'at'> & { at?: string }): Promise<void> {
        this.events.push(Object.freeze({ at: event.at ?? new Date().toISOString(), ...event }));
    }
}

export class JsonlAuditSink implements FleetAuditSink {
    private readonly path: string;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(path: string) {
        if (!path) throw new Error('audit path is required');
        this.path = path;
    }

    record(event: Omit<FleetAuditEvent, 'at'> & { at?: string }): Promise<void> {
        const safe = sanitizeAuditEvent({ at: event.at ?? new Date().toISOString(), ...event });
        const work = async () => {
            await mkdir(dirname(this.path), { recursive: true });
            await appendFile(this.path, `${JSON.stringify(safe)}\n`, 'utf8');
        };
        const next = this.queue.then(work, work);
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }
}

export class NullAuditSink implements FleetAuditSink {
    async record(_event: Omit<FleetAuditEvent, 'at'> & { at?: string }): Promise<void> {
        // Explicit sink for tests that do not inspect audit records.
    }
}

function sanitizeAuditEvent(event: FleetAuditEvent): FleetAuditEvent {
    const details = event.details ? sanitizeValue(event.details, 0) as Record<string, unknown> : undefined;
    return {
        at: event.at,
        event: String(event.event).slice(0, 120),
        projectId: trimOptional(event.projectId, 160),
        hostname: trimOptional(event.hostname, 120),
        sessionId: trimOptional(event.sessionId, 160),
        generation: safeNumber(event.generation),
        callId: trimOptional(event.callId, 160),
        toolName: trimOptional(event.toolName, 160),
        outcome: trimOptional(event.outcome, 80),
        code: trimOptional(event.code, 120),
        durationMs: safeNumber(event.durationMs),
        details,
    };
}

function sanitizeValue(value: unknown, depth: number): unknown {
    if (depth >= 3) return '[depth-limit]';
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 500);
    if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 500);
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
        const lower = key.toLowerCase();
        if (lower.includes('token') || lower.includes('secret') || lower.includes('private') || lower.includes('password') || lower.includes('content') || lower === 'args' || lower === 'result') {
            output[key] = '[redacted]';
        } else {
            output[key] = sanitizeValue(entry, depth + 1);
        }
    }
    return output;
}

function trimOptional(value: string | undefined, max: number): string | undefined {
    return value === undefined ? undefined : String(value).slice(0, max);
}

function safeNumber(value: number | undefined): number | undefined {
    return value === undefined || !Number.isFinite(value) ? undefined : value;
}
