import assert from 'node:assert/strict';
import { LCM_PROJECT_TOOLS } from '../dist/remote-device/fleet/project-tool-contract.js';
import { LCM_REMOTE_TOOL_CATALOG } from '../dist/remote-device/fleet/lcm-remote-tool-catalog.js';

const names = LCM_REMOTE_TOOL_CATALOG.map((tool) => tool.name);
assert.equal(names.length, 20, `expected 20 remote LCM tools, got ${names.length}`);
assert.deepEqual([...names].sort(), [...LCM_PROJECT_TOOLS].sort());
assert.equal(new Set(names).size, names.length, 'remote LCM catalog contains duplicate tool names');

for (const tool of LCM_REMOTE_TOOL_CATALOG) {
  assert.equal(tool.inputSchema?.type, 'object', `${tool.name} must have an object input schema`);
  const props = tool.inputSchema?.properties ?? {};
  assert(props.project_id, `${tool.name} missing conditional project_id`);
  assert(props.hostname, `${tool.name} missing hostname`);
  assert.deepEqual(props.scope_kind?.enum, ['project', 'machine_control'], `${tool.name} missing scope_kind contract`);
  assert.equal(props.machine_approval?.type, 'boolean', `${tool.name} missing machine_approval contract`);
  const required = new Set(tool.inputSchema?.required ?? []);
  assert(!required.has('project_id'), `${tool.name} project_id must be conditionally required by project scope`);
  assert(required.has('hostname'), `${tool.name} must require hostname`);
  assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} missing readOnlyHint`);
  assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} missing destructiveHint`);
}

const startProcess = LCM_REMOTE_TOOL_CATALOG.find((tool) => tool.name === 'start_process');
assert(startProcess, 'start_process missing from remote catalog');
assert(!new Set(startProcess.inputSchema.required ?? []).has('timeout_ms'), 'start_process timeout_ms must remain optional for RDC parity');
console.log('LCM remote tool catalog sync passed');
