import assert from 'node:assert/strict';
import { LCM_REMOTE_TOOL_CATALOG } from '../dist/remote-device/fleet/lcm-remote-tool-catalog.js';
import { localizeLcmTool, localizeLcmError } from '../dist/remote-device/fleet/presentation-zh.js';
import { createFleetPluginMcpServer } from '../dist/remote-device/fleet/plugin-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LCM_ICONS } from '../dist/remote-device/fleet/branding.js';
import { readFile } from 'node:fs/promises';

const before = structuredClone(LCM_REMOTE_TOOL_CATALOG);
const stripDescriptions = value => {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, item]) => [key, stripDescriptions(item)]));
};
for (const tool of before) {
  const localized = localizeLcmTool(tool);
  assert.equal(localized.name, tool.name);
  assert.deepEqual(stripDescriptions(localized.inputSchema), stripDescriptions(tool.inputSchema));
  for (const key of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) assert.equal(localized.annotations[key], tool.annotations[key]);
  assert.match(localized.title, /[\u4e00-\u9fff]/);
  assert.match(localized.description, /[\u4e00-\u9fff]/);
}
assert.deepEqual(LCM_REMOTE_TOOL_CATALOG, before, 'presentation must not mutate upstream catalog');
const denied = Object.assign(new Error('path escapes authorized project root'), { code: 'PROJECT_DEVICE_DENIED' });
assert.match(localizeLcmError(denied), /未获授权/);
assert.equal(denied.code, 'PROJECT_DEVICE_DENIED');
assert.match(localizeLcmError(new Error('invalid local credential')), /密钥不正确/);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createFleetPluginMcpServer({});
const client = new Client({ name: 'lcm-presentation-test', version: '1' });
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.equal(client.getServerVersion().name, 'local-control-mcp-remote');
  assert.equal(client.getServerVersion().version, '0.3.5');
  assert.equal(client.getServerVersion().title, 'Local Control MCP');
  assert.deepEqual(client.getServerVersion().icons, LCM_ICONS);
  assert.deepEqual(Buffer.from(LCM_ICONS[0].src.split(',')[1], 'base64'), await readFile(new URL('../deploy/chatgpt-local-plugin/local-control-mcp/assets/local-control-mcp.svg', import.meta.url)));
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 26);
  assert.equal(new Set(listed.tools.map(x => x.name)).size, 26);
  for (const tool of listed.tools) {
    assert.match(tool.description, /[\u4e00-\u9fff]/);
    assert.deepEqual(tool.icons, LCM_ICONS);
  }
} finally { await client.close(); await server.close(); }
console.log('LCM_PRESENTATION_CONTRACT_PASS');
