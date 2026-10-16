import assert from 'node:assert/strict';
import { ControlPolicyAuthorizer } from '../dist/remote-device/fleet/control-policy.js';

const controlRoot = process.env.FLEET_TEST_CONTROL_ROOT;
assert(controlRoot, 'FLEET_TEST_CONTROL_ROOT is required');

const authorizer = new ControlPolicyAuthorizer({ controlRoot });
const revision = await authorizer.policyRevision();
assert.match(revision, /^control@[0-9a-f]{12}$/);

const allowed = await authorizer.authorize('network.ikuai', 'YUAN');
assert.equal(allowed.projectId, 'network.ikuai');
assert.equal(allowed.partitionId, 'network');
assert.equal(allowed.deviceName, 'YUAN');
assert.match(allowed.physicalRoot ?? '', /ikuai$/i);

await assert.rejects(
  authorizer.authorize('network.ikuai', 'HEMA'),
  (error) => error?.code === 'PROJECT_DEVICE_DENIED',
);

await assert.rejects(
  authorizer.authorize('commerce.meta', 'YUAN'),
  (error) => error?.code === 'PROJECT_DEVICE_DENIED',
);

const machine = await authorizer.authorizeMachine('YUAN', true);
assert.equal(machine.scopeKind, 'machine_control');
assert.equal(machine.projectId, null);
assert.equal(machine.partitionId, null);
assert.equal(machine.physicalRoot, null);
assert.equal(machine.deviceName, 'YUAN');
await assert.rejects(
  authorizer.authorizeMachine('YUAN', false),
  (error) => error?.code === 'PROJECT_DEVICE_DENIED',
);
await assert.rejects(
  authorizer.authorizeMachine('HEMA', true),
  (error) => error?.code === 'PROJECT_DEVICE_DENIED',
);

await authorizer.stop();
console.log(`control policy tests passed (${revision})`);
