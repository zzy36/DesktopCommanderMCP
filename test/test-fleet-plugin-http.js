import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  canonicalHostname,
  fingerprintPublicKey,
  handshakePayload,
  verifyChallengeSignature,
} from '../dist/remote-device/fleet/identity.js';
import { FleetRouter } from '../dist/remote-device/fleet/router.js';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';
import { createFleetPluginHttpServer } from '../dist/remote-device/fleet/plugin-server.js';

const PROJECT_ID = 'network.ikuai';
const HOSTNAME = 'YUAN';
const POLICY = 'control@plugin-poc';
const testRoot = join(tmpdir(), 'network-fleet-plugin-poc');
const testFile = join(testRoot, 'write-probe.txt');

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function firstText(result) {
  const item = result?.content?.find((entry) => entry?.type === 'text');
  return item?.text ?? '';
}

await rm(testRoot, { recursive: true, force: true });
await mkdir(testRoot, { recursive: true });

const yuanKey = makeKeyPair();
const router = new FleetRouter(
  [{ hostname: HOSTNAME, publicKeyFingerprint: fingerprintPublicKey(yuanKey.publicPem) }],
  [{ projectId: PROJECT_ID, hostname: HOSTNAME, policyRevision: POLICY }],
);

const sockets = new Map();
const pending = new Map();
const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(wsServer, 'listening');
const wsAddress = wsServer.address();
assert.equal(typeof wsAddress, 'object');
const wsUrl = `ws://127.0.0.1:${wsAddress.port}`;

wsServer.on('connection', (socket) => {
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
        socket.send(JSON.stringify({ type: 'rejected', code: error?.code ?? 'IDENTITY_MISMATCH' }));
        socket.close(4003, 'identity mismatch');
      }
      return;
    }

    if (message.type === 'result') {
      pending.get(message.callId)?.resolve(message);
      pending.delete(message.callId);
    }
  });

  socket.on('close', () => {
    sockets.delete(sessionId);
    if (registered) router.unregisterAgent(registered.hostname, sessionId);
  });
});

async function dispatch(projectId, hostname, toolName, args = {}) {
  const target = router.resolve(projectId, hostname);
  const socket = sockets.get(target.sessionId);
  assert(socket, `missing socket for ${target.sessionId}`);
  const callId = randomUUID();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`call ${callId} timed out`));
    }, 5000);
    pending.set(callId, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });
  socket.send(JSON.stringify({ type: 'call', callId, projectId, hostname, toolName, args }));
  return result;
}

const desktop = new DesktopCommanderIntegration();
await desktop.initialize();

async function connectYuanAgent() {
  const socket = new WebSocket(wsUrl);
  const ready = new Promise((resolve, reject) => {
    socket.on('message', async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'challenge') {
        const payload = handshakePayload(message.challenge, HOSTNAME, POLICY);
        socket.send(JSON.stringify({
          type: 'hello',
          hostname: HOSTNAME,
          policyRevision: POLICY,
          publicKeyPem: yuanKey.publicPem,
          signature: sign(null, payload, yuanKey.privateKey).toString('base64'),
        }));
        return;
      }
      if (message.type === 'accepted') {
        resolve({ socket, sessionId: message.sessionId });
        return;
      }
      if (message.type === 'rejected') {
        reject(Object.assign(new Error(message.code), { code: message.code }));
        return;
      }
      if (message.type !== 'call') return;

      if (message.projectId !== PROJECT_ID || canonicalHostname(message.hostname) !== HOSTNAME) {
        socket.send(JSON.stringify({
          type: 'result', callId: message.callId, ok: false, code: 'PROJECT_DEVICE_DENIED',
        }));
        return;
      }

      try {
        const result = await desktop.callClientTool(
          message.toolName,
          message.args ?? {},
          { project_id: message.projectId, fleet_plugin_poc: true },
        );
        socket.send(JSON.stringify({ type: 'result', callId: message.callId, ok: true, result }));
      } catch (error) {
        socket.send(JSON.stringify({
          type: 'result', callId: message.callId, ok: false,
          code: 'LOCAL_EXECUTION_FAILED', error: error?.message ?? String(error),
        }));
      }
    });
    socket.once('error', reject);
  });
  return ready;
}

