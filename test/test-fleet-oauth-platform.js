import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
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
import { createFleetOAuthPluginHttpServer } from '../dist/remote-device/fleet/oauth-plugin-server.js';
import {
  SingleUserOAuthProvider,
  hashOwnerPassword,
  verifyOwnerPasswordHash,
} from '../dist/remote-device/fleet/single-user-oauth.js';

const controlRoot = process.env.FLEET_TEST_CONTROL_ROOT;
assert(controlRoot, 'FLEET_TEST_CONTROL_ROOT is required');

const runtimeDir = await mkdtemp(join(tmpdir(), 'fleet-oauth-platform-'));
const agentStateDir = join(runtimeDir, 'agent');
const probeFile = join(runtimeDir, 'oauth-write-probe.txt');
const generationFile = join(runtimeDir, 'gateway-generations.json');
const oauthStateFile = join(runtimeDir, 'oauth-state.json');
const ownerPassword = `owner-${randomBytes(18).toString('base64url')}`;
const ownerPasswordHash = await hashOwnerPassword(ownerPassword);

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

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

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

const oauthPort = await freePort();
const issuerUrl = new URL(`http://127.0.0.1:${oauthPort}/`);
const resourceUrl = new URL('/mcp', issuerUrl);
const provider = new SingleUserOAuthProvider({
  statePath: oauthStateFile,
  issuerUrl,
  resourceUrl,
  verifyOwnerPassword: (password) => verifyOwnerPasswordHash(ownerPasswordHash, password),
});
const httpServer = createFleetOAuthPluginHttpServer({
  backend,
  provider,
  issuerUrl,
  resourceUrl,
});
httpServer.listen(oauthPort, '127.0.0.1');
await once(httpServer, 'listening');

async function registerClient() {
  const response = await fetch(new URL('/register', issuerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['http://127.0.0.1:17891/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Fleet OAuth Test Client',
      scope: 'fleet:read fleet:write',
    }),
  });
  assert.equal(response.status, 201);
  const client = await response.json();
  assert(client.client_id);
  assert.equal(client.client_secret, undefined);
  return client;
}

