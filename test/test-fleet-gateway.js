import assert from 'node:assert/strict';
import { once } from 'node:events';
import { sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { MemoryAuditSink } from '../dist/remote-device/fleet/audit-log.js';
import { ControlPolicyAuthorizer } from '../dist/remote-device/fleet/control-policy.js';
import { DeviceIdentityStore } from '../dist/remote-device/fleet/device-identity.js';
import { FleetAgent, createDedicatedTestFilePolicy } from '../dist/remote-device/fleet/fleet-agent.js';
import { FleetGateway } from '../dist/remote-device/fleet/fleet-gateway.js';
import { FileGenerationStore } from '../dist/remote-device/fleet/gateway-state.js';
import { handshakePayload } from '../dist/remote-device/fleet/identity.js';

const controlRoot = process.env.FLEET_TEST_CONTROL_ROOT;
assert(controlRoot, 'FLEET_TEST_CONTROL_ROOT is required');

const runtimeDir = await mkdtemp(join(tmpdir(), 'fleet-gateway-runtime-'));
const agentStateDir = join(runtimeDir, 'agent-state');
const probeFile = join(runtimeDir, 'probe.txt');
const generationFile = join(runtimeDir, 'gateway-generations.json');

const policyAuthorizer = new ControlPolicyAuthorizer({ controlRoot });
const policyRevision = await policyAuthorizer.policyRevision();
await policyAuthorizer.stop();

const identityStore = new DeviceIdentityStore({ stateDir: agentStateDir });
const identity = await identityStore.loadOrCreate('YUAN');
const audit = new MemoryAuditSink();
const generationStore = () => new FileGenerationStore(generationFile);

function createGateway() {
  return new FleetGateway({
    devices: [{ hostname: 'YUAN', publicKeyFingerprint: identity.publicKeyFingerprint }],
    projects: [{ projectId: 'network.ikuai', hostname: 'YUAN', policyRevision }],
    generationStore: generationStore(),
    audit,
    callTimeoutMs: 10000,
    heartbeatTimeoutMs: 700,
    heartbeatSweepMs: 100,
  });
}

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
        // Keep polling while the target is moving between sessions.
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

const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(wsServer, 'listening');
const address = wsServer.address();
assert.equal(typeof address, 'object');
const gatewayUrl = `ws://127.0.0.1:${address.port}`;
let currentGateway = createGateway();

wsServer.on('connection', (socket) => {
  if (!currentGateway) {
    socket.close(1013, 'gateway restarting');
    return;
  }
  try {
    currentGateway.acceptSocket(adaptSocket(socket));
  } catch {
    socket.close(1013, 'gateway unavailable');
  }
});

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
    heartbeatTimeoutMs: 600,
    callTimeoutMs: 10000,
    random: () => 0.5,
  },
});

async function connectDuplicateAgent() {
  const socket = new WebSocket(gatewayUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('duplicate agent test timed out'));
    }, 3000);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'challenge') {
        const payload = handshakePayload(message.challenge, 'YUAN', policyRevision);
        socket.send(JSON.stringify({
          type: 'hello',
          hostname: 'YUAN',
          policyRevision,
          publicKeyPem: identity.publicKeyPem,
          signature: sign(null, payload, identity.privateKeyPem).toString('base64'),
        }));
        return;
      }
      if (message.type === 'rejected') {
        clearTimeout(timer);
        resolve({ socket, message });
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

try {
  await agent.start();
  await waitFor(() => currentGateway.deviceStatus('network.ikuai', 'YUAN').online);
  const firstStatus = currentGateway.deviceStatus('network.ikuai', 'YUAN');
  assert.equal(firstStatus.online, true);
  assert.equal(firstStatus.policyRevision, policyRevision);
  assert(Number.isSafeInteger(firstStatus.generation));

  const probe = `fleet-gateway-write-ok-${Date.now()}`;
  await currentGateway.dispatch('network.ikuai', 'YUAN', 'write_file', {
    path: probeFile,
    content: probe,
    mode: 'rewrite',
  });
  assert.equal(await readFile(probeFile, 'utf8'), probe);

  const readResult = await currentGateway.dispatch('network.ikuai', 'YUAN', 'read_file', { path: probeFile });
  const readText = readResult?.content?.find?.((entry) => entry?.type === 'text')?.text ?? '';
  assert.match(readText, new RegExp(probe));

  await assert.rejects(
    currentGateway.dispatchMachine('YUAN', 'read_file', { path: probeFile }),
    (error) => error?.code === 'PROJECT_DEVICE_DENIED',
  );
  const machineRead = await currentGateway.dispatchMachine('YUAN', 'read_file', { path: probeFile }, true);
  const machineReadText = machineRead?.content?.find?.((entry) => entry?.type === 'text')?.text ?? '';
  assert.match(machineReadText, new RegExp(probe));
  await assert.rejects(
    currentGateway.dispatchMachine('HEMA', 'read_file', { path: probeFile }, true),
    (error) => error?.code === 'PROJECT_DEVICE_DENIED',
  );

  const completed = currentGateway.listCallRecords(10);
  assert(completed.length >= 2);
  assert.equal(completed.every((record) => record.status === 'completed'), true);

  await assert.rejects(
    currentGateway.dispatch('network.ikuai', 'HEMA', 'read_file', { path: probeFile }),
    (error) => error?.code === 'PROJECT_DEVICE_DENIED',
  );
  await assert.rejects(
    currentGateway.dispatch('commerce.meta', 'YUAN', 'read_file', { path: probeFile }),
    (error) => error?.code === 'PROJECT_DEVICE_DENIED',
  );

  const duplicate = await connectDuplicateAgent();
  assert.equal(duplicate.message.code, 'TARGET_AMBIGUOUS');
  duplicate.socket.close(1000, 'duplicate test complete');
  assert.equal(currentGateway.deviceStatus('network.ikuai', 'YUAN').online, true);

  const firstGeneration = firstStatus.generation;
  const oldGateway = currentGateway;
  currentGateway = null;
  await oldGateway.stop();

  currentGateway = createGateway();
  await waitFor(() => currentGateway.deviceStatus('network.ikuai', 'YUAN').online, 7000);
  const secondStatus = currentGateway.deviceStatus('network.ikuai', 'YUAN');
  assert(secondStatus.generation > firstGeneration, 'generation must survive gateway restart');
  assert.equal(agent.getState().publicKeyFingerprint, identity.publicKeyFingerprint);

  const persisted = JSON.parse(await readFile(generationFile, 'utf8'));
  assert.equal(persisted.generations.YUAN, secondStatus.generation);

  const afterRestart = await currentGateway.dispatch('network.ikuai', 'YUAN', 'read_file', { path: probeFile });
  const restartText = afterRestart?.content?.find?.((entry) => entry?.type === 'text')?.text ?? '';
  assert.match(restartText, new RegExp(probe));

  assert(audit.events.some((event) => event.event === 'session_authenticated'));
  assert(audit.events.some((event) => event.event === 'session_ambiguous' && event.code === 'TARGET_AMBIGUOUS'));
  assert(audit.events.some((event) => event.event === 'call_completed'));
  assert.equal(audit.events.some((event) => JSON.stringify(event).includes(probe)), false, 'audit must not contain file content');

  console.log('fleet gateway control-plane tests passed');
} finally {
  await agent.stop().catch(() => undefined);
  if (currentGateway) await currentGateway.stop().catch(() => undefined);
  await new Promise((resolve) => wsServer.close(resolve));
  await rm(runtimeDir, { recursive: true, force: true });
}
