import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFleetGatewayService } from './gateway-service.js';
import { loadGatewayServiceConfig } from './service-config.js';

export async function runFleetGatewayCli(argv = process.argv.slice(2), env = process.env): Promise<void> {
    const configPath = argumentValue(argv, '--config') ?? env.FLEET_GATEWAY_CONFIG;
    if (!configPath) throw new Error('Fleet Gateway requires --config <path> or FLEET_GATEWAY_CONFIG');
    const config = await loadGatewayServiceConfig(configPath, env);
    const service = await startFleetGatewayService(config, env);
    process.stdout.write(`${JSON.stringify({
        service: 'network-fleet-gateway',
        mcp: {
            listenHost: config.mcpListenHost,
            listenPort: config.mcpListenPort,
            auth: config.mcpAuth.type,
            address: service.mcpAddress(),
        },
        agent: {
            listenHost: config.agentListenHost,
            listenPort: config.agentListenPort,
            path: config.agentPath,
            address: service.agentAddress(),
        },
        admin: config.adminListenPort !== undefined ? {
            listenHost: config.adminListenHost,
            listenPort: config.adminListenPort,
            basePath: config.adminBasePath,
            address: service.adminAddress(),
        } : null,
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
    runFleetGatewayCli().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
