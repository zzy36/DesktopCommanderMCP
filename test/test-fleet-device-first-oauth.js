import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFleetOAuthPluginHttpServer } from '../dist/remote-device/fleet/oauth-plugin-server.js';
import { SingleUserOAuthProvider } from '../dist/remote-device/fleet/single-user-oauth.js';

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

const stateDir = await mkdtemp(join(tmpdir(), 'lcm-device-first-oauth-'));
const statePath = join(stateDir, 'oauth-state.json');
const port = await freePort();
const issuerUrl = new URL(`http://127.0.0.1:${port}/`);
const resourceUrl = new URL('/mcp', issuerUrl);
const provider = new SingleUserOAuthProvider({ statePath, issuerUrl, resourceUrl });
const calls = [];
const backend = {
  async fleetStatus(_legacy, hostname) { return { hostname, online: true, exact_host: true }; },
  async listDevices() { return [{ hostname: 'YUAN', online: true }, { hostname: 'HEMA', online: false }]; },
  async ping(_legacy, hostname) { return { pong: true, hostname, round_trip_ms: 1 }; },
  async whoAmI() { return { product: 'Local Control MCP', hosted: false, model: 'owner-scoped device transport', governance: 'external target policy', automatic_device_fallback: false }; },
  async getToolResult(_legacy, hostname, callId) { return { hostname, callId, status: 'completed' }; },
  async listRemoteToolCalls() { return []; },
  async usageStats() { return { calls: calls.length, in_flight: 0 }; },
  async callDeviceTool(hostname, toolName, args) {
    calls.push({ hostname, toolName, args });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, hostname, toolName }) }] };
  },
};
const server = createFleetOAuthPluginHttpServer({
  backend,
  provider,
  issuerUrl,
  resourceUrl,
  approvalUrl: new URL('http://127.0.0.1:9/oauth/local-approve'),
});
server.listen(port, '127.0.0.1');
await once(server, 'listening');

async function registerClient() {
  const response = await fetch(new URL('/register', issuerUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['http://127.0.0.1:17891/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'LCM Device-first OAuth Test',
      scope: 'fleet:read fleet:write offline_access',
    }),
  });
  assert.equal(response.status, 201);
  const client = await response.json();
  assert(client.client_id);
  return client;
}

