import { ControlPolicyAuthorizer } from './control-policy.js';
import { DeviceIdentityStore } from './device-identity.js';
import { DeviceAgent } from './device-agent.js';
import { FleetAgent, createProjectControlPolicy } from './fleet-agent.js';
import { ResolvedAgentServiceConfig } from './service-config.js';

export interface RunningFleetAgentService {
    agent: FleetAgent | DeviceAgent;
    close(): Promise<void>;
}

export interface FleetAgentProvisioningInfo {
    hostname: string;
    publicKeyFingerprint: string;
    policyRevision: string;
    controlRoot: string;
    stateDir: string;
}

export async function startFleetAgentService(
    config: ResolvedAgentServiceConfig,
): Promise<RunningFleetAgentService> {
    if (config.deviceFirst !== false) {
        const agent = new DeviceAgent(config);
        try { await agent.start(); } catch (error) { await agent.stop(); throw error; }
        return { agent, close: () => agent.stop() };
    }
    const agent = new FleetAgent({
        gatewayUrl: config.gatewayUrl,
        controlRoot: config.controlRoot,
        stateDir: config.stateDir,
        hostname: config.hostname,
        toolPolicy: createProjectControlPolicy(),
        policyWatchMs: config.policyWatchMs,
        interactiveStateDir: config.interactiveStateDir,
        channel: config.channel,
    });
    await agent.start();
    return {
        agent,
        close: () => agent.stop(),
    };
}

export async function getFleetAgentProvisioningInfo(
    config: ResolvedAgentServiceConfig,
): Promise<FleetAgentProvisioningInfo> {
    const identity = await new DeviceIdentityStore({ stateDir: config.stateDir }).loadOrCreate(config.hostname);
    if (config.deviceFirst !== false) return { hostname: config.hostname, publicKeyFingerprint: identity.publicKeyFingerprint, policyRevision: 'device-v1', controlRoot: '', stateDir: config.stateDir };
    const authorizer = new ControlPolicyAuthorizer({ controlRoot: config.controlRoot });
    try {
        const policyRevision = await authorizer.policyRevision();
        return {
            hostname: config.hostname,
            publicKeyFingerprint: identity.publicKeyFingerprint,
            policyRevision,
            controlRoot: config.controlRoot,
            stateDir: config.stateDir,
        };
    } finally {
        await authorizer.stop().catch(() => undefined);
    }
}
