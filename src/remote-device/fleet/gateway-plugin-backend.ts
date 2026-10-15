import { FleetGateway } from './fleet-gateway.js';
import { FleetPluginBackend, FleetPluginDeviceView } from './plugin-server.js';
import { canonicalHostname } from './identity.js';

export interface FleetPluginProbeBinding {
    projectId: string;
    hostname: string;
    path?: string;
}

export interface FleetGatewayPluginBackendOptions {
    gateway: FleetGateway;
    probes: FleetPluginProbeBinding[];
    callTimeoutMs?: number;
    maxWriteBytes?: number;
}

export class FleetGatewayPluginBackend implements FleetPluginBackend {
    private readonly gateway: FleetGateway;
    private readonly probes = new Map<string, FleetPluginProbeBinding>();
    private readonly callTimeoutMs: number;
    private readonly maxWriteBytes: number;

    constructor(options: FleetGatewayPluginBackendOptions) {
        this.gateway = options.gateway;
        this.callTimeoutMs = options.callTimeoutMs ?? 5_000;
        this.maxWriteBytes = options.maxWriteBytes ?? 4_096;
        for (const probe of options.probes) {
            const normalized: FleetPluginProbeBinding = {
                ...probe,
                hostname: canonicalHostname(probe.hostname),
            };
            if (!normalized.projectId) throw new Error('probe binding requires projectId');
            const key = this.key(normalized.projectId, normalized.hostname);
            if (this.probes.has(key)) throw new Error(`duplicate Fleet Plugin probe binding: ${key}`);
            this.probes.set(key, normalized);
        }
    }

    async fleetStatus(projectId: string, hostnameInput: string): Promise<Record<string, unknown>> {
        const hostname = canonicalHostname(hostnameInput);
        const status = this.gateway.deviceStatus(projectId, hostname);
        return {
            project_id: projectId,
            hostname: status.hostname,
            online: status.online,
            exact_host: true,
            generation: status.generation,
            policy_revision: status.policyRevision,
            connected_at_ms: status.connectedAtMs,
            last_seen_at_ms: status.lastSeenAtMs,
        };
    }

    async listDevices(projectId: string): Promise<FleetPluginDeviceView[]> {
        return this.gateway.listProjectDevices(projectId).map((status) => ({
            hostname: status.hostname,
            online: status.online,
            policyRevision: status.policyRevision ?? undefined,
        }));
    }

    async callProjectTool(
        projectId: string,
        hostnameInput: string,
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<unknown> {
        const hostname = canonicalHostname(hostnameInput);
        return this.gateway.dispatch(projectId, hostname, toolName, { ...args }, this.callTimeoutMs);
    }

    async ping(projectId: string, hostnameInput: string): Promise<Record<string, unknown>> {
        const hostname = canonicalHostname(hostnameInput);
        const status = this.gateway.deviceStatus(projectId, hostname);
        if (!status.online) {
            throw Object.assign(new Error(`target ${hostname} is offline`), { code: 'TARGET_OFFLINE' });
        }
        return {
            pong: true,
            project_id: projectId,
            hostname,
            timestamp_ms: Date.now(),
            generation: status.generation,
            policy_revision: status.policyRevision,
            last_seen_at_ms: status.lastSeenAtMs,
        };
    }

    async whoAmI(): Promise<Record<string, unknown>> {
        return {
            product: 'Local Control MCP',
            short_name: 'LCM',
            server: 'local_control_mcp',
            hosted: false,
            transport: 'self_hosted_fleet',
            hosted_rdc_quota: 'not_applicable',
        };
    }

    async getToolResult(projectId: string, hostnameInput: string, callId: string): Promise<Record<string, unknown>> {
        const hostname = canonicalHostname(hostnameInput);
        this.gateway.deviceStatus(projectId, hostname);
        const record = this.gateway.getCallRecord(callId);
        if (!record || record.projectId !== projectId || record.hostname !== hostname) {
            throw Object.assign(new Error(`remote call is not visible to ${projectId} on ${hostname}`), { code: 'PROJECT_DEVICE_DENIED' });
        }
        return { ...record };
    }

    async listRemoteToolCalls(projectId: string, hostnameInput: string | undefined, limit: number): Promise<Record<string, unknown>[]> {
        const hostname = hostnameInput ? canonicalHostname(hostnameInput) : undefined;
        if (hostname) this.gateway.deviceStatus(projectId, hostname);
        else this.gateway.listProjectDevices(projectId);
        const bounded = Math.max(1, Math.min(limit, 50));
        return this.gateway.listCallRecords(1024)
            .filter((record) => record.projectId === projectId && (!hostname || record.hostname === hostname))
            .slice(0, bounded)
            .map((record) => ({ ...record }));
    }

    // Migration-only probe helpers. They are no longer exposed on the user-facing MCP surface.
    async readTestFile(projectId: string, hostnameInput: string): Promise<string> {
        const probe = this.requireProbe(projectId, hostnameInput);
        const result = await this.gateway.dispatch(
            projectId,
            probe.hostname,
            'read_file',
            probe.path ? { path: probe.path } : {},
            this.callTimeoutMs,
        );
        return firstText(result);
    }

    async writeTestFile(
        projectId: string,
        hostnameInput: string,
        content: string,
    ): Promise<{ bytesWritten: number }> {
        const probe = this.requireProbe(projectId, hostnameInput);
        const bytesWritten = Buffer.byteLength(content, 'utf8');
        if (bytesWritten > this.maxWriteBytes) {
            const error = new Error(`write probe exceeds ${this.maxWriteBytes} bytes`);
            Object.assign(error, { code: 'PROJECT_DEVICE_DENIED' });
            throw error;
        }
        await this.gateway.dispatch(
            projectId,
            probe.hostname,
            'write_file',
            probe.path ? { path: probe.path, content, mode: 'rewrite' } : { content, mode: 'rewrite' },
            this.callTimeoutMs,
        );
        return { bytesWritten };
    }

    private requireProbe(projectId: string, hostnameInput: string): FleetPluginProbeBinding {
        const hostname = canonicalHostname(hostnameInput);
        const probe = this.probes.get(this.key(projectId, hostname));
        if (!probe) {
            const error = new Error(`no write-probe binding for ${projectId} on ${hostname}`);
            Object.assign(error, { code: 'PROJECT_DEVICE_DENIED' });
            throw error;
        }
        return probe;
    }

    private key(projectId: string, hostname: string): string {
        return `${projectId}\u0000${canonicalHostname(hostname)}`;
    }
}

function firstText(result: unknown): string {
    if (!result || typeof result !== 'object') return '';
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return '';
    const item = content.find((entry) => entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'text');
    return item && typeof (item as { text?: unknown }).text === 'string'
        ? (item as { text: string }).text
        : '';
}
