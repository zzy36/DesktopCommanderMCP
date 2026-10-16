import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  fingerprintPublicKey,
  handshakePayload,
  verifyChallengeSignature,
} from '../dist/remote-device/fleet/identity.js';
import { MAX_FLEET_FRAME_BYTES } from '../dist/remote-device/fleet/wire-limits.js';
import { FleetChannel } from '../dist/remote-device/fleet/fleet-channel.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = fingerprintPublicKey(publicKeyPem);
const POLICY = 'control@fleet-channel-test';

const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_FLEET_FRAME_BYTES });
await once(server, 'listening');
const address = server.address();
assert.equal(typeof address, 'object');
const url = `ws://127.0.0.1:${address.port}`;

let generation = 0;
let activeSocket = null;
let heartbeatCount = 0;
const resultWaiters = new Map();
const acceptedWaiters = [];

function waitForResult(callId, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resultWaiters.delete(callId);
      reject(new Error(`timeout waiting for ${callId}`));
    }, timeoutMs);
    resultWaiters.set(callId, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timeout waiting for condition');
}

function waitForAccepted(timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for accepted')), timeoutMs);
    acceptedWaiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function sendCall({ callId = randomUUID(), scopeKind = 'project', projectId = 'network.ikuai', machineApproval = false, hostname = 'YUAN', toolName = 'echo', args = {}, generationOverride } = {}) {
  assert(activeSocket, 'no active socket');
  const result = waitForResult(callId);
  activeSocket.send(JSON.stringify({
    type: 'call',
    callId,
    scopeKind,
    projectId,
    machineApproval,
    hostname,
    toolName,
    args,
    generation: generationOverride ?? generation,
  }));
  return { callId, result };
}

server.on('connection', (socket) => {
  activeSocket = socket;
  const challenge = randomBytes(32).toString('base64');
  socket.send(JSON.stringify({ type: 'challenge', challenge }));

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'hello') {
      assert.equal(message.hostname, 'YUAN');
      assert.equal(message.policyRevision, POLICY);
      assert.equal(fingerprintPublicKey(message.publicKeyPem), fingerprint);
      assert.equal(
        verifyChallengeSignature(
          message.publicKeyPem,
          handshakePayload(challenge, message.hostname, message.policyRevision),
          message.signature,
        ),
        true,
      );
      generation += 1;
      socket.send(JSON.stringify({ type: 'accepted', sessionId: randomUUID(), generation }));
      acceptedWaiters.splice(0).forEach((resolve) => resolve(generation));
      return;
    }
    if (message.type === 'heartbeat') {
      heartbeatCount += 1;
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

const channel = new FleetChannel({
  url,
  hostname: 'yuan',
  policyRevision: POLICY,
  publicKeyPem,
  privateKey,
  reconnectBaseMs: 20,
  reconnectMaxMs: 50,
  heartbeatMs: 20,
  heartbeatTimeoutMs: 250,
  callTimeoutMs: 500,
  random: () => 0.5,
  authorize: (projectId, hostname) => projectId === 'network.ikuai' && hostname === 'YUAN',
  authorizeMachine: (hostname, explicitAuthorization) => hostname === 'YUAN' && explicitAuthorization === true,
  execute: async (toolName, args, context) => {
    if (toolName === 'large') return { text: '\u84dd'.repeat(args.characters) };
    if (toolName === 'echo') return { args, generation: context.generation };
    if (toolName === 'wait') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        context.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(context.signal.reason ?? new Error('aborted'));
        }, { once: true });
      });
      return { finished: true };
    }
    throw new Error(`unsupported tool ${toolName}`);
  },
});

const firstAccepted = waitForAccepted();
channel.start();
assert.equal(await firstAccepted, 1);
await waitFor(() => channel.getState().authenticated);
assert.equal(channel.getState().authenticated, true);
assert.equal(channel.getState().hostname, 'YUAN');

