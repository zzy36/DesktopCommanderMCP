import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fingerprintPublicKey, verifyChallengeSignature } from '../dist/remote-device/fleet/identity.js';
import { FleetRouter } from '../dist/remote-device/fleet/router.js';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function expectCode(code, fn) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

const yuanKey = keyPair();
const hemaKey = keyPair();
const yuanFingerprint = fingerprintPublicKey(yuanKey.publicPem);
const hemaFingerprint = fingerprintPublicKey(hemaKey.publicPem);
const POLICY = 'control@8080d685';

function makeRouter() {
  return new FleetRouter(
    [
      { hostname: 'YUAN', publicKeyFingerprint: yuanFingerprint },
      { hostname: 'HEMA', publicKeyFingerprint: hemaFingerprint },
    ],
    [
      { projectId: 'network.ikuai', hostname: 'YUAN', policyRevision: POLICY },
      { projectId: 'commerce.demo', hostname: 'HEMA', policyRevision: POLICY },
    ],
  );
}

function session(sessionId, hostname, publicKeyFingerprint, policyRevision = POLICY) {
  return { sessionId, hostname, publicKeyFingerprint, policyRevision, connectedAtMs: Date.now() };
}

{
  const challenge = Buffer.from('fleet-challenge-1');
  const signature = sign(null, challenge, yuanKey.privateKey).toString('base64');
  assert.equal(verifyChallengeSignature(yuanKey.publicPem, challenge, signature), true);
  assert.equal(verifyChallengeSignature(hemaKey.publicPem, challenge, signature), false);
}

{
  const router = makeRouter();
  router.registerAgent(session('yuan-1', 'yuan', yuanFingerprint));
  assert.equal(router.resolve('network.ikuai', 'YUAN').hostname, 'YUAN');
}

{
  const router = makeRouter();
  expectCode('IDENTITY_MISMATCH', () =>
    router.registerAgent(session('spoof-1', 'YUAN', hemaFingerprint)));
}

{
  const router = makeRouter();
  router.registerAgent(session('hema-1', 'HEMA', hemaFingerprint));
  expectCode('TARGET_OFFLINE', () => router.resolve('network.ikuai', 'YUAN'));
}

{
  const router = makeRouter();
  router.registerAgent(session('yuan-1', 'YUAN', yuanFingerprint));
  router.registerAgent(session('hema-1', 'HEMA', hemaFingerprint));
  expectCode('PROJECT_DEVICE_DENIED', () => router.resolve('network.ikuai', 'HEMA'));
}

{
  const router = makeRouter();
  router.registerAgent(session('yuan-old-policy', 'YUAN', yuanFingerprint, 'control@old'));
  expectCode('POLICY_SKEW', () => router.resolve('network.ikuai', 'YUAN'));
}

{
  const router = makeRouter();
  router.registerAgent(session('yuan-1', 'YUAN', yuanFingerprint));
  router.registerAgent(session('yuan-2', 'YUAN', yuanFingerprint));
  expectCode('TARGET_AMBIGUOUS', () => router.resolve('network.ikuai', 'YUAN'));
  router.unregisterAgent('yuan', 'yuan-1');
  assert.equal(router.resolve('network.ikuai', 'yuan').sessionId, 'yuan-2');
}

console.log('fleet router tests passed');
