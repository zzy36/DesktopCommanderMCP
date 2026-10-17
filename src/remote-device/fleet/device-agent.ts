import os from 'node:os';
import { DesktopCommanderIntegration } from '../desktop-commander-integration.js';
import { DeviceIdentityStore } from './device-identity.js';
import { FleetChannel } from './fleet-channel.js';
import { InteractiveUserClient } from './interactive-user-bridge.js';
import { canonicalHostname } from './identity.js';
import { DeviceExecutor, checkExecutionPolicy } from './device-executor.js';
import { ProjectResourceScope } from './project-tool-contract.js';
import { ResolvedAgentServiceConfig } from './service-config.js';

/** Owner-authenticated device transport; target execution policy is an external hook. */
export class DeviceAgent {
    private readonly desktop = new DesktopCommanderIntegration();
    private channel: FleetChannel | null = null;
    private fingerprint: string | null = null;
    private readonly resources = new ProjectResourceScope();
    private readonly processContexts = new Map<number, string>();
    private readonly searchContexts = new Map<string, string>();
    private readonly hostname: string;
    constructor(private readonly config: ResolvedAgentServiceConfig) {
        this.hostname = canonicalHostname(config.hostname);
        if (this.hostname !== canonicalHostname(os.hostname())) throw new Error('Exact device hostname mismatch');
    }
    getState() { return { started: !!this.channel, hostname: this.hostname, policyRevision: 'device-v1', publicKeyFingerprint: this.fingerprint, desktopReady: this.desktop.ready, channel: this.channel?.getState() ?? null }; }
    async start() {
        const identity = await new DeviceIdentityStore({ stateDir: this.config.stateDir }).loadOrCreate(this.hostname);
        this.fingerprint = identity.publicKeyFingerprint;
        await this.desktop.initialize();
        const executor = new DeviceExecutor(this.desktop, this.hostname, this.config.executionPolicy);
        this.channel = new FleetChannel({
            ...this.config.channel, url: this.config.gatewayUrl, hostname: this.hostname,
            policyRevision: 'device-v1', agentVersion: process.env.LCM_RELEASE,
            publicKeyPem: identity.publicKeyPem, privateKey: identity.privateKeyPem,
            authorize: () => false, authorizeDevice: host => host === this.hostname,
            execute: async (name, args, context) => {
                if (context.scopeKind !== 'device') throw Object.assign(new Error('Legacy governance transport is retired'), { code: 'INVALID_DEVICE_REQUEST' });
                if (name === '__lcm_ping') return { hostname: this.hostname, runtime: process.env.LCM_RELEASE ?? 'development', timestamp_ms: Date.now(), executor_ready: this.desktop.ready };
                if (name === 'shutdown') {
                    await checkExecutionPolicy(this.config.executionPolicy, { hostname: this.hostname, tool: name, args, context: args._lcm_context });
                    // Reply before stopping the LCM Agent; never shut down Windows.
                    setTimeout(() => { void this.stop(); }, 500);
                    return { content: [{ type: 'text', text: 'LCM Agent stopping. Windows remains running; restart the Agent task to reconnect.' }] };
                }
                const affinity = typeof args.pid === 'number' ? this.processContexts.get(args.pid) : typeof args.sessionId === 'string' ? this.searchContexts.get(args.sessionId) : undefined;
                const requested = args.execution_context;
                if (requested !== undefined && requested !== 'system' && requested !== 'interactive') throw new Error('Invalid execution_context');
                if (requested && affinity && requested !== affinity) throw new Error('Resource belongs to another execution context');
                const selected = requested ?? affinity ?? 'interactive';
                let result;
                if (selected === 'interactive') {
                    if (!this.config.interactiveStateDir) throw Object.assign(new Error('Interactive executor unavailable; no SYSTEM downgrade'), { code: 'INTERACTIVE_SESSION_UNAVAILABLE' });
                    result = await new InteractiveUserClient(this.config.interactiveStateDir).callTool(name, args, null, this.hostname, context.signal, 'device');
                } else result = await executor.execute(name, args, context.signal);
                const text = JSON.stringify(result);
                if (name === 'start_process') { const match = text.match(/Process started with PID\s+(\d+)/i); if (match) this.processContexts.set(Number(match[1]), selected as string); }
                if (name === 'start_search') { const match = text.match(/search session:\s*([^\s"\\]+)/i); if (match) this.searchContexts.set(match[1], selected as string); }
                return this.resources.transformDevice(name, result, this.hostname);
            },
        });
        this.channel.start();
    }
    async stop() { const channel = this.channel; this.channel = null; await channel?.stop(); await this.desktop.shutdown(); }
}
