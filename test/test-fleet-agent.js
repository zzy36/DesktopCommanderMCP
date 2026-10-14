import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  fingerprintPublicKey,
  handshakePayload,
  verifyChallengeSignature,
} from '../dist/remote-device/fleet/identity.js';
import {
  FleetAgent,
  createDedicatedTestFilePolicy,
} from '../dist/remote-device/fleet/fleet-agent.js';

const controlRoot = process.env.FLEET_TEST_CONTROL_ROOT;
assert(controlRoot, 'FLEET_TEST_CONTROL_ROOT is required');

const stateDir = await mkdtemp(join(tmpdir(), 'fleet-agent-state-'));
const probeDir = await mkdtemp(join(tmpdir(), 'fleet-agent-probe-'));
const probeFile = join(probeDir, 'write-probe.txt');
const escapeFile = join(probeDir, 'escape.txt');

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
const address = server.address();
assert.equal(typeof address, 'object');
const gatewayUrl = `ws://127.0.0.1:${address.port}`;

let generation = 0;
let activeSocket = null;
let activeFingerprint = null;
const fingerprints = [];
const resultWaiters = new Map();
const acceptedWaiters = [];

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
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

function waitForAccepted(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for agent acceptance')), timeoutMs);
    acceptedWaiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function waitForResult(callId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resultWaiters.delete(callId);
      reject(new Error(`timeout waiting for result ${callId}`));
    }, timeoutMs);
    resultWaiters.set(callId, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function callAgent({ projectId = 'network.ikuai', hostname = 'YUAN', toolName, args = {}, generationOverride } = {}) {
  assert(activeSocket, 'no active Fleet Agent socket');
  const callId = randomUUID();
  const result = waitForResult(callId);
  activeSocket.send(JSON.stringify({
    type: 'call',
    callId,
    projectId,
    hostname,
    toolName,
    args,
    generation: generationOverride ?? generation,
  }));
  return result;
}

server.on('connection', (socket) => {
  activeSocket = socket;
  const challenge = randomBytes(32).toString('base64');
  socket.send(JSON.stringify({ type: 'challenge', challenge }));

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'hello') {
      assert.equal(message.hostname, 'YUAN');
      assert.equal(
        verifyChallengeSignature(
          message.publicKeyPem,
          handshakePayload(challenge, message.hostname, message.policyRevision),
          message.signature,
        ),
        true,
      );
      activeFingerprint = fingerprintPublicKey(message.publicKeyPem);
      fingerprints.push(activeFingerprint);
      generation += 1;
      socket.send(JSON.stringify({
        type: 'accepted',
        sessionId: randomUUID(),
        generation,
      }));
      acceptedWaiters.splice(0).forEach((resolve) => resolve({ generation, fingerprint: activeFingerprint }));
      return;
    }

    if (message.type === 'heartbeat') {
      socket.send(JSON.stringify({ type: 'heartbeat_ack', generation: message.generation }));
      return;
    }

    if (message.type === 'result') {
      resultWaiters.get(message.callId)?.(message);
      resultWaiters.delete(message.callId);
    }
  });

  socket.on('close', () => {
    if (activeSocket === socket) activeSocket = null;
  });
});

async function createAndStartAgent() {
  const agent = new FleetAgent({
    gatewayUrl,
    controlRoot,
    stateDir,
    hostname: 'YUAN',
    toolPolicy: createDedicatedTestFilePolicy(probeFile),
    policyWatchMs: 500,
    channel: {
      reconnectBaseMs: 20,
      reconnectMaxMs: 50,
      heartbeatMs: 50,
      heartbeatTimeoutMs: 500,
      callTimeoutMs: 10000,
      random: () => 0.5,
    },
  });
  const accepted = waitForAccepted();
  await agent.start();
  const acceptedInfo = await accepted;
  await waitFor(() => agent.getState().channel?.authenticated === true);
  return { agent, acceptedInfo };
}

