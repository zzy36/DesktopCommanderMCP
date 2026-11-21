import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer, request } from 'node:http';
import { createConnection, createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { FleetGateway } from '../dist/remote-device/fleet/fleet-gateway.js';
import { FleetGatewayPluginBackend } from '../dist/remote-device/fleet/gateway-plugin-backend.js';
import { fingerprintPublicKey, handshakePayload } from '../dist/remote-device/fleet/identity.js';
import { createMcpTraceEdge } from '../dist/remote-device/fleet/mcp-trace-edge.js';
import { createFleetOAuthPluginHttpServer } from '../dist/remote-device/fleet/oauth-plugin-server.js';
import { SingleUserOAuthProvider } from '../dist/remote-device/fleet/single-user-oauth.js';

const frpDir = process.env.LCM_TRACE_TEST_FRP_DIR;
const temp = await mkdtemp(join(tmpdir(), 'lcm-trace-test-'));
const servers = [];
const children = [];
const frpLogs = [];
const sockets = new Set();
const events = [];
const originalInfo = console.info;
const previousKey = process.env.LCM_MCP_TRACE_KEY;
const secret = randomBytes(32);
process.env.LCM_MCP_TRACE_KEY = secret.toString('hex');
const token = randomBytes(24).toString('hex');
const privateMarker = 'private-file-path-marker';
console.info = line => {
  if (typeof line !== 'string') return;
  const record = JSON.parse(line);
  if (record.event === 'lcm_mcp_trace') events.push(record);
};

async function listen(server, port = 0) {
  servers.push(server);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = tcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function mark(stage, requestId) {
  if (requestId) events.push({ stage, requestId, atMs: Date.now() });
}

function tap(stage, upstreamPort) {
  return httpServer((req, res) => {
    mark(stage, req.headers['x-lcm-request-id']);
    const outgoing = request({
      host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers,
    }, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    outgoing.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    res.on('close', () => { if (!res.writableFinished) outgoing.destroy(); });
    req.pipe(outgoing);
  });
}

async function runFrp(name, path) {
  const exe = join(frpDir, name + (process.platform === 'win32' ? '.exe' : ''));
  const child = spawn(exe, ['-c', path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', data => {
      frpLogs.push(name + ': ' + String(data).trim());
      if (frpLogs.length > 12) frpLogs.shift();
    });
  }
  await once(child, 'spawn');
}

function invoke(port, { bearer = token, signal, forgedId = randomUUID() } = {}) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', signal,
    headers: {
      authorization: 'Bearer ' + bearer, 'x-lcm-request-id': forgedId,
      'x-lcm-trace-proof': '0'.repeat(64), 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'get_file_info', arguments: { hostname: 'LAB', path: privateMarker },
    } }),
  });
}

