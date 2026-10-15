import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FleetEnrollmentStore } from '../dist/remote-device/fleet/enrollment-store.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-enrollment-'));
const statePath = path.join(dir, 'enrollment.json');

try {
  const store = new FleetEnrollmentStore(statePath);
  await store.initialize();

  // Legacy manual pairing remains compatible.
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
  const approved = await store.approvePairing(issued.id);
  assert.equal(approved.hostname, 'NEWBOX');
  assert.equal(approved.publicKeyFingerprint, claimed.fingerprint);

  // Official-style Device Authorization + PKCE.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = await store.createDeviceAuthorization({
    hostname: 'newbox',
    fingerprint: approved.publicKeyFingerprint,
    policyRevision: 'control@123456789abc',
    codeChallenge: challenge,
    ttlMs: 60_000,
  });
  assert.equal(auth.status, 'pending');
  assert.match(auth.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(auth.deviceCode.length >= 40);
  assert.equal((await store.pollDeviceAuthorization({ deviceCode: auth.deviceCode, codeVerifier: verifier })).status, 'pending');
  await assert.rejects(
    () => store.pollDeviceAuthorization({ deviceCode: auth.deviceCode, codeVerifier: randomBytes(32).toString('base64url') }),
    /PKCE verification failed/,
  );
  const byCode = store.getDeviceAuthorizationByUserCode(auth.userCode.toLowerCase());
  assert.equal(byCode?.hostname, 'NEWBOX');
  const flowApproved = await store.approveDeviceAuthorizationByUserCode(auth.userCode);
  assert.equal(flowApproved.authorization.status, 'approved');
  assert.deepEqual(flowApproved.device, approved);
  const polled = await store.pollDeviceAuthorization({ deviceCode: auth.deviceCode, codeVerifier: verifier });
  assert.equal(polled.status, 'approved');

  const persistedText = await readFile(statePath, 'utf8');
  assert.equal(persistedText.includes(issued.code), false);
  assert.equal(persistedText.includes(auth.deviceCode), false);
  assert.equal(persistedText.includes(auth.userCode), false);
  assert.equal(persistedText.includes(verifier), false);
  const persisted = JSON.parse(persistedText);
  assert.equal(persisted.schemaVersion, 2);

  const reloaded = new FleetEnrollmentStore(statePath);
  await reloaded.initialize();
  assert.deepEqual(reloaded.listApprovedDevices(), [approved]);
  assert.equal(reloaded.listPairings()[0].status, 'approved');
  assert.equal(reloaded.listDeviceAuthorizations()[0].status, 'approved');

  // Schema v1 upgrades in place without losing approved identities.
  const legacyPath = path.join(dir, 'legacy.json');
  await writeFile(legacyPath, JSON.stringify({ schemaVersion: 1, pairings: [], approvedDevices: [{ ...approved, approvedAtMs: Date.now() }] }));
  const legacy = new FleetEnrollmentStore(legacyPath);
  await legacy.initialize();
  assert.deepEqual(legacy.listApprovedDevices(), [approved]);
  assert.deepEqual(legacy.listDeviceAuthorizations(), []);
  assert.equal(JSON.parse(await readFile(legacyPath, 'utf8')).schemaVersion, 2);

  console.log('fleet enrollment + device authorization tests passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