const agent = await connectYuanAgent();

const backend = {
  async fleetStatus(projectId, hostname) {
    const target = router.resolve(projectId, hostname);
    return {
      project_id: projectId,
      hostname: target.hostname,
      online: true,
      exact_host: true,
      policy_revision: target.policyRevision,
    };
  },

  async listDevices(projectId) {
    if (projectId !== PROJECT_ID) {
      const error = new Error(`project ${projectId} is not authorized`);
      error.code = 'PROJECT_DEVICE_DENIED';
      throw error;
    }
    try {
      const target = router.resolve(PROJECT_ID, HOSTNAME);
      return [{ hostname: target.hostname, online: true, policyRevision: target.policyRevision }];
    } catch (error) {
      if (error?.code === 'TARGET_OFFLINE') return [{ hostname: HOSTNAME, online: false }];
      throw error;
    }
  },

  async readTestFile(projectId, hostname) {
    const response = await dispatch(projectId, hostname, 'read_file', { path: testFile });
    if (!response.ok) throw Object.assign(new Error(response.error ?? response.code), { code: response.code });
    return firstText(response.result);
  },

  async writeTestFile(projectId, hostname, content) {
    const response = await dispatch(projectId, hostname, 'write_file', {
      path: testFile,
      content,
      mode: 'rewrite',
    });
    if (!response.ok) throw Object.assign(new Error(response.error ?? response.code), { code: response.code });
    return { bytesWritten: Buffer.byteLength(content, 'utf8') };
  },
};

const httpServer = createFleetPluginHttpServer(backend);
httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const httpAddress = httpServer.address();
assert.equal(typeof httpAddress, 'object');
const baseUrl = `http://127.0.0.1:${httpAddress.port}`;

const health = await fetch(`${baseUrl}/healthz`);
assert.equal(health.status, 200);
assert.equal((await health.json()).ok, true);

const client = new Client({ name: 'fleet-plugin-poc-client', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
await client.connect(transport);

const listed = await client.listTools();
assert.deepEqual(
  listed.tools.map((tool) => tool.name).sort(),
  ['fleet_status', 'list_devices', 'read_test_file', 'write_test_file'].sort(),
);

const status = await client.callTool({
  name: 'fleet_status',
  arguments: { project_id: PROJECT_ID, hostname: HOSTNAME },
});
assert.equal(status.isError, undefined);
assert.match(firstText(status), /"online": true/);

const probe = `fleet-plugin-write-ok-${randomUUID()}`;
const writeResult = await client.callTool({
  name: 'write_test_file',
  arguments: { project_id: PROJECT_ID, hostname: HOSTNAME, content: probe },
});
assert.equal(writeResult.isError, undefined);
assert.equal(await readFile(testFile, 'utf8'), probe);

const readResult = await client.callTool({
  name: 'read_test_file',
  arguments: { project_id: PROJECT_ID, hostname: HOSTNAME },
});
assert.equal(readResult.isError, undefined);
assert.match(firstText(readResult), new RegExp(probe));

const wrongHost = await client.callTool({
  name: 'write_test_file',
  arguments: { project_id: PROJECT_ID, hostname: 'HEMA', content: 'must-not-write' },
});
assert.equal(wrongHost.isError, true);
assert.equal(await readFile(testFile, 'utf8'), probe);

await client.close();
await new Promise((resolve) => httpServer.close(resolve));
agent.socket.close(1000, 'test complete');
await once(agent.socket, 'close');
for (let i = 0; i < 50 && sockets.has(agent.sessionId); i++) {
  await new Promise((resolve) => setTimeout(resolve, 2));
}
await desktop.shutdown();
await new Promise((resolve) => wsServer.close(resolve));
await rm(testRoot, { recursive: true, force: true });

console.log('fleet plugin HTTP write PoC passed');
