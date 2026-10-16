import { skip } from './helpers/run-if-main.js';
if (process.env.LCM_RUN_LEGACY_NATIVE_TESTS !== '1') {
  skip('retired Native/local-plugin presentation; kept only for rollback testing');
  process.exit(0);
}
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectId = 'network.local-control-mcp';
const repoRoot = 'G:\\Projects\\local-control-mcp';
const probeRelative = 'local-only\\mcp\\.local-plugin-probe.txt';
const probeAbsolute = `${repoRoot}\\${probeRelative}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/remote-device/fleet/local-plugin-main.js'],
  cwd: 'G:\\Projects\\local-control-mcp\\local-only\\mcp\\DesktopCommanderMCP',
  stderr: 'pipe',
});
const client = new Client({ name: 'local-control-mcp-test', version: '0.1.0' });
await client.connect(transport);

function text(result) {
  return result?.content?.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') ?? '';
}

try {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.equal(names.length, 20);
  assert(names.includes('read_file'));
  assert(names.includes('write_file'));
  assert(names.includes('start_process'));
  assert(names.includes('list_sessions'));
  assert(names.includes('list_searches'));
  assert(names.includes('kill_process'));
  assert(names.includes('get_config'));
  assert(!names.includes('set_config_value'));
  assert(!names.includes('get_recent_tool_calls'));
  assert(!names.includes('list_processes'));
  assert(!names.includes('set_config_value'));
  for (const tool of listed.tools) {
    assert(tool.inputSchema?.properties?.project_id, `${tool.name} missing project_id`);
    assert(tool.inputSchema?.required?.includes('project_id'), `${tool.name} project_id not required`);
  }

  let result = await client.callTool({
    name: 'read_file',
    arguments: { project_id: projectId, path: 'AGENTS.md', offset: 0, length: 5 },
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Local Control MCP/);
  result = await client.callTool({
    name: 'write_file',
    arguments: { project_id: projectId, path: probeRelative, content: 'LOCAL_PLUGIN_WRITE_OK', mode: 'rewrite' },
  });
  assert.equal(result.isError, undefined);
  assert.equal(await readFile(probeAbsolute, 'utf8'), 'LOCAL_PLUGIN_WRITE_OK');

  result = await client.callTool({
    name: 'read_file',
    arguments: { project_id: projectId, path: '..\\.control\\registry.json' },
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /PROJECT_DEVICE_DENIED/);

  result = await client.callTool({
    name: 'read_file',
    arguments: { project_id: 'does.not.exist', path: 'AGENTS.md' },
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /PROJECT_DEVICE_DENIED/);

  result = await client.callTool({
    name: 'get_config',
    arguments: { project_id: projectId },
  });
  assert.equal(result.isError, undefined);
  const configText = text(result);
  assert.match(configText, /Local Control MCP/);
  assert.match(configText, /network\.local-control-mcp/);
  assert(!/clientHistory/.test(configText));
  assert(!/allowedDirectories/.test(configText));

  result = await client.callTool({
    name: 'kill_process',
    arguments: { project_id: projectId, pid: 1 },
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /PROJECT_DEVICE_DENIED/);
  result = await client.callTool({
    name: 'start_process',
    arguments: { project_id: projectId, command: "Write-Output ('ROOT=' + (Get-Location).Path); Write-Output 'LOCAL_PLUGIN_PROCESS_OK'", timeout_ms: 3000 },
  });
  assert.equal(result.isError, undefined);
  let processText = text(result);
  if (!/LOCAL_PLUGIN_PROCESS_OK/.test(processText)) {
    const pidMatch = processText.match(/Process started with PID\s+(\d+)/i);
    assert(pidMatch, `missing Local MCP process PID: ${processText}`);
    result = await client.callTool({
      name: 'read_process_output',
      arguments: { project_id: projectId, pid: Number(pidMatch[1]), timeout_ms: 3000, offset: 0, length: 50 },
    });
    assert.equal(result.isError, undefined);
    processText += `\n${text(result)}`;
  }
  assert.match(processText, /LOCAL_PLUGIN_PROCESS_OK/);
  assert.match(processText, /G:\\Projects\\local-control-mcp/i);

  console.log('fleet local plugin MCP tests passed');
} finally {
  await rm(probeAbsolute, { force: true }).catch(() => undefined);
  await client.close().catch(() => undefined);
}
