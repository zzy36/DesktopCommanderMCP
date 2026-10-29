import assert from 'node:assert/strict';
import { startProcess } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { LCM_REMOTE_TOOL_CATALOG } from '../dist/remote-device/fleet/lcm-remote-tool-catalog.js';

const sshCommand = "ssh -o BatchMode=yes tencent-xjp 'sudo -n true'";
let launched = [];
const originalExecute = terminalManager.executeCommand;

try {
  assert.equal(commandManager.extractCommands(sshCommand)[0], 'ssh',
    'remote sudo remains payload of the ssh command, not a local sudo command');

  terminalManager.executeCommand = async (...args) => {
    launched.push(args);
    return {
      pid: 123456,
      output: 'STUB_ONLY',
      processState: { isWaitingForInput: false, isFinished: false },
      isBlocked: false,
    };
  };

  const sshResult = await startProcess({ command: sshCommand, timeout_ms: 1000 });
  assert.equal(sshResult.isError, undefined,
    'SSH must use the ordinary start_process path without a special approval token');
  assert.equal(launched.length, 1);
  assert.equal(launched[0][0], sshCommand);

  const localBlocked = await startProcess({ command: 'sudo rm -rf /', timeout_ms: 1000 });
  assert.equal(localBlocked.structuredContent.blocked, true,
    'removing the SSH-only gate must not disable the ordinary local command blocklist');
  assert.equal(launched.length, 1, 'blocked local sudo must not reach the terminal');

  const startTool = LCM_REMOTE_TOOL_CATALOG.find((tool) => tool.name === 'start_process');
  assert(startTool, 'start_process must remain in the LCM catalog');
  assert.equal(Object.hasOwn(startTool.inputSchema.properties, 'command_approval'), false,
    'the public LCM schema must not expose the retired signed SSH approval knob');

  console.log('PASS: SSH uses ordinary start_process; local blocklist remains enforced');
} finally {
  terminalManager.executeCommand = originalExecute;
}
