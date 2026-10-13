import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MemoryAuditSink } from '../dist/remote-device/fleet/audit-log.js';
import { ControlPolicyAuthorizer } from '../dist/remote-device/fleet/control-policy.js';
import { DeviceIdentityStore } from '../dist/remote-device/fleet/device-identity.js';
import { FleetAgent, createDedicatedTestFilePolicy } from '../dist/remote-device/fleet/fleet-agent.js';
import { FleetGateway } from '../dist/remote-device/fleet/fleet-gateway.js';
import { FileGenerationStore } from '../dist/remote-device/fleet/gateway-state.js';
import { FleetGatewayPluginBackend } from '../dist/remote-device/fleet/gateway-plugin-backend.js';
import { createFleetPluginHttpServer } from '../dist/remote-device/fleet/plugin-server.js';

const controlRoot = process.env.FLEET_TEST_CONTROL_ROOT;
assert(controlRoot, 'FLEET_TEST_CONTROL_ROOT is required');

const runtimeDir = await mkdtemp(join(tmpdir(), 'fleet-platform-'));
const agentStateDir = join(runtimeDir, 'agent');
const probeFile = join(runtimeDir, 'plugin-write-probe.txt');
const generationFile = join(runtimeDir, 'gateway-generations.json');

const authorizer = new ControlPolicyAuthorizer({ controlRoot });
const policyRevision = await authorizer.policyRevision();
await authorizer.stop();
const identity = await new DeviceIdentityStore({ stateDir: agentStateDir }).loadOrCreate('YUAN');
const audit = new MemoryAuditSink();

const gateway = new FleetGateway({
  devices: [{ hostname: 'YUAN', publicKeyFingerprint: identity.publicKeyFingerprint }],
  projects: [{ projectId: 'network.ikuai', hostname: 'YUAN', policyRevision }],
  generationStore: new FileGenerationStore(generationFile),
  audit,
  callTimeoutMs: 10000,
  heartbeatTimeoutMs: 800,
  heartbeatSweepMs: 100,
});

function adaptSocket(socket) {
  return {
    get readyState() { return socket.readyState; },
    send(data) { socket.send(data); },
    close(code, reason) { socket.close(code, reason); },
    onMessage(handler) { socket.on('message', (data) => handler(data)); },
    onClose(handler) { socket.on('close', (code, reason) => handler(code, reason.toString())); },
    onError(handler) { socket.on('error', handler); },
  };
}

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch {
        // State may be between handshake transitions.
      }
      if (Date.now() >= deadline) {
        reject(new Error('timeout waiting for condition'));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function firstText(result) {
  return result?.content?.find?.((entry) => entry?.type === 'text')?.text ?? '';
}

const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(wsServer, 'listening');
const wsAddress = wsServer.address();
assert.equal(typeof wsAddress, 'object');
const gatewayUrl = `ws://127.0.0.1:${wsAddress.port}`;
wsServer.on('connection', (socket) => gateway.acceptSocket(adaptSocket(socket)));

const agent = new FleetAgent({
  gatewayUrl,
  controlRoot,
  stateDir: agentStateDir,
  hostname: 'YUAN',
  toolPolicy: createDedicatedTestFilePolicy(probeFile),
  policyWatchMs: 500,
  channel: {
    reconnectBaseMs: 20,
    reconnectMaxMs: 80,
    heartbeatMs: 50,
    heartbeatTimeoutMs: 700,
    callTimeoutMs: 10000,
    random: () => 0.5,
  },
});

const backend = new FleetGatewayPluginBackend({
  gateway,
  probes: [{ projectId: 'network.ikuai', hostname: 'YUAN', path: probeFile }],
  callTimeoutMs: 10000,
  maxWriteBytes: 4096,
});
const httpServer = createFleetPluginHttpServer(backend);
httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const httpAddress = httpServer.address();
assert.equal(typeof httpAddress, 'object');
const baseUrl = `http://127.0.0.1:${httpAddress.port}`;

let client = null;
try {
  await agent.start();
  await waitFor(() => gateway.deviceStatus('network.ikuai', 'YUAN').online);

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  client = new Client({ name: 'fleet-platform-test', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['fleet_status', 'list_devices', 'read_test_file', 'write_test_file'].sort(),
  );

  const status = await client.callTool({
    name: 'fleet_status',
    arguments: { project_id: 'network.ikuai', hostname: 'YUAN' },
  });
  assert.equal(status.isError, undefined);
  assert.match(firstText(status), /"online": true/);
  assert.match(firstText(status), /"exact_host": true/);

  const listed = await client.callTool({
    name: 'list_devices',
    arguments: { project_id: 'network.ikuai' },
  });
  assert.equal(listed.isError, undefined);
  assert.match(firstText(listed), /"hostname": "YUAN"/);

  const probe = `plus-personal-plugin-local-write-${Date.now()}`;
  const write = await client.callTool({
    name: 'write_test_file',
    arguments: { project_id: 'network.ikuai', hostname: 'YUAN', content: probe },
  });
  assert.equal(write.isError, undefined);
  assert.equal(await readFile(probeFile, 'utf8'), probe);

  const read = await client.callTool({
    name: 'read_test_file',
    arguments: { project_id: 'network.ikuai', hostname: 'YUAN' },
  });
  assert.equal(read.isError, undefined);
  assert.match(firstText(read), new RegExp(probe));

  const wrongHost = await client.callTool({
    name: 'write_test_file',
    arguments: { project_id: 'network.ikuai', hostname: 'HEMA', content: 'must-not-write' },
  });
  assert.equal(wrongHost.isError, true);
  assert.equal(await readFile(probeFile, 'utf8'), probe);

  const callRecords = gateway.listCallRecords(10);
  assert(callRecords.length >= 2);
  assert(callRecords.some((record) => record.toolName === 'write_file' && record.status === 'completed'));
  assert(audit.events.some((event) => event.event === 'call_completed'));
  assert.equal(audit.events.some((event) => JSON.stringify(event).includes(probe)), false);

  console.log('fleet full local platform tests passed');
} finally {
  await client?.close().catch(() => undefined);
  await new Promise((resolve) => httpServer.close(resolve));
  await agent.stop().catch(() => undefined);
  await gateway.stop().catch(() => undefined);
  await new Promise((resolve) => wsServer.close(resolve));
  await rm(runtimeDir, { recursive: true, force: true });
}