try {
  let { agent, acceptedInfo } = await createAndStartAgent();
  assert.equal(agent.getState().hostname, 'YUAN');
  assert.match(agent.getState().policyRevision ?? '', /^control@[0-9a-f]{12}$/);
  assert.equal(agent.getState().publicKeyFingerprint, acceptedInfo.fingerprint);
  assert.equal(agent.getState().desktopReady, true);

  const originalPolicyRevision = agent.authorizer.policyRevision.bind(agent.authorizer);
  agent.authorizer.policyRevision = async () => {
    throw new Error('simulated transient policy revision failure');
  };
  await waitFor(() => agent.getState().channel === null);
  assert.equal(agent.getState().started, true, 'transient policy read failure must not kill the agent');
  const recovered = waitForAccepted();
  agent.authorizer.policyRevision = originalPolicyRevision;
  const recoveredInfo = await recovered;
  await waitFor(() => agent.getState().channel?.authenticated === true);
  assert.equal(recoveredInfo.fingerprint, acceptedInfo.fingerprint);

  const probe = `fleet-agent-write-ok-${randomUUID()}`;
  let result = await callAgent({
    toolName: 'write_file',
    args: { path: probeFile, content: probe, mode: 'rewrite' },
  });
  assert.equal(result.ok, true);
  assert.equal(await readFile(probeFile, 'utf8'), probe);

  result = await callAgent({
    toolName: 'read_file',
    args: { path: probeFile },
  });
  assert.equal(result.ok, true);
  const readText = result.result?.content?.find?.((entry) => entry?.type === 'text')?.text ?? '';
  assert.match(readText, new RegExp(probe));

  result = await callAgent({
    toolName: 'write_file',
    args: { path: escapeFile, content: 'must-not-write', mode: 'rewrite' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROJECT_DEVICE_DENIED');
  await assert.rejects(readFile(escapeFile, 'utf8'), (error) => error?.code === 'ENOENT');

  result = await callAgent({
    projectId: 'commerce.meta',
    toolName: 'write_file',
    args: { path: probeFile, content: 'must-not-write-commerce', mode: 'rewrite' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROJECT_DEVICE_DENIED');
  assert.equal(await readFile(probeFile, 'utf8'), probe);

  result = await callAgent({
    hostname: 'HEMA',
    toolName: 'write_file',
    args: { path: probeFile, content: 'must-not-write-hema', mode: 'rewrite' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROJECT_DEVICE_DENIED');
  assert.equal(await readFile(probeFile, 'utf8'), probe);

  const firstFingerprint = acceptedInfo.fingerprint;
  await agent.stop();
  await waitFor(() => activeSocket === null);

  ({ agent, acceptedInfo } = await createAndStartAgent());
  assert.equal(acceptedInfo.generation >= 2, true);
  assert.equal(acceptedInfo.fingerprint, firstFingerprint, 'service restart must retain device identity');
  assert.equal(fingerprints.at(-1), firstFingerprint);

  result = await callAgent({
    toolName: 'read_file',
    args: { path: probeFile },
  });
  assert.equal(result.ok, true);

  await agent.stop();
  await waitFor(() => activeSocket === null);

  const storedIdentity = JSON.parse(await readFile(join(stateDir, 'device-identity.json'), 'utf8'));
  assert.equal(storedIdentity.hostname, 'YUAN');
  assert.equal(storedIdentity.publicKeyFingerprint, firstFingerprint);

  console.log('fleet agent end-to-end tests passed');
} finally {
  for (const pending of resultWaiters.values()) pending({ ok: false, code: 'TEST_SHUTDOWN' });
  resultWaiters.clear();
  activeSocket?.close(1000, 'test cleanup');
  await new Promise((resolve) => server.close(resolve));
  await rm(stateDir, { recursive: true, force: true });
  await rm(probeDir, { recursive: true, force: true });
}
