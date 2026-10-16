import { FleetGateway } from './fleet-gateway.js';
import { FleetPluginBackend } from './plugin-server.js';
import { canonicalHostname } from './identity.js';
export interface FleetPluginProbeBinding { projectId: string; hostname: string; path?: string; }
export interface FleetGatewayPluginBackendOptions { gateway: FleetGateway; probes?: FleetPluginProbeBinding[]; callTimeoutMs?: number; maxWriteBytes?: number; }
export class FleetGatewayPluginBackend implements FleetPluginBackend {
    private readonly gateway: FleetGateway;
    private readonly timeout: number;
    constructor(options: FleetGatewayPluginBackendOptions) { this.gateway = options.gateway; this.timeout = options.callTimeoutMs ?? 60000; }
    async fleetStatus(_legacy: string, hostname: string) { return { ...this.gateway.machineDeviceStatus(hostname), exact_host: true }; }
    async listDevices(_legacy = '') { return this.gateway.listKnownDeviceStatuses(); }
    async callDeviceTool(hostname: string, name: string, args: Record<string, unknown>) {
        const call = this.gateway.beginDeviceCall(hostname, name, args, this.timeout);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([call.result, new Promise(resolve => { timer = setTimeout(() => resolve({ content: [{ type: 'text', text: JSON.stringify({ status: 'running', call_id: call.callId, hostname: canonicalHostname(hostname), next: 'get_tool_result; do not repeat the original operation' }) }] }), 2500); })]);
        } finally { if (timer) clearTimeout(timer); }
    }
    async callProjectTool(project: string, hostname: string, name: string, args: Record<string, unknown>) { return this.callDeviceTool(hostname, name, { ...args, _lcm_context: { project_id: project } }); }
    async callMachineTool(hostname: string, name: string, args: Record<string, unknown>, _legacy: boolean) { return this.callDeviceTool(hostname, name, args); }
    async ping(_legacy: string, hostname: string) {
        const start = performance.now();
        const result = await this.gateway.dispatchDevice(hostname, '__lcm_ping', {}, Math.min(this.timeout, 15000));
        return { pong: true, hostname: canonicalHostname(hostname), round_trip_ms: Math.round((performance.now() - start) * 100) / 100, device: result };
    }
    async whoAmI() { return { product: 'Local Control MCP', hosted: false, model: 'owner-scoped device transport', governance: 'external target policy', automatic_device_fallback: false }; }
    async getToolResult(_legacy: string, hostname: string, callId: string) {
        const record = this.gateway.getCallRecord(callId);
        if (!record || (hostname && record.hostname !== canonicalHostname(hostname))) throw Object.assign(new Error('Call not found on the selected device'), { code: 'CALL_NOT_FOUND' });
        return { ...record };
    }
    async listRemoteToolCalls(_legacy: string, hostname: string | undefined, limit: number) {
        const exact = hostname ? canonicalHostname(hostname) : undefined;
        return this.gateway.listCallRecords(1024).filter(r => !exact || r.hostname === exact).slice(0, Math.max(1, Math.min(limit, 100))).map(r => ({ ...r }));
    }
    async usageStats() { return this.gateway.usageStats(); }
}
