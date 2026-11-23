import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createMcpTraceEdge } from '../dist/remote-device/fleet/mcp-trace-edge.js';

const events = [];
const originalInfo = console.info;
console.info = line => { const event = JSON.parse(line); if (event.event === 'lcm_mcp_trace') events.push(event); };
const prefix = '中文 response 😀 ';
const suffix = 'private-body-marker:' + 'x'.repeat(65536);
const expected = prefix + suffix;
let abortUpstream = false;
const upstream = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-private-marker': 'private-header-marker' });
  res.write(Buffer.from(prefix));
  if (abortUpstream) { setTimeout(() => res.destroy(), 40); return; }
  setTimeout(() => res.end(suffix), 80);
});
let actualEdge;
try {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  actualEdge = createMcpTraceEdge(upstream.address().port, randomBytes(32));
  actualEdge.listen(0, '127.0.0.1');
  await once(actualEdge, 'listening');
  const url = 'http://127.0.0.1:' + actualEdge.address().port;
  const response = await fetch(url + '/mcp', { method: 'POST',
    headers: { authorization: 'Bearer private-token-marker', 'content-type': 'application/json' },
    body: '{"private-request-marker":true}' });
  assert.equal(await response.text(), expected, 'stream bytes and Unicode must survive');
  await delay(15);
  const id = response.headers.get('x-lcm-request-id');
  const rows = events.filter(event => event.requestId === id);
  const stage = name => rows.find(event => event.stage === name);
  for (const name of ['edge_received', 'edge_forwarded', 'edge_upstream_headers',
    'edge_upstream_first_byte', 'edge_upstream_end', 'edge_response']) assert(stage(name), name);
  assert.equal(stage('edge_response').status, 200);
  assert.equal(stage('edge_upstream_end').upstreamBytes, Buffer.byteLength(expected));
  assert.equal(stage('edge_response').upstreamBytes, Buffer.byteLength(expected));
  assert(stage('edge_upstream_end').elapsedMs - stage('edge_upstream_first_byte').elapsedMs >= 50);
  const count = events.length;
  const health = await fetch(url + '/healthz');
  await health.text();
  await delay(10);
  assert.equal(events.length, count, 'only MCP POSTs should acquire trace data');
  abortUpstream = true;
  const aborted = await fetch(url + '/mcp', { method: 'POST', body: '{}' });
  await assert.rejects(aborted.text());
  await delay(30);
  const abortRows = events.filter(event => event.requestId === aborted.headers.get('x-lcm-request-id'));
  assert(abortRows.some(event => event.stage === 'edge_upstream_aborted'));
  assert(abortRows.some(event => event.stage === 'edge_closed'));
  assert(!abortRows.some(event => event.stage === 'edge_response'));
  const serialized = JSON.stringify(events);
  for (const marker of ['private-body-marker', 'private-header-marker', 'private-token-marker', 'private-request-marker']) {
    assert(!serialized.includes(marker), 'trace must omit request/response content and credentials');
  }
  assert(events.every(event => !Object.hasOwn(event, 'upstreamBytes')
    || Number.isSafeInteger(event.upstreamBytes) && event.upstreamBytes >= 0));
  originalInfo(JSON.stringify({ status: 'PASS', cases: 8, observedBodyBytes: Buffer.byteLength(expected),
    streamPreserved: true, firstByteAndEndSeparated: true, abortDistinguished: true, contentNotLogged: true }));
} finally {
  console.info = originalInfo;
  for (const server of [actualEdge, upstream]) {
    server?.close();
    server?.closeAllConnections?.();
  }
}
