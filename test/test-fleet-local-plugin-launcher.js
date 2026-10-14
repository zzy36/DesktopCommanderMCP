import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = process.cwd();
const projectsRoot = path.resolve(repoRoot, '..', '..', '..', '..');
const controlRoot = path.join(projectsRoot, '.control');
const runtimeConfig = path.join(os.tmpdir(), `local-remote-mcp-runtime-${process.pid}.json`);
await writeFile(runtimeConfig, JSON.stringify({ controlRoot, runtimeRoot: repoRoot }, null, 2));

const launcher = path.join(repoRoot, 'deploy', 'chatgpt-local-plugin', 'local-remote-mcp', 'server', 'launcher.mjs');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [launcher],
  cwd: path.dirname(launcher),
  env: { ...process.env, LOCAL_REMOTE_MCP_CONFIG: runtimeConfig },
  stderr: 'pipe',
});
const client = new Client({ name: 'local-remote-mcp-launcher-test', version: '0.2.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 16);
  const result = await client.callTool({
    name: 'read_file',
    arguments: { project_id: 'network.local-mcp', path: 'AGENTS.md', offset: 0, length: 3 },
  });
  assert.equal(result.isError, undefined);
  const text = result.content?.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') ?? '';
  assert.match(text, /Local Remote MCP/);
  console.log('fleet local plugin shared-runtime launcher test passed');
} finally {
  await client.close().catch(() => undefined);
  await rm(runtimeConfig, { force: true }).catch(() => undefined);
}
