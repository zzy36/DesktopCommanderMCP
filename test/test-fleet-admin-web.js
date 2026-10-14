import assert from 'node:assert/strict';
import { createFleetAdminHttpServer } from '../dist/remote-device/fleet/admin-server.js';
import { FleetGateway } from '../dist/remote-device/fleet/fleet-gateway.js';

const devices = [{ hostname: 'YUAN', publicKeyFingerprint: `sha256:${'0'.repeat(64)}` }];
const projects = [{ projectId: 'network.ikuai', hostname: 'YUAN', policyRevision: 'control@000000000000' }];
const gateway = new FleetGateway({ devices, projects, heartbeatSweepMs: 60_000 });
const server = createFleetAdminHttpServer(gateway, { basePath: '/admin', devices, projects });

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/admin`;

  let response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Local Remote MCP/);
  assert.match(html, /New device bootstrap/);

  response = await fetch(`${base}/api/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.ok, true);
  assert.equal(status.devices.length, 1);
  assert.equal(status.devices[0].hostname, 'YUAN');
  assert.equal(status.devices[0].online, false);
  assert.equal(status.projects[0].projectId, 'network.ikuai');
  assert.deepEqual(status.recentCalls, []);

  response = await fetch(`${base}/api/bootstrap`);
  assert.equal(response.status, 200);
  const bootstrap = await response.json();
  assert.match(bootstrap.commands.pairingBootstrap, /Register-LocalRemoteMcpDevice\.ps1/);
  assert.match(bootstrap.commands.pairingBootstrap, /-PairingCode/);
  assert.match(bootstrap.commands.existingApprovedDevice, /Register-LocalRemoteMcpDevice\.ps1/);
  assert.match(bootstrap.note, /No account database is required/i);

  response = await fetch(`${base}/api/calls?limit=9999`);
  assert.equal(response.status, 200);
  const calls = await response.json();
  assert.deepEqual(calls.calls, []);

  console.log('fleet admin web tests passed');
} finally {
  await gateway.stop().catch(() => undefined);
  if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
}
