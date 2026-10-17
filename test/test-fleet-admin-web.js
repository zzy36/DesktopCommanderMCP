import { LocalAdminSecurity } from '../dist/remote-device/fleet/local-admin-security.js';
import { adminSession } from './fleet-admin-session.js';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFleetAdminHttpServer } from '../dist/remote-device/fleet/admin-server.js';
import { FleetEnrollmentStore } from '../dist/remote-device/fleet/enrollment-store.js';
import { FleetGateway } from '../dist/remote-device/fleet/fleet-gateway.js';

const temp = await mkdtemp(path.join(os.tmpdir(), 'fleet-admin-'));
const devices = [{ hostname: 'YUAN', publicKeyFingerprint: `sha256:${'0'.repeat(64)}` }];
const projects = [{ projectId: 'network.ikuai', hostname: 'YUAN', policyRevision: 'control@000000000000' }];
const gateway = new FleetGateway({ devices, projects, heartbeatSweepMs: 60_000 });
const enrollmentStore = new FleetEnrollmentStore(path.join(temp, 'enrollment.json'));
await enrollmentStore.initialize();
let approvedDevice = null;
const bridgeWindowModes = { YUAN: 'hidden' };
let requestedBridgeWindowMode = null;
const secret = randomBytes(32).toString('base64url');
const security = new LocalAdminSecurity('http://127.0.0.1', secret);
const server = createFleetAdminHttpServer(gateway, {
  security,
  basePath: '/admin',
  devices,
  projects,
  enrollmentStore,
  onApproveDevice: async (device) => { approvedDevice = device; },
  bridgeWindowModes,
  onSetBridgeWindowMode: async (hostname, mode) => { requestedBridgeWindowMode = { hostname, mode }; },
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/admin`;

  // Test fixture uses a kernel-assigned port. Production origin is immutable config.
  security.origin = origin;
  assert.equal((await globalThis.fetch(base + '/api/status')).status, 401);
  const session = await adminSession(origin, secret);
  const rawFetch = globalThis.fetch;
  const fetch = (url, opts = {}) => rawFetch(url, { ...opts, headers: { ...session.headers, ...opts.headers } });
  assert.equal((await rawFetch(origin + '/pair/approve', { method: 'POST', headers: { cookie: session.cookie, origin }, body: '{}' })).status, 403);
  assert.equal((await fetch(origin + '/pair/approve', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status, 403);
  let response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Local Control MCP/);
  assert.match(html, /设备控制中心/);
  assert.match(html, /class="device-grid"/);
  assert.match(html, /data-window-mode="hidden"/);
  assert.match(html, /btn-danger/);
  assert.match(html, /新设备引导/);
  assert.doesNotMatch(html, /if\(confirm\('切换 /);
  for (const block of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(block[1]);

  response = await fetch(`${base}/api/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.ok, true);
  assert.equal(status.devices.length, 1);
  assert.equal(status.devices[0].hostname, 'YUAN');
  assert.equal(status.devices[0].online, false);
  assert.equal(status.devices[0].bridgeWindowMode, 'hidden');
  assert.equal('projects' in status, false);
  assert.equal(typeof status.usage?.in_flight, 'number');
  assert.deepEqual(status.recentCalls, []);

  response = await fetch(`${base}/api/bootstrap`);
  assert.equal(response.status, 200);
  const bootstrap = await response.json();
  assert.match(bootstrap.commands.provisionOnly, /Install-LCMAgent\.ps1/);
  assert.match(bootstrap.commands.provisionOnly, /-ProvisionOnly/);
  assert.match(bootstrap.commands.installAndStart, /-InstallTask/);
  assert.match(bootstrap.commands.installAndStart, /-BridgeWindowMode hidden/);
  assert.match(bootstrap.note, /不会授予业务项目权限/);

  response = await fetch(`${base}/api/devices/window-mode`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname: 'YUAN', mode: 'visible' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(requestedBridgeWindowMode, { hostname: 'YUAN', mode: 'visible' });
  assert.equal(bridgeWindowModes.YUAN, 'visible');

  // Official-style device authorization: start -> browser approve -> poll.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  response = await fetch(`${origin}/device/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'lcm-device', device_name: 'NEWBOX', fingerprint: `sha256:${'2'.repeat(64)}`,
      policy_revision: 'control@123456789abc', code_challenge: challenge, code_challenge_method: 'S256',
    }),
  });
  assert.equal(response.status, 200);
  const started = await response.json();
  assert.match(started.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(started.verification_uri, `${origin}/pair`);
  assert.equal(started.verification_uri_complete, `${origin}/pair?code=${started.user_code}`);

  response = await fetch(started.verification_uri_complete, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } });
  assert.equal(response.status, 200);
  const approvalHtml = await response.text();
  assert.match(approvalHtml, /NEWBOX/);
  assert.match(approvalHtml, new RegExp(started.user_code));
  assert.match(approvalHtml, /批准此设备/);
  assert.match(approvalHtml, /请确认下面的设备、验证码和 PowerShell 窗口中显示的信息完全一致/);

  response = await fetch(started.verification_uri_complete, { headers: { 'accept-language': 'en-US,en;q=0.9' } });
  assert.equal(response.status, 200);
  const englishApprovalHtml = await response.text();
  assert.match(englishApprovalHtml, /Approve this device/);

  response = await fetch(`${origin}/device/poll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: started.device_code, code_verifier: verifier }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'authorization_pending');

  response = await fetch(`${origin}/pair/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: started.user_code }),
  });
  assert.equal(response.status, 200);
  assert.equal(approvedDevice.hostname, 'NEWBOX');

  response = await fetch(`${origin}/device/poll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: started.device_code, code_verifier: verifier }),
  });
  assert.equal(response.status, 200);
  const verified = await response.json();
  assert.equal(verified.status, 'approved');
  assert.equal(verified.device_id, 'NEWBOX');
  assert.equal(verified.credential_type, 'ed25519');

  response = await fetch(`${base}/api/calls?limit=9999`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).calls, []);

  console.log('fleet admin web + device authorization tests passed');
} finally {
  await gateway.stop().catch(() => undefined);
  if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
}
