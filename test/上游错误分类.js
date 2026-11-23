import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createMcpTraceEdge } from '../dist/remote-device/fleet/mcp-trace-edge.js';
import { McpRequestTrace } from '../dist/remote-device/fleet/mcp-request-trace.js';

const events = [];
const originalInfo = console.info;
console.info = line => events.push(JSON.parse(line));
let connections = 0, requests = 0, disconnect = false;
const upstream = createServer({ keepAliveTimeout: 75_000 }, (req, res) => {
  requests++;
  req.resume();
  if (disconnect) { req.socket.destroy(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});
upstream.on('connection', () => connections++);
let edge;
try {
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  edge = createMcpTraceEdge(upstream.address().port, randomBytes(32));
  edge.listen(0, '127.0.0.1'); await once(edge, 'listening');
  const url = 'http://127.0.0.1:' + edge.address().port + '/mcp';
  const call = () => fetch(url, { method: 'POST', body: '{"marker":"private-request"}' });
  const first = await call(); assert.equal(first.status, 200); await first.json();
  await delay(40);
  const second = await call(); assert.equal(second.status, 200); await second.json();
  assert.equal(connections, 1, 'trace must describe an actually reused upstream connection');
  const secondId = second.headers.get('x-lcm-request-id');
  assert(events.some(x => x.requestId === secondId && x.stage === 'edge_upstream_socket' && x.reusedSocket === true));
  disconnect = true;
  const before = requests;
  const broken = await call(); assert.equal(broken.status, 502); await broken.text();
  await delay(30);
  assert.equal(requests, before + 1, 'a POST reset must never be replayed automatically');
  const failed = events.filter(x => x.requestId === broken.headers.get('x-lcm-request-id'));
  assert(failed.some(x => x.stage === 'edge_upstream_error' && x.errorCode === 'ECONNRESET'));
  assert(!failed.some(x => x.stage === 'edge_upstream_headers'));
  new McpRequestTrace().stage('edge_upstream_error', { errorCode: 'private-error-marker', reusedSocket: true });
  assert.equal(events.at(-1).errorCode, 'OTHER');
  assert(!JSON.stringify(events).includes('private-error-marker'));
  assert(!JSON.stringify(events).includes('private-request'));
  originalInfo(JSON.stringify({ status: 'PASS', cases: 6, idleMs: 40, agentLifetimeChanged: false, connectionsAfterTwoCalls: 1,
    automaticRetry: false, resetCodeRecorded: true, unknownErrorsRedacted: true }));
} finally {
  console.info = originalInfo;
  for (const server of [edge, upstream]) { server?.close(); server?.closeAllConnections?.(); }
}
