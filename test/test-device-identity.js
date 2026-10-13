import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceIdentityStore } from '../dist/remote-device/fleet/device-identity.js';

const stateDir = await mkdtemp(join(tmpdir(), 'fleet-identity-'));
try {
  const store = new DeviceIdentityStore({ stateDir });
  const first = await store.loadOrCreate('yuan');
  const second = await store.loadOrCreate('YUAN');
  assert.equal(first.hostname, 'YUAN');
  assert.equal(first.publicKeyFingerprint, second.publicKeyFingerprint);
  assert.equal(first.privateKeyPem, second.privateKeyPem);

  const raw = JSON.parse(await readFile(join(stateDir, 'device-identity.json'), 'utf8'));
  assert.equal(raw.hostname, 'YUAN');
  assert.match(raw.publicKeyFingerprint, /^sha256:[0-9a-f]{64}$/);

  await assert.rejects(
    store.loadOrCreate('HEMA'),
    /hostname mismatch/,
  );

  console.log('device identity persistence tests passed');
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
