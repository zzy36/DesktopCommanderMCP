import { ControlPolicyAuthorizer } from './control-policy.js';
import { DeviceIdentityStore } from './device-identity.js';
import { FleetAgent, createProjectControlPolicy } from './fleet-agent.js';
import { ResolvedAgentServiceConfig } from './service-config.js';

export interface RunningFleetAgentService {
    agent: FleetAgent;
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
    const agent = new FleetAgent({
        gatewayUrl: config.gatewayUrl,
        controlRoot: config.controlRoot,
        stateDir: config.stateDir,
        hostname: config.hostname,
        toolPolicy: createProjectControlPolicy(),
        policyWatchMs: config.policyWatchMs,
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