const byId = id => events.filter(event => event.requestId === id);
const at = (records, stage) => records.find(record => record.stage === stage)?.atMs;
let gateway;
try {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  gateway = new FleetGateway({ devices: [{ hostname: 'LAB', publicKeyFingerprint: fingerprintPublicKey(publicKeyPem) }] });
  let acceptMessage;
  gateway.acceptSocket({
    readyState: 1, onClose() {}, close() {},
    onMessage(fn) { acceptMessage = fn; },
    send(raw) {
      const packet = JSON.parse(raw);
      if (packet.type === 'challenge') {
        const signature = sign(null, handshakePayload(packet.challenge, 'LAB', 'lab-v1'), keys.privateKey).toString('base64');
        queueMicrotask(() => acceptMessage(JSON.stringify({
          type: 'hello', hostname: 'LAB', publicKeyPem, signature, policyRevision: 'lab-v1',
        })));
      }
      if (packet.type === 'call') setImmediate(() => acceptMessage(JSON.stringify({
        type: 'result', callId: packet.callId, generation: packet.generation,
        ok: true, result: { content: [{ type: 'text', text: 'fixture readback' }] },
      })));
    },
  });
  const issuerUrl = new URL('http://127.0.0.1:9');
  const resourceUrl = new URL('/mcp', issuerUrl);
  const provider = new SingleUserOAuthProvider({ statePath: join(temp, 'oauth.json'), issuerUrl, resourceUrl });
  provider.verifyAccessToken = async supplied => {
    if (supplied !== token) throw new InvalidTokenError('fixture token rejected');
    return { token, clientId: 'lab-client', scopes: ['fleet:read'], resource: resourceUrl,
      expiresAt: Math.floor(Date.now() / 1000) + 60 };
  };
  const gatewayPort = await listen(createFleetOAuthPluginHttpServer({
    backend: new FleetGatewayPluginBackend({ gateway }), provider, issuerUrl, resourceUrl,
    approvalUrl: new URL('/approve', issuerUrl),
  }));
  const frpcOutput = await listen(tap('frpc_egress', gatewayPort));
  const frpsPort = frpDir ? await freePort() : frpcOutput;
  let hold = 0;
  const wan = await listen(tcpServer(client => {
    const server = createConnection({ host: '127.0.0.1', port: frpsPort });
    for (const socket of [client, server]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    }
    client.on('error', () => server.destroy());
    server.on('error', () => client.destroy());
    const source = frpDir ? server : client;
    const target = frpDir ? client : server;
    target.pipe(source);
    source.on('data', chunk => {
      if (!hold) return void target.write(chunk);
      source.pause();
      void delay(hold).then(() => {
        if (!target.destroyed) target.write(chunk);
        source.resume();
      });
    });
    client.on('close', () => server.destroy());
    server.on('close', () => client.end());
  }));
  const frpsProxy = frpDir ? await freePort() : wan;
  if (frpDir) {
    const [serverConfig, clientConfig] = ['frps.toml', 'frpc.toml'].map(name => join(temp, name));
    const frpToken = randomBytes(24).toString('hex');
    await writeFile(serverConfig, `bindAddr = "127.0.0.1"\nproxyBindAddr = "127.0.0.1"\nbindPort = ${frpsPort}\nauth.token = "${frpToken}"\ntransport.tcpMux = false\ntransport.maxPoolCount = 3\n`);
    await writeFile(clientConfig, `serverAddr = "127.0.0.1"\nserverPort = ${wan}\nauth.token = "${frpToken}"\ntransport.tcpMux = false\ntransport.poolCount = 3\n[[proxies]]\nname = "trace-test"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = ${frpcOutput}\nremotePort = ${frpsProxy}\ntransport.useCompression = true\n`);
    await runFrp('frps', serverConfig);
    const startupDeadline = Date.now() + 8000;
    while (!frpLogs.some(line => line.includes('frps started successfully'))) {
      assert(Date.now() < startupDeadline, 'frps did not start: ' + frpLogs.join('\n'));
      await delay(50);
    }
    await runFrp('frpc', clientConfig);
  }
  const frpsInput = await listen(tap('frps_ingress', frpsProxy));
  const edgePort = await listen(createMcpTraceEdge(frpsInput, secret));
  const deadline = Date.now() + 5000;
  while (true) {
    const probe = await fetch(`http://127.0.0.1:${edgePort}/readyz`);
    await probe.text();
    if (probe.ok) break;
    assert(Date.now() < deadline, 'loopback FRP failed to become ready: ' + frpLogs.join('\n'));
    await delay(50);
  }

  const spoofed = randomUUID();
  const ordinary = await invoke(edgePort, { forgedId: spoofed });
  assert.equal(ordinary.status, 200);
  assert.match(await ordinary.text(), /fixture readback/);
  const id = ordinary.headers.get('x-lcm-request-id');
  assert(id && id !== spoofed);
  assert.equal(ordinary.headers.get('x-lcm-trace-proof'), null);
  const stages = byId(id);
  for (const stage of ['edge_received','edge_forwarded','frps_ingress','frpc_egress','gateway_received',
    'gateway_authenticated','dispatch','receipt','gateway_response','edge_response']) {
    assert(at(stages, stage) !== undefined, stage);
  }
  assert.equal(stages.find(event => event.stage === 'gateway_received').source, 'verified_edge');
  assert.equal(stages.find(event => event.stage === 'gateway_authenticated').rpcMethod, 'tools/call');

  hold = 220;
  const slow = await invoke(edgePort);
  assert.match(await slow.text(), /fixture readback/);
  const delayed = byId(slow.headers.get('x-lcm-request-id'));
  hold = 0;
  const slowWan = at(delayed,'frpc_egress') - at(delayed,'frps_ingress');
  assert(slowWan >= 180, 'the test delay must be observed between the FRP endpoints');
  assert(at(delayed,'dispatch') - at(delayed,'gateway_received') < slowWan, 'delay must precede gateway dispatch');

  const unauthenticated = await invoke(edgePort, { bearer: 'bad-token' });
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.text();
  const denied = byId(unauthenticated.headers.get('x-lcm-request-id'));
  assert(at(denied, 'gateway_received') !== undefined);
  assert.equal(at(denied, 'dispatch'), undefined);

  const direct = await invoke(gatewayPort, { forgedId: spoofed });
  assert.equal(direct.status, 200);
  await direct.text();
  const localId = direct.headers.get('x-lcm-request-id');
  assert(localId && localId !== spoofed);
  assert.equal(byId(localId).find(event => event.stage === 'gateway_received').source, 'gateway');
  const recorded = JSON.stringify(events);
  assert(!recorded.includes(token) && !recorded.includes(privateMarker) && !recorded.includes(spoofed));
  originalInfo(JSON.stringify({ isolated: true, realFrp: Boolean(frpDir),
    normalFrpMs: at(stages,'frpc_egress') - at(stages,'frps_ingress'), injectedFrpMs: slowWan,
    gatewayToDispatchMs: at(delayed,'dispatch') - at(delayed,'gateway_received'),
    dispatchToReceiptMs: at(delayed,'receipt') - at(delayed,'dispatch'), checks: 'correlation, delay, denial, spoofing, privacy' }));
} finally {
  console.info = originalInfo;
  if (previousKey === undefined) delete process.env.LCM_MCP_TRACE_KEY;
  else process.env.LCM_MCP_TRACE_KEY = previousKey;
  for (const child of children) child.kill();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) {
    server.close();
    server.closeAllConnections?.();
  }
  await gateway?.stop();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