async function authorize(client, scopes) {
  const verifier = randomBytes(40).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const url = new URL('/authorize', issuerUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('redirect_uri', client.redirect_uris[0]);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('resource', resourceUrl.href);
  const auth = await fetch(url, { redirect: 'manual' });
  assert.equal(auth.status, 302);
  const approval = new URL(auth.headers.get('location'), issuerUrl);
  const requestId = approval.searchParams.get('request_id');
  assert(requestId);
  const pending = provider.getPendingAuthorization(requestId);
  assert(pending);
  const current = (await provider.bindingStatus()).activeBinding;
  const callback = await provider.completeLocalApproval(requestId, pending.userCode, current?.id ?? null);
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert(code);
  const tokenResponse = await fetch(new URL('/token', issuerUrl), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier,
      redirect_uri: client.redirect_uris[0], resource: resourceUrl.href,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert(tokens.access_token);
  assert.equal(tokens.scope, scopes.join(' '));
  return tokens;
}

async function connect(accessToken) {
  const client = new Client({ name: 'lcm-device-first-oauth-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(resourceUrl, {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  return client;
}

let fullClient;
let readClient;
let modernClient;
try {
  const registration = await registerClient();
  const full = await authorize(registration, ['fleet:read', 'fleet:write', 'offline_access']);
  fullClient = await connect(full.access_token);
  const listed = await fullClient.listTools();
  assert.equal(listed.tools.length, 31);
  assert.equal(new Set(listed.tools.map((tool) => tool.name)).size, 31);
  for (const tool of listed.tools) {
    const props = tool.inputSchema?.properties ?? {};
    assert.equal('project_id' in props, false, `${tool.name} exposes project_id`);
    assert.equal('scope_kind' in props, false, `${tool.name} exposes scope_kind`);
    assert.equal('machine_approval' in props, false, `${tool.name} exposes machine_approval`);
  }
  const read = await fullClient.callTool({ name: 'read_file', arguments: { hostname: 'YUAN', path: 'C:\\probe.txt' } });
  assert.equal(read.isError, undefined);
  const write = await fullClient.callTool({ name: 'write_file', arguments: { hostname: 'YUAN', path: 'C:\\probe.txt', content: 'ok', mode: 'rewrite' } });
  assert.equal(write.isError, undefined);
  assert.equal(calls.some((call) => call.toolName === 'read_file' && call.hostname === 'YUAN'), true);
  assert.equal(calls.some((call) => call.toolName === 'write_file' && call.hostname === 'YUAN'), true);

  // Official 2026 client discovers without legacy initialize. Same tools and scope seam.
  modernClient = new ModernClient({ name: 'lcm-modern-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await modernClient.connect(new ModernTransport(resourceUrl, {
    requestInit: { headers: { authorization: `Bearer ${full.access_token}` } },
  }));
  assert.equal(modernClient.getProtocolEra(), 'modern');
  assert.equal(modernClient.getNegotiatedProtocolVersion(), '2026-07-28');
  assert.equal((await modernClient.listTools()).tools.length, 31);
  const modernPing = await modernClient.callTool({ name: 'ping', arguments: { hostname: 'HEMA' } });
  assert.equal(JSON.parse(modernPing.content[0].text).hostname, 'HEMA');
  const beforeModern = calls.length;
  const modernWrite = await modernClient.callTool({ name: 'write_file', arguments: { hostname: 'HEMA', path: 'C:\\probe.txt', content: 'ok', mode: 'rewrite' }, _meta: { lcm_test: 'opaque' } });
  assert.equal(modernWrite.isError, undefined);
  assert.equal(calls[beforeModern].hostname, 'HEMA');
  assert.deepEqual(calls[beforeModern].args._lcm_context, { lcm_test: 'opaque' });
  await modernClient.close(); modernClient = null;
  const refresh=await fetch(new URL('/token',issuerUrl),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:registration.client_id,refresh_token:full.refresh_token})});
  assert.equal(refresh.status,200,'Refresh must accept omitted resource for its already-bound audience');
  const renewed=await refresh.json();
  const refreshedProvider=new SingleUserOAuthProvider({statePath,issuerUrl,resourceUrl});
  assert.equal((await refreshedProvider.verifyAccessToken(renewed.access_token)).resource.href,resourceUrl.href);
  const wrongAudience=await fetch(new URL('/token',issuerUrl),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:registration.client_id,refresh_token:renewed.refresh_token,resource:'https://unrelated.example/mcp'})});
  assert.equal(wrongAudience.status,400);assert.equal((await wrongAudience.json()).error,'invalid_grant');
  const oldAgain=await fetch(new URL('/token',issuerUrl),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:registration.client_id,refresh_token:full.refresh_token})});
  assert.equal(oldAgain.status,400,'Consumed refresh token remains rejected');
  const text=await readFile(statePath,'utf8');assert(!text.includes(renewed.access_token)&&!text.includes(renewed.refresh_token));
  const readOnly = await authorize(registration, ['fleet:read']);
  readClient = await connect(readOnly.access_token);
  const readOk = await readClient.callTool({ name: 'read_file', arguments: { hostname: 'YUAN', path: 'C:\\probe.txt' } });
  assert.equal(readOk.isError, undefined);
  const writeDenied = await readClient.callTool({ name: 'write_file', arguments: { hostname: 'YUAN', path: 'C:\\probe.txt', content: 'deny', mode: 'rewrite' } });
  assert.equal(writeDenied.isError, true);
  assert.match(writeDenied.content?.[0]?.text ?? '', /INSUFFICIENT_SCOPE/);

  modernClient = new ModernClient({ name: 'lcm-modern-read-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await modernClient.connect(new ModernTransport(resourceUrl, { requestInit: { headers: { authorization: `Bearer ${readOnly.access_token}` } } }));
  const callsBeforeDenial = calls.length;
  const modernDenied = await modernClient.callTool({ name: 'write_file', arguments: { hostname: 'YUAN', path: 'C:\\probe.txt', content: 'deny' } });
  assert.equal(modernDenied.isError, true);
  assert.match(modernDenied.content[0].text, /INSUFFICIENT_SCOPE/);
  assert.equal(calls.length, callsBeforeDenial);
  const expanded=await fetch(new URL('/token',issuerUrl),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:registration.client_id,refresh_token:readOnly.refresh_token,scope:'fleet:read fleet:write'})});
  assert.equal(expanded.status,400,'Refresh cannot expand scopes');
  const restarted = new SingleUserOAuthProvider({ statePath, issuerUrl, resourceUrl });
  const persisted = await restarted.verifyAccessToken(readOnly.access_token);
  assert.equal(persisted.clientId, registration.client_id);
  assert.deepEqual(persisted.scopes, ['fleet:read']);
  assert.equal(persisted.resource.href, resourceUrl.href);
  console.log('LCM_DEVICE_FIRST_OAUTH_PASS');
} finally {
  await modernClient?.close().catch(() => undefined);
  await fullClient?.close().catch(() => undefined);
  await readClient?.close().catch(() => undefined);
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(stateDir, { recursive: true, force: true });
}
