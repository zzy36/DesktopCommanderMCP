import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { writeFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = process.cwd();
const projectsRoot = path.resolve(repoRoot, '..', '..', '..', '..');
const controlRoot = path.join(projectsRoot, '.control');
const runtimeConfig = path.join(os.tmpdir(), `local-control-mcp-runtime-${process.pid}.json`);
await writeFile(runtimeConfig, JSON.stringify({ controlRoot, runtimeRoot: repoRoot }, null, 2));

const launcher = path.join(repoRoot, 'deploy', 'chatgpt-local-plugin', 'local-control-mcp', 'server', 'launcher.mjs');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [launcher],
  cwd: path.dirname(launcher),
  env: { ...process.env, LOCAL_CONTROL_MCP_CONFIG: runtimeConfig },
  stderr: 'pipe',
});
const client = new Client({ name: 'local-control-mcp-launcher-test', version: '0.3.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 20);
  const result = await client.callTool({
    name: 'read_file',
    arguments: { project_id: 'network.local-control-mcp', path: 'AGENTS.md', offset: 0, length: 3 },
  });
  assert.equal(result.isError, undefined);
  const text = result.content?.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') ?? '';
  assert.match(text, /Local Control MCP/);
  console.log('fleet local plugin shared-runtime launcher test passed');
} finally {
  await client.close().catch(() => undefined);
  await rm(runtimeConfig, { force: true }).catch(() => undefined);
}

const retiredFixture = await mkdtemp(path.join(os.tmpdir(), 'lcm-retired-launcher-'));
try {
  const legacyFile = path.join(retiredFixture, 'legacy.js');
  const marker = path.join(retiredFixture, 'legacy-executed');
  await writeFile(legacyFile, `require('fs').writeFileSync(${JSON.stringify(marker)},'bad');`);
  await mkdir(path.join(retiredFixture, '.control'));
  const missingCanonical = spawnSync(process.execPath, [launcher], {
    env: { ...process.env, ProgramData: retiredFixture, PROGRAMDATA: retiredFixture,
      MACHINE_CONTROL_ROOT: path.join(retiredFixture, '.control'), LOCAL_CONTROL_MCP_RUNTIME: '', LOCAL_CONTROL_MCP_CONFIG: path.join(retiredFixture, 'missing.json'),
      LOCAL_REMOTE_MCP_RUNTIME: legacyFile, FLEET_AGENT_CONFIG: path.join(retiredFixture, 'missing-agent.json') }, encoding: 'utf8',
  });
  assert.notEqual(missingCanonical.status, 0, 'retired runtime must not be an implicit availability fallback');
  await assert.rejects(import('node:fs/promises').then(fs => fs.readFile(marker)), /ENOENT/);
  console.log('retired launcher fallback denied');
} finally { await rm(retiredFixture, { recursive: true, force: true }); }
