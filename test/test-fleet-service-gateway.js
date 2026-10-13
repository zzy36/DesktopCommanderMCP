import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGatewayServiceConfig } from '../dist/remote-device/fleet/service-config.js';
import { startFleetGatewayService } from '../dist/remote-device/fleet/gateway-service.js';

const root = await mkdtemp(join(tmpdir(), 'fleet-service-gateway-'));
const configPath = join(root, 'gateway.json');
const stateDir = join(root, 'state');
const tokenEnv = 'FLEET_TEST_BEARER_TOKEN';
const token = 'fleet-test-secret';

await writeFile(configPath, JSON.stringify({
  schemaVersion: 1,
  mcp: {
    listenHost: '127.0.0.1',
    listenPort: 0,
    auth: { type: 'bearer', tokenEnv },
  },
  agent: {
    listenHost: '127.0.0.1',
    listenPort: 0,
    path: '/agent',
  },
  stateDir,
  devices: [{
    hostname: 'YUAN',
    publicKeyFingerprint: `sha256:${'0'.repeat(64)}`,
  }],
  projects: [{
    projectId: 'network.ikuai',
    hostname: 'YUAN',
    policyRevision: 'control@000000000000',
  }],
  probes: [{
    projectId: 'network.ikuai',
    hostname: 'YUAN',
  }],
}, null, 2));

const env = { [tokenEnv]: token };
const config = await loadGatewayServiceConfig(configPath, env);
const service = await startFleetGatewayService(config, env);

try {
  const mcpPort = portOf(service.mcpAddress());
  const agentPort = portOf(service.agentAddress());
  assert.notEqual(mcpPort, agentPort);

  const mcpBase = `http://127.0.0.1:${mcpPort}`;
  const agentBase = `http://127.0.0.1:${agentPort}`;

  let response = await fetch(`${mcpBase}/healthz`);
  assert.equal(response.status, 200);

  response = await fetch(`${mcpBase}/mcp`);
  assert.equal(response.status, 401);

  response = await fetch(`${mcpBase}/mcp`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 405);

  response = await fetch(`${mcpBase}/agent`);
  assert.equal(response.status, 404);

  response = await fetch(`${agentBase}/healthz`);
  assert.equal(response.status, 200);

  response = await fetch(`${agentBase}/mcp`);
  assert.equal(response.status, 404);

  console.log('fleet gateway split-listener tests passed');
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}

function portOf(address) {
  assert.ok(address && typeof address === 'object' && 'port' in address);
  return address.port;
}
