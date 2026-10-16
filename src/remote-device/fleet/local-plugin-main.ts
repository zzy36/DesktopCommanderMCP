import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DesktopCommanderIntegration } from '../desktop-commander-integration.js';
import { ControlPolicyAuthorizer } from './control-policy.js';
import { LCM_PROJECT_TOOLS, ProjectResourceScope, scopeProjectToolArgs, validateProjectToolPaths } from './project-tool-contract.js';
import { localizeLcmTool, localizeLcmError } from './presentation-zh.js';
import { LCM_ICONS, LCM_BRAND_TITLE } from './branding.js';

const stderr = (...args: unknown[]) => process.stderr.write(`${args.map(formatLogValue).join(' ')}\n`);
console.log = stderr;
console.debug = stderr;
console.info = stderr;
console.warn = stderr;
console.error = stderr;

const localHostname = canonicalLocalHostname(os.hostname());

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function canonicalLocalHostname(value: string): string {
  return value.trim().split('.')[0].toUpperCase();
}

async function resolveControlRoot(): Promise<string> {
  const fromEnv = process.env.MACHINE_CONTROL_ROOT ?? process.env.FLEET_CONTROL_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  const programData = process.env.ProgramData ?? process.env.PROGRAMDATA ?? path.join(path.parse(os.homedir()).root, 'ProgramData');
  const agentConfig = path.join(programData, 'NetworkFleet', 'agent.json');
  try {
    const parsed = JSON.parse(await fs.readFile(agentConfig, 'utf8')) as { controlRoot?: unknown };
    if (typeof parsed.controlRoot === 'string' && parsed.controlRoot.trim()) return path.resolve(parsed.controlRoot);
  } catch { /* fall through */ }
  throw new Error('Unable to resolve .control root. Set MACHINE_CONTROL_ROOT or provision NetworkFleet agent config.');
}

function addProjectIdSchema(tool: any): any {
  const original = tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema : { type: 'object', properties: {} };
  const properties = original.properties && typeof original.properties === 'object'
    ? original.properties : {};
  const required = Array.isArray(original.required)
    ? original.required.filter((v: unknown) => typeof v === 'string') : [];
  const normalizedRequired = tool.name === 'start_process'
    ? required.filter((name: string) => name !== 'timeout_ms')
    : required;
  return {
    ...tool,
        icons: LCM_ICONS,
    description: `Local Control MCP：在 ${localHostname} 执行；每次调用通过本机 .control 重新核对 project_id。${tool.description ?? ''}`.trim(),
    inputSchema: {
      ...original,
      type: 'object',
      properties: {
        project_id: {
          type: 'string', minLength: 1,
          description: '当前真实 L3 project_id；授权失败时不得替换项目。',
        },
        ...properties,
      },
      required: ['project_id', ...normalizedRequired.filter((name: string) => name !== 'project_id')],
    },
  };
}

async function main(): Promise<void> {
  const controlRoot = await resolveControlRoot();
  const authorizer = new ControlPolicyAuthorizer({ controlRoot });
  const desktop = new DesktopCommanderIntegration();
  const resources = new ProjectResourceScope();
  await authorizer.warmup();
  await desktop.initialize();
  const listed = await desktop.listClientTools();
  const exposed = listed.tools.filter((tool: any) => LCM_PROJECT_TOOLS.has(tool.name)).map(localizeLcmTool).map(addProjectIdSchema);
  const byName = new Map(exposed.map((tool: any) => [tool.name, tool]));

  const server = new Server(
    { name: 'local-control-mcp', title: LCM_BRAND_TITLE, icons: LCM_ICONS, version: '0.3.5' },
    { capabilities: { tools: {} }, instructions: 'Local Control MCP 是自托管项目控制主通道。每次调用必须提供真实 L3 project_id，并由本机 .control 重新授权。此服务不调用托管 RDC。' },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposed }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    if (!byName.has(toolName)) {
      return { content: [{ type: 'text', text: `Local Control MCP 未开放工具 ${toolName}` }], isError: true };
    }
    const rawArgs = request.params.arguments && typeof request.params.arguments === 'object'
      ? request.params.arguments as Record<string, unknown> : {};
    const projectId = typeof rawArgs.project_id === 'string' ? rawArgs.project_id.trim() : '';
    if (!projectId) {
      return { content: [{ type: 'text', text: 'PROJECT_DEVICE_DENIED: 必须提供真实 project_id' }], isError: true };
    }
    try {
      const auth = await authorizer.authorize(projectId, localHostname);
      resources.assertOwned(toolName, projectId, rawArgs);
      const args = scopeProjectToolArgs(toolName, rawArgs, auth);
      await validateProjectToolPaths(toolName, args, auth);
      const result = await desktop.callClientTool(toolName, args, {
        project_id: projectId,
        local_control_mcp: true,
        physical_root: auth.physicalRoot,
      });
      resources.record(toolName, projectId, result, args);
      return resources.transform(toolName, projectId, auth, result, localHostname) as any;
    } catch (error) {
      const code = typeof (error as any)?.code === 'string' ? `${(error as any).code}: ` : '';
      const message = localizeLcmError(error);
      return { content: [{ type: 'text', text: `${code}${message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await desktop.shutdown().catch(() => undefined);
    await authorizer.stop().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  await server.connect(transport);
}

void main().catch((error) => {
  stderr('Local Control MCP failed to start:', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
