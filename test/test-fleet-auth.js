import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFleetPluginHttpServer } from '../dist/remote-device/fleet/plugin-server.js';
import { LCM_PROJECT_TOOLS } from '../dist/remote-device/fleet/project-tool-contract.js';

const TOKEN = 'fleet-test-secret';
const backend = {
  async fleetStatus(projectId, hostname) {
    return { project_id: projectId, hostname, online: true };
  },
  async listDevices() {
    return [{ hostname: 'YUAN', online: true }];
  },
  async readTestFile() {
    return 'probe';
  },
  async writeTestFile(_projectId, _hostname, content) {
    return { bytesWritten: Buffer.byteLength(content) };
  },
};

const server = createFleetPluginHttpServer(backend, { bearerToken: TOKEN });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.equal(typeof address, 'object');
const url = `http://127.0.0.1:${address.port}/mcp`;

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'auth-probe', version: '0.1.0' },
  },
};

let response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(initializeBody),
});
assert.equal(response.status, 401);
assert.match(response.headers.get('www-authenticate') ?? '', /^Bearer /);

response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer wrong-secret',
  },
  body: JSON.stringify(initializeBody),
});
assert.equal(response.status, 401);

const client = new Client({ name: 'fleet-auth-test', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
await client.connect(transport);
const tools = await client.listTools();
assert.deepEqual(
  tools.tools.map((tool) => tool.name).sort(),
  ['fleet_status', 'list_devices', 'ping', 'who_am_i', 'get_tool_result', 'list_remote_tool_calls', ...LCM_PROJECT_TOOLS].sort(),
);

const result = await client.callTool({
  name: 'fleet_status',
  arguments: { project_id: 'network.ikuai', hostname: 'YUAN' },
});
assert.equal(result.isError, undefined);
assert.match(result.content?.[0]?.text ?? '', /"online": true/);

await client.close();
await new Promise((resolve) => server.close(resolve));
console.log('fleet bearer auth tests passed');