let call = sendCall({ args: { value: 42 } });
let result = await call.result;
assert.equal(result.ok, true);
assert.equal(result.result.args.value, 42);
assert.equal(result.result.generation, generation);
const duplicateCallId = call.callId;
// Real WebSocket: the old 1 MiB boundary must no longer disconnect the session.
const payloadGeneration = generation;
call = sendCall({ toolName: 'large', args: { characters: 700000 } });
result = await call.result;
assert.equal(result.ok, true);
assert.equal(Buffer.byteLength(result.result.text), 2100000);
call = sendCall({ toolName: 'large', args: { characters: Math.ceil(MAX_FLEET_FRAME_BYTES / 3) } });
result = await call.result;
assert.equal(result.ok, false);
assert.equal(result.code, 'RESULT_TOO_LARGE');
const oversizedCallId = call.callId;
call = sendCall({ callId: oversizedCallId, args: { value: 'must not execute again' } });
assert.equal((await call.result).code, 'RESULT_TOO_LARGE');
call = sendCall({ args: { after: 'oversized' } });
assert.equal((await call.result).result.args.after, 'oversized');
assert.equal(generation, payloadGeneration);
assert.equal(channel.getState().inFlight, 0);


call = sendCall({ scopeKind: 'machine_control', projectId: null, machineApproval: false });
result = await call.result;
assert.equal(result.ok, false);
assert.equal(result.code, 'PROJECT_DEVICE_DENIED');

call = sendCall({ scopeKind: 'machine_control', projectId: null, machineApproval: true, args: { lane: 'machine' } });
result = await call.result;
assert.equal(result.ok, true);
assert.equal(result.result.args.lane, 'machine');

const duplicate = sendCall({ callId: duplicateCallId, args: { value: 999 } });
result = await duplicate.result;
assert.equal(result.ok, true);
assert.equal(result.result.args.value, 42, 'duplicate call must replay cached result');

call = sendCall({ generationOverride: generation - 1 });
result = await call.result;
assert.equal(result.ok, false);
assert.equal(result.code, 'FENCED_SESSION');

call = sendCall({ hostname: 'HEMA' });
result = await call.result;
assert.equal(result.ok, false);
assert.equal(result.code, 'PROJECT_DEVICE_DENIED');

call = sendCall({ toolName: 'wait' });
setTimeout(() => {
  activeSocket?.send(JSON.stringify({ type: 'cancel', callId: call.callId, generation }));
}, 30);
result = await call.result;
assert.equal(result.ok, false);
assert.equal(result.code, 'CALL_CANCELED_OR_TIMED_OUT');

await new Promise((resolve) => setTimeout(resolve, 80));
assert(heartbeatCount > 0, 'expected application heartbeat traffic');

const beforeReconnectGeneration = generation;
const nextAccepted = waitForAccepted();
activeSocket.close(4010, 'force reconnect');
const newGeneration = await nextAccepted;
assert.equal(newGeneration, beforeReconnectGeneration + 1);
await waitFor(() => channel.getState().authenticated && channel.getState().generation === newGeneration);
assert.equal(channel.getState().authenticated, true);
assert.equal(channel.getState().generation, newGeneration);

call = sendCall({ args: { after: 'reconnect' } });
result = await call.result;
assert.equal(result.ok, true);
assert.equal(result.result.args.after, 'reconnect');

await channel.stop();
await new Promise((resolve) => server.close(resolve));

class StalledSocket extends EventTarget {
  readyState = 0;
  send() {}
  close() { this.readyState = 2; }
}

function makeStalledChannel(socketFactory, heartbeatTimeoutMs = 60) {
  return new FleetChannel({
    url: 'ws://stalled.invalid',
    hostname: 'YUAN',
    policyRevision: POLICY,
    publicKeyPem,
    privateKey,
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    heartbeatMs: 10,
    heartbeatTimeoutMs,
    callTimeoutMs: 100,
    random: () => 0.5,
    authorize: () => true,
    execute: async () => ({ ok: true }),
    socketFactory,
  });
}

const errorSockets = [];
const errorChannel = makeStalledChannel(() => {
  const socket = new StalledSocket();
  errorSockets.push(socket);
  return socket;
}, 500);
errorChannel.start();
assert.equal(errorSockets.length, 1);
errorSockets[0].dispatchEvent(new Event('error'));
await waitFor(() => errorSockets.length >= 2, 300);
await errorChannel.stop();

const deadlineSockets = [];
const deadlineChannel = makeStalledChannel(() => {
  const socket = new StalledSocket();
  deadlineSockets.push(socket);
  return socket;
}, 40);
deadlineChannel.start();
await waitFor(() => deadlineSockets.length >= 2, 300);
await deadlineChannel.stop();

console.log('fleet channel reliability tests passed');
