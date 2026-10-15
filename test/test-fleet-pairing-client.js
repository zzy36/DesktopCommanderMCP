import assert from 'node:assert/strict';
import { claimAndWaitForFleetPairing, fleetPairingOrigin } from '../dist/remote-device/fleet/pairing-client.js';

assert.equal(fleetPairingOrigin('wss://172.16.1.253:9443/agent'), 'https://172.16.1.253:9443');
assert.equal(fleetPairingOrigin('ws://127.0.0.1:8788/agent'), 'http://127.0.0.1:8788');
assert.throws(() => fleetPairingOrigin('ftp://example.test/agent'), /unsupported Fleet Gateway protocol/);

const calls = [];
let polls = 0;
const result = await claimAndWaitForFleetPairing({
  gatewayUrl: 'wss://172.16.1.253:9443/agent',
  code: 'short-lived-test-code',
  hostname: 'NEWBOX',
  fingerprint: `sha256:${'1'.repeat(64)}`,
  policyRevision: 'control@123456789abc',
  timeoutMs: 10_000,
  pollIntervalMs: 250,
  sleep: async () => undefined,
  now: (() => { let value = 0; return () => ++value; })(),
  fetchImpl: async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/pair/claim')) {
      const body = JSON.parse(options.body);
      assert.equal(body.code, 'short-lived-test-code');
      assert.equal(body.hostname, 'NEWBOX');
      assert.equal(body.policyRevision, 'control@123456789abc');
      return new Response(JSON.stringify({ status: 'claimed', hostname: 'NEWBOX' }), { status: 200 });
    }
    assert.match(String(url), /\/pair\/status\?code=short-lived-test-code$/);
    polls += 1;
    return new Response(JSON.stringify({ status: polls >= 2 ? 'approved' : 'claimed', hostname: 'NEWBOX' }), { status: 200 });
  },
});
assert.equal(result.status, 'approved');
assert.equal(calls.length, 3);

await assert.rejects(
  () => claimAndWaitForFleetPairing({
    gatewayUrl: 'wss://172.16.1.253:9443/agent',
    code: 'expired-code',
    hostname: 'NEWBOX',
    fingerprint: `sha256:${'2'.repeat(64)}`,
    policyRevision: 'control@123456789abc',
    timeoutMs: 10_000,
    pollIntervalMs: 250,
    sleep: async () => undefined,
    now: (() => { let value = 0; return () => ++value; })(),
    fetchImpl: async (url) => new Response(JSON.stringify({ status: String(url).includes('/pair/claim') ? 'claimed' : 'expired' }), { status: 200 }),
  }),
  /expired before approval/,
);

console.log('fleet pairing client tests passed');
