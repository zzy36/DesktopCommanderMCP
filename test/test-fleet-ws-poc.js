import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  canonicalHostname,
  fingerprintPublicKey,
  handshakePayload,
  verifyChallengeSignature,
} from '../dist/remote-device/fleet/identity.js';
import { FleetRouter } from '../dist/remote-device/fleet/router.js';

const POLICY = 'control@8080d685';

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function expectCode(code, fn) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

const yuanKey = makeKeyPair();
const hemaKey = makeKeyPair();
const router = new FleetRouter(
  [
    { hostname: 'YUAN', publicKeyFingerprint: fingerprintPublicKey(yuanKey.publicPem) },
    { hostname: 'HEMA', publicKeyFingerprint: fingerprintPublicKey(hemaKey.publicPem) },
  ],
  [
    { projectId: 'network.ikuai', hostname: 'YUAN', policyRevision: POLICY },
    { projectId: 'commerce.demo', hostname: 'HEMA', policyRevision: POLICY },
  ],
);

const sockets = new Map();
const pending = new Map();
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
const address = server.address();
assert.equal(typeof address, 'object');
const url = `ws://127.0.0.1:${address.port}`;

server.on('connection', (socket) => {
  const sessionId = randomUUID();
  const challenge = randomBytes(32).toString('base64');
  let registered = null;

  socket.send(JSON.stringify({ type: 'challenge', challenge }));

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());

    if (message.type === 'hello') {
      const payload = handshakePayload(challenge, message.hostname, message.policyRevision);
      if (!verifyChallengeSignature(message.publicKeyPem, payload, message.signature)) {
        socket.send(JSON.stringify({ type: 'rejected', code: 'IDENTITY_MISMATCH' }));
        socket.close(4003, 'identity mismatch');
        return;
      }

      try {
        registered = router.registerAgent({
          sessionId,
          hostname: message.hostname,
          publicKeyFingerprint: fingerprintPublicKey(message.publicKeyPem),
          policyRevision: message.policyRevision,
          connectedAtMs: Date.now(),
        });
        sockets.set(sessionId, socket);
        socket.send(JSON.stringify({ type: 'accepted', sessionId }));
      } catch (error) {
        socket.send(JSON.stringify({ type: 'rejected', code: error.code ?? 'IDENTITY_MISMATCH' }));
        socket.close(4003, 'identity mismatch');
      }
      return;
    }

    if (message.type === 'result') {
      pending.get(message.callId)?.(message);
      pending.delete(message.callId);
    }
  });

  socket.on('close', () => {
    sockets.delete(sessionId);
    if (registered) router.unregisterAgent(registered.hostname, sessionId);
  });
});

async function connectAgent({ hostname, key, policyRevision = POLICY, localAuthorize = () => true }) {
  const socket = new WebSocket(url);
  const canonical = canonicalHostname(hostname);

  const ready = new Promise((resolve, reject) => {
    socket.on('message', async (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'challenge') {
        const payload = handshakePayload(message.challenge, canonical, policyRevision);
        const signature = sign(null, payload, key.privateKey).toString('base64');
        socket.send(JSON.stringify({
          type: 'hello',
          hostname: canonical,
          policyRevision,
          publicKeyPem: key.publicPem,
          signature,
        }));
        return;
      }

      if (message.type === 'accepted') {
        resolve({ socket, sessionId: message.sessionId });
        return;
      }

      if (message.type === 'rejected') {
        const error = new Error(message.code);
        error.code = message.code;
        reject(error);
        return;
      }

      if (message.type === 'call') {
        if (canonicalHostname(message.hostname) !== canonical || !localAuthorize(message.projectId, canonical)) {
          socket.send(JSON.stringify({
            type: 'result', callId: message.callId, ok: false,
            code: 'PROJECT_DEVICE_DENIED',
          }));
          return;
        }
        socket.send(JSON.stringify({
          type: 'result', callId: message.callId, ok: true,
          result: { host: canonical, tool: message.toolName, projectId: message.projectId },
        }));
      }
    });
    socket.once('error', reject);
  });

  return ready;
}

async function closeAgent(agent) {
  if (!agent || agent.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(agent.socket, 'close');
  agent.socket.close(1000, 'test complete');
  await closed;
  // Client close can precede the gateway's close callback by one event-loop turn.
  // Wait until the server has removed this exact session before making routing assertions.
  for (let i = 0; i < 50 && sockets.has(agent.sessionId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(sockets.has(agent.sessionId), false, 'gateway did not unregister closed session');
}

async function dispatch(projectId, hostname, toolName = 'ping') {
  const target = router.resolve(projectId, hostname);
  const socket = sockets.get(target.sessionId);
  assert(socket, `missing socket for ${target.sessionId}`);
  const callId = randomUUID();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`call ${callId} timed out`));
    }, 2000);
    pending.set(callId, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  socket.send(JSON.stringify({ type: 'call', callId, projectId, hostname, toolName, args: {} }));
  return result;
}

const hema = await connectAgent({ hostname: 'HEMA', key: hemaKey });
expectCode('TARGET_OFFLINE', () => router.resolve('network.ikuai', 'YUAN'));

await assert.rejects(
  connectAgent({ hostname: 'YUAN', key: hemaKey }),
  (error) => error?.code === 'IDENTITY_MISMATCH',
);

let yuan = await connectAgent({ hostname: 'yuan', key: yuanKey });
let result = await dispatch('network.ikuai', 'YUAN', 'get_config');
assert.equal(result.ok, true);
assert.equal(result.result.host, 'YUAN');
expectCode('PROJECT_DEVICE_DENIED', () => router.resolve('network.ikuai', 'HEMA'));

const duplicateYuan = await connectAgent({ hostname: 'YUAN', key: yuanKey });
expectCode('TARGET_AMBIGUOUS', () => router.resolve('network.ikuai', 'YUAN'));
await closeAgent(duplicateYuan);
assert.equal(router.resolve('network.ikuai', 'YUAN').sessionId, yuan.sessionId);

await closeAgent(yuan);
yuan = await connectAgent({ hostname: 'YUAN', key: yuanKey, policyRevision: 'control@stale' });
expectCode('POLICY_SKEW', () => router.resolve('network.ikuai', 'YUAN'));
await closeAgent(yuan);

yuan = await connectAgent({
  hostname: 'YUAN', key: yuanKey,
  localAuthorize: (projectId) => projectId !== 'network.ikuai',
});
result = await dispatch('network.ikuai', 'YUAN', 'get_config');
assert.equal(result.ok, false);
assert.equal(result.code, 'PROJECT_DEVICE_DENIED');

await closeAgent(yuan);
await closeAgent(hema);
await new Promise((resolve) => server.close(resolve));
console.log('fleet websocket PoC tests passed');
