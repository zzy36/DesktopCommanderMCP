import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FleetEnrollmentStore } from '../dist/remote-device/fleet/enrollment-store.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-enrollment-'));
const statePath = path.join(dir, 'enrollment.json');

try {
  const store = new FleetEnrollmentStore(statePath);
  await store.initialize();
  const issued = await store.createPairing('NewBox', 60_000);
  assert.equal(issued.hostname, 'NEWBOX');
  assert.equal(issued.status, 'issued');
  assert.ok(issued.code.length >= 20);

  const claimed = await store.claimPairing({
    code: issued.code,
    hostname: 'newbox',
    fingerprint: `sha256:${'1'.repeat(64)}`,
    policyRevision: 'control@123456789abc',
  });
  assert.equal(claimed.status, 'claimed');
  assert.match(claimed.fingerprint, /^sha256:[0-9a-f]{64}$/);

  const approved = await store.approvePairing(issued.id);
  assert.equal(approved.hostname, 'NEWBOX');
  assert.equal(approved.publicKeyFingerprint, claimed.fingerprint);

  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(JSON.stringify(persisted).includes(issued.code), false);

  const reloaded = new FleetEnrollmentStore(statePath);
  await reloaded.initialize();
  assert.deepEqual(reloaded.listApprovedDevices(), [approved]);
  assert.equal(reloaded.listPairings()[0].status, 'approved');

  await assert.rejects(
    () => reloaded.claimPairing({ code: issued.code, hostname: 'NEWBOX', fingerprint: `sha256:${'2'.repeat(64)}`, policyRevision: 'control@123456789abc' }),
    /invalid or expired/,
  );

  console.log('fleet enrollment tests passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
