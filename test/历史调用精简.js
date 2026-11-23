import assert from 'node:assert/strict';
import { FleetGatewayPluginBackend } from '../dist/remote-device/fleet/gateway-plugin-backend.js';

const body = 'private-result-marker:' + 'x'.repeat(65536);
const records = Array.from({ length: 100 }, (_, i) => ({
  callId: 'call-' + i, hostname: i % 2 ? 'LAB2' : 'LAB1',
  toolName: 'read_file', scopeKind: 'device', projectId: null,
  status: i === 99 ? 'unknown' : 'completed', createdAtMs: i,
  completedAtMs: i + 1, code: null, error: null,
  ...(i === 99 ? {} : { result: { content: [{ type: 'text', text: body }] } }),
}));
const gateway = {
  listCallRecords: () => records,
  getCallRecord: id => records.find(record => record.callId === id),
};
const backend = new FleetGatewayPluginBackend({ gateway });
const compact = await backend.listRemoteToolCalls('', undefined, 100);
assert.equal(compact.length, 100);
assert(compact.every(record => !Object.hasOwn(record, 'result')));
assert.equal(compact[0].hasResult, true);
assert.equal(compact[99].hasResult, false);
assert.equal(compact[99].status, 'unknown');
assert(!JSON.stringify(compact).includes('private-result-marker'));
const selected = await backend.listRemoteToolCalls('', 'lab2', 3);
assert.equal(selected.length, 3);
assert(selected.every(record => record.hostname === 'LAB2'));
assert.equal((await backend.listRemoteToolCalls('', undefined, 1000)).length, 100);
assert.equal((await backend.listRemoteToolCalls('', undefined, 0)).length, 1);
const result = await backend.getToolResult('', 'LAB1', 'call-0');
assert.equal(result.result.content[0].text, body);
await assert.rejects(backend.getToolResult('', 'LAB2', 'call-0'), { code: 'CALL_NOT_FOUND' });
await assert.rejects(backend.getToolResult('', 'LAB1', 'missing'), { code: 'CALL_NOT_FOUND' });
assert(Object.hasOwn(records[0], 'result'), 'listing must not mutate stored results');
const beforeBytes = Buffer.byteLength(JSON.stringify(records));
const afterBytes = Buffer.byteLength(JSON.stringify(compact));
assert(afterBytes < 100000 && afterBytes < beforeBytes / 50);
console.log(JSON.stringify({ status: 'PASS', cases: 10, beforeBytes, afterBytes,
  reductionPercent: Number((100 * (1 - afterBytes / beforeBytes)).toFixed(2)),
  exactHostPreserved: true, selectedResultPreserved: true, unknownNotReplayed: true }));