async function authorize(client, scopes, { wrongPassword = false, wrongVerifier = false } = {}) {
  const verifier = randomBytes(40).toString('base64url');
  const challenge = pkceChallenge(verifier);
  const state = randomBytes(16).toString('base64url');
  const authorizeUrl = new URL('/authorize', issuerUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', client.redirect_uris[0]);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', scopes.join(' '));
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('resource', resourceUrl.href);

  const authResponse = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authResponse.status, 302);
  const loginLocation = authResponse.headers.get('location');
  assert(loginLocation);
  const loginUrl = new URL(loginLocation, issuerUrl);
  assert.equal(loginUrl.pathname, '/oauth/login');
  const requestId = loginUrl.searchParams.get('request_id');
  assert(requestId);

  const loginPage = await fetch(loginUrl);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Authorize Network Fleet MCP/);

  if (wrongPassword) {
    const badLogin = await fetch(new URL('/oauth/login', issuerUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: requestId, password: 'definitely-wrong-password' }),
      redirect: 'manual',
    });
    assert.equal(badLogin.status, 401);
  }

  const loginResponse = await fetch(new URL('/oauth/login', issuerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId, password: ownerPassword }),
    redirect: 'manual',
  });
  assert.equal(loginResponse.status, 302);
  const callbackLocation = loginResponse.headers.get('location');
  assert(callbackLocation);
  const callback = new URL(callbackLocation);
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert(code);

  if (wrongVerifier) {
    const badToken = await fetch(new URL('/token', issuerUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: randomBytes(40).toString('base64url'),
        redirect_uri: client.redirect_uris[0],
        resource: resourceUrl.href,
      }),
    });
    assert.equal(badToken.status, 400);
    const error = await badToken.json();
    assert.equal(error.error, 'invalid_grant');
  }

  const tokenResponse = await fetch(new URL('/token', issuerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: client.redirect_uris[0],
      resource: resourceUrl.href,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert(tokens.access_token);
  assert(tokens.refresh_token);
  assert.equal(tokens.token_type.toLowerCase(), 'bearer');
  assert.equal(tokens.scope, scopes.join(' '));
  return tokens;
}

async function mcpClientWithToken(accessToken) {
  const client = new Client({ name: 'fleet-oauth-platform-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(resourceUrl, {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

let fullClient = null;
let readOnlyClient = null;
let refreshedClient = null;
try {
  await agent.start();
  await waitFor(() => gateway.deviceStatus('network.ikuai', 'YUAN').online);

  const protectedMetadataResponse = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', issuerUrl));
  assert.equal(protectedMetadataResponse.status, 200);
  const protectedMetadata = await protectedMetadataResponse.json();
  assert.equal(protectedMetadata.resource, resourceUrl.href);
  assert.deepEqual(protectedMetadata.scopes_supported.sort(), ['fleet:read', 'fleet:write'].sort());

  const authMetadataResponse = await fetch(new URL('/.well-known/oauth-authorization-server', issuerUrl));
  assert.equal(authMetadataResponse.status, 200);
  const authMetadata = await authMetadataResponse.json();
  assert.equal(authMetadata.issuer, issuerUrl.href);
  assert.equal(authMetadata.code_challenge_methods_supported.includes('S256'), true);
  assert(authMetadata.registration_endpoint);

  const unauthenticated = await fetch(resourceUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(unauthenticated.status, 401);
  const authenticateHeader = unauthenticated.headers.get('www-authenticate') ?? '';
  assert.match(authenticateHeader, /resource_metadata=/i);

  const clientRegistration = await registerClient();
  const fullTokens = await authorize(clientRegistration, ['fleet:read', 'fleet:write'], {
    wrongPassword: true,
    wrongVerifier: true,
  });

  fullClient = await mcpClientWithToken(fullTokens.access_token);
  const tools = await fullClient.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['fleet_status', 'list_devices', 'read_test_file', 'write_test_file'].sort(),
  );

  const probe = `oauth-write-ok-${Date.now()}`;
  const write = await fullClient.callTool({
    name: 'write_test_file',
    arguments: { project_id: 'network.ikuai', hostname: 'YUAN', content: probe },
  });
  assert.equal(write.isError, undefined);
  assert.equal(await readFile(probeFile, 'utf8'), probe);

  const read = await fullClient.callTool({
    name: 'read_test_file',
    arguments: { project_id: 'network.ikuai', hostname: 'YUAN' },
  });
  assert.equal(read.isError, undefined);
  assert.match(firstText(read), new RegExp(probe));

  const readOnlyTokens = await authorize(clientRegistration, ['fleet:read']);
  readOnlyClient = await mcpClientWithToken(readOnlyTokens.access_token);
  const readOnlyRead = await readOnlyClient.callTool({
    name: 'read_test_file',
    arguments: { project_id: 'network.ikuai', hostname: 'YUAN' },
  });
  assert.equal(readOnlyRead.isError, undefined);
  const deniedWrite = await readOnlyClient.callTool({
    name: 'write_test_file',
    arguments: { project_id: 'network.ikuai', hostname: 'YUAN', content: 'must-not-write-readonly' },
  });
  assert.equal(deniedWrite.isError, true);
  assert.match(firstText(deniedWrite), /fleet:write/);
  assert.equal(await readFile(probeFile, 'utf8'), probe);

  const refreshResponse = await fetch(new URL('/token', issuerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientRegistration.client_id,
      refresh_token: fullTokens.refresh_token,
      scope: 'fleet:read fleet:write',
      resource: resourceUrl.href,
    }),
  });
  assert.equal(refreshResponse.status, 200);
  const refreshedTokens = await refreshResponse.json();
  assert(refreshedTokens.access_token);
  assert(refreshedTokens.refresh_token);
  assert.notEqual(refreshedTokens.refresh_token, fullTokens.refresh_token);

  const oldRefreshAgain = await fetch(new URL('/token', issuerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientRegistration.client_id,
      refresh_token: fullTokens.refresh_token,
      scope: 'fleet:read fleet:write',
      resource: resourceUrl.href,
    }),
  });
  assert.equal(oldRefreshAgain.status, 400);
  assert.equal((await oldRefreshAgain.json()).error, 'invalid_grant');

  refreshedClient = await mcpClientWithToken(refreshedTokens.access_token);
  const refreshedStatus = await refreshedClient.callTool({
    name: 'fleet_status',
    arguments: { project_id: 'network.ikuai', hostname: 'YUAN' },
  });
  assert.equal(refreshedStatus.isError, undefined);
  assert.match(firstText(refreshedStatus), /"online": true/);

  const persistedStateText = await readFile(oauthStateFile, 'utf8');
  assert.equal(persistedStateText.includes(ownerPassword), false);
  assert.equal(persistedStateText.includes(fullTokens.access_token), false);
  assert.equal(persistedStateText.includes(fullTokens.refresh_token), false);
  assert.equal(persistedStateText.includes(refreshedTokens.access_token), false);
  assert.equal(persistedStateText.includes(refreshedTokens.refresh_token), false);

  const providerAfterRestart = new SingleUserOAuthProvider({
    statePath: oauthStateFile,
    issuerUrl,
    resourceUrl,
    verifyOwnerPassword: (password) => verifyOwnerPasswordHash(ownerPasswordHash, password),
  });
  const persistedAuth = await providerAfterRestart.verifyAccessToken(refreshedTokens.access_token);
  assert.equal(persistedAuth.clientId, clientRegistration.client_id);
  assert.deepEqual(persistedAuth.scopes.sort(), ['fleet:read', 'fleet:write'].sort());
  assert.equal(persistedAuth.resource.href, resourceUrl.href);

  assert(audit.events.some((event) => event.event === 'call_completed'));
  assert.equal(audit.events.some((event) => JSON.stringify(event).includes(probe)), false);

  console.log('fleet OAuth + full local platform tests passed');
} finally {
  await fullClient?.close().catch(() => undefined);
  await readOnlyClient?.close().catch(() => undefined);
  await refreshedClient?.close().catch(() => undefined);
  await new Promise((resolve) => httpServer.close(resolve));
  await agent.stop().catch(() => undefined);
  await gateway.stop().catch(() => undefined);
  await new Promise((resolve) => wsServer.close(resolve));
  await rm(runtimeDir, { recursive: true, force: true });
}
