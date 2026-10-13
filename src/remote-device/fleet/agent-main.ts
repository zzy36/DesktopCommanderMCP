import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFleetAgentProvisioningInfo, startFleetAgentService } from './agent-service.js';
import { loadAgentServiceConfig } from './service-config.js';

export async function runFleetAgentCli(argv = process.argv.slice(2), env = process.env): Promise<void> {
    const configPath = argumentValue(argv, '--config') ?? env.FLEET_AGENT_CONFIG;
    if (!configPath) throw new Error('Fleet Agent requires --config <path> or FLEET_AGENT_CONFIG');
    const config = await loadAgentServiceConfig(configPath, env);

    if (argv.includes('--print-provisioning')) {
        const info = await getFleetAgentProvisioningInfo(config);
        process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
        return;
    }

    const service = await startFleetAgentService(config);
    const state = service.agent.getState();
    process.stdout.write(`${JSON.stringify({
        service: 'network-fleet-agent',
        hostname: state.hostname,
        gatewayUrl: config.gatewayUrl,
        publicKeyFingerprint: state.publicKeyFingerprint,
        policyRevision: state.policyRevision,
        started: true,
    })}\n`);

    installShutdown(async () => {
        await service.close();
    });
}

function argumentValue(argv: string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
}

function installShutdown(close: () => Promise<void>): void {
    let stopping = false;
    const handler = () => {
        if (stopping) return;
        stopping = true;
        void close().finally(() => process.exit(0));
    };
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
    runFleetAgentCli().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
