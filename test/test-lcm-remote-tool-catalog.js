import assert from 'node:assert/strict';
import { LCM_REMOTE_TOOL_CATALOG } from '../dist/remote-device/fleet/lcm-remote-tool-catalog.js';

const expected = [
  'read_file','read_multiple_files','write_file','write_pdf','create_directory','list_directory','move_file','get_file_info','edit_block',
  'start_search','get_more_search_results','stop_search','list_searches',
  'start_process','read_process_output','interact_with_process','list_sessions','force_terminate','kill_process','list_processes',
  'get_config','set_config_value','shutdown','get_recent_tool_calls',
];
const names = LCM_REMOTE_TOOL_CATALOG.map((tool) => tool.name);
assert.equal(names.length, 24, `expected 24 device execution tools, got ${names.length}`);
assert.deepEqual([...names].sort(), [...expected].sort());
assert.equal(new Set(names).size, names.length, 'remote LCM catalog contains duplicate tool names');

for (const tool of LCM_REMOTE_TOOL_CATALOG) {
  assert.equal(tool.inputSchema?.type, 'object', `${tool.name} must have an object input schema`);
  const props = tool.inputSchema?.properties ?? {};
  assert(props.hostname, `${tool.name} missing exact hostname`);
  assert(props.execution_context, `${tool.name} missing execution_context`);
  assert.equal('project_id' in props, false, `${tool.name} must not expose project_id`);
  assert.equal('scope_kind' in props, false, `${tool.name} must not expose scope_kind`);
  assert.equal('machine_approval' in props, false, `${tool.name} must not expose machine_approval`);
  const required = new Set(tool.inputSchema?.required ?? []);
  assert(required.has('hostname'), `${tool.name} must require hostname`);
  assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} missing readOnlyHint`);
  assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} missing destructiveHint`);
}

const startProcess = LCM_REMOTE_TOOL_CATALOG.find((tool) => tool.name === 'start_process');
assert(startProcess, 'start_process missing from remote catalog');
assert(!new Set(startProcess.inputSchema.required ?? []).has('timeout_ms'), 'start_process timeout_ms must remain optional for RDC parity');
console.log('LCM device-first remote tool catalog sync passed');
