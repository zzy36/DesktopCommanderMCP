import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAgentServiceConfig,
  loadGatewayServiceConfig,
} from '../dist/remote-device/fleet/service-config.js';

const root = await mkdtemp(join(tmpdir(), 'fleet-service-config-'));
try {
  const controlRoot = join(root, '.control');
  await mkdir(join(controlRoot, 'tools', 'machine-control'), { recursive: true });
  await writeFile(join(controlRoot, 'projects.registry.json'), '{}');
  await writeFile(join(controlRoot, 'devices.registry.json'), '{}');
  await writeFile(join(controlRoot, 'tools', 'machine-control', 'machine_control_gateway.py'), '# test');

  const baseGateway = {
    schemaVersion: 1,
    mcp: {
      listenHost: '127.0.0.1',
      listenPort: 24787,
      auth: { type: 'bearer', tokenEnv: 'FLEET_TEST_TOKEN' },
    },
    agent: {
      listenHost: '127.0.0.1',
      listenPort: 24788,
      path: '/agent',
    },
    admin: {
      listenHost: '127.0.0.1',
      listenPort: 24789,
      basePath: '/admin',
    },
    stateDir: join(root, 'state'),
    devices: [{ hostname: 'YUAN', publicKeyFingerprint: `sha256:${'0'.repeat(64)}` }],
    projects: [{ projectId: 'network.ikuai', hostname: 'YUAN', policyRevision: 'control@000000000000' }],
    probes: [{ projectId: 'network.ikuai', hostname: 'YUAN' }],
  };

  const gatewayPath = join(root, 'gateway.json');
  await writeFile(gatewayPath, JSON.stringify(baseGateway));
  const gateway = await loadGatewayServiceConfig(gatewayPath, {});
  assert.equal(gateway.mcpListenHost, '127.0.0.1');
  assert.equal(gateway.mcpListenPort, 24787);
  assert.equal(gateway.agentListenPort, 24788);
  assert.equal(gateway.adminListenPort, 24789);
  assert.equal(gateway.adminBasePath, '/admin');
  assert.equal(gateway.mcpAuth.type, 'bearer');

  await writeFile(gatewayPath, JSON.stringify({
    ...baseGateway,
    agent: { ...baseGateway.agent, listenPort: 24787 },
  }));
  await assert.rejects(loadGatewayServiceConfig(gatewayPath, {}), /distinct host\/port bindings/);

  await writeFile(gatewayPath, JSON.stringify({
    ...baseGateway,
    agent: { ...baseGateway.agent, path: '/mcp' },
  }));
  await assert.rejects(loadGatewayServiceConfig(gatewayPath, {}), /distinct from the MCP endpoint/);

  await writeFile(gatewayPath, JSON.stringify({
    ...baseGateway,
    admin: { ...baseGateway.admin, listenPort: 24788 },
  }));
  await assert.rejects(loadGatewayServiceConfig(gatewayPath, {}), /Admin and Agent listeners must use distinct/);

  await writeFile(gatewayPath, JSON.stringify({
    ...baseGateway,
    admin: { ...baseGateway.admin, basePath: '/' },
  }));
  await assert.rejects(loadGatewayServiceConfig(gatewayPath, {}), /admin.basePath must be a non-root/);

  await writeFile(gatewayPath, JSON.stringify({
    ...baseGateway,
    mcp: {
      ...baseGateway.mcp,
      auth: {
        type: 'oauth',
        issuerUrl: 'http://fleet-mcp.home.arpa/',
        resourceUrl: 'http://fleet-mcp.home.arpa/mcp',
        ownerPasswordHashEnv: 'FLEET_OWNER_PASSWORD_HASH',
      },
    },
  }));
  await assert.rejects(loadGatewayServiceConfig(gatewayPath, {}), /must use https/);

  const agentPath = join(root, 'agent.json');
  await writeFile(agentPath, JSON.stringify({
    schemaVersion: 1,
    gatewayUrl: 'ws://fleet-mcp.home.arpa:24443/agent',
    controlRoot,
    stateDir: join(root, 'agent-state'),
    hostname: 'YUAN',
  }));
  await assert.rejects(loadAgentServiceConfig(agentPath, {}), /must use wss/);

  await writeFile(agentPath, JSON.stringify({
    schemaVersion: 1,
    gatewayUrl: 'wss://fleet-mcp.home.arpa:24443/agent',
    controlRoot,
    stateDir: join(root, 'agent-state'),
    hostname: 'yuan',
  }));
  const agent = await loadAgentServiceConfig(agentPath, {});
  assert.equal(agent.hostname, 'YUAN');
  assert.equal(agent.controlRoot, controlRoot);

  console.log('fleet service config security tests passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
