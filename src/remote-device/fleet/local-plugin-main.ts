import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DesktopCommanderIntegration } from '../desktop-commander-integration.js';
import { ControlPolicyAuthorizer, ControlProjectAuthorization } from './control-policy.js';

const stderr = (...args: unknown[]) => process.stderr.write(`${args.map(formatLogValue).join(' ')}\n`);
console.log = stderr;
console.debug = stderr;
console.info = stderr;
console.warn = stderr;
console.error = stderr;

const EXPOSED_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'write_file', 'write_pdf',
  'create_directory', 'list_directory', 'move_file', 'get_file_info', 'edit_block',
  'start_search', 'get_more_search_results', 'stop_search',
  'start_process', 'read_process_output', 'interact_with_process', 'force_terminate',
  'list_sessions', 'list_searches', 'kill_process', 'get_config',
]);

const PATH_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'write_file', 'write_pdf',
  'create_directory', 'list_directory', 'move_file', 'get_file_info', 'edit_block', 'start_search',
]);

const localHostname = canonicalLocalHostname(os.hostname());
const ownedProcesses = new Map<number, string>();
const ownedSearches = new Map<string, string>();

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
  if (programData) {
    const agentConfig = path.join(programData, 'NetworkFleet', 'agent.json');
    try {
      const parsed = JSON.parse(await fs.readFile(agentConfig, 'utf8')) as { controlRoot?: unknown };
      if (typeof parsed.controlRoot === 'string' && parsed.controlRoot.trim()) {
        return path.resolve(parsed.controlRoot);
      }
    } catch { /* fall through */ }
  }
  throw new Error('Unable to resolve .control root. Set MACHINE_CONTROL_ROOT or provision NetworkFleet agent config.');
}

function addProjectIdSchema(tool: any): any {
  const original = tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema : { type: 'object', properties: {} };
  const properties = original.properties && typeof original.properties === 'object'
    ? original.properties : {};
  const required = Array.isArray(original.required)
    ? original.required.filter((v: unknown) => typeof v === 'string') : [];
  return {
    ...tool,
    description: `Local Control MCP on ${localHostname}. Requires exact active L3 project_id and re-authorizes it through local .control. ${tool.description ?? ''}`.trim(),
    inputSchema: {
      ...original,
      type: 'object',
      properties: {
        project_id: {
          type: 'string', minLength: 1,
          description: 'Exact active L3 project_id. Never substitute another project when authorization fails.',
        },
        ...properties,
      },
      required: ['project_id', ...required.filter((name: string) => name !== 'project_id')],
    },
  };
}
function requirePhysicalRoot(auth: ControlProjectAuthorization): string {
  if (!auth.physicalRoot) {
    throw Object.assign(new Error(`project ${auth.projectId} has no authorized physical_root`), { code: 'PROJECT_DEVICE_DENIED' });
  }
  return path.resolve(auth.physicalRoot);
}

function scopePath(raw: unknown, root: string, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw Object.assign(new Error(`${label} must be a non-empty filesystem path`), { code: 'PROJECT_DEVICE_DENIED' });
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw Object.assign(new Error(`${label} URL access is not permitted through Local Control MCP`), { code: 'PROJECT_DEVICE_DENIED' });
  }
  const candidate = path.resolve(root, raw);
  const relative = path.relative(root, candidate);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw Object.assign(new Error(`${label} escapes authorized project root`), { code: 'PROJECT_DEVICE_DENIED' });
  }
  return candidate;
}

function scopeFileArgs(toolName: string, args: Record<string, unknown>, auth: ControlProjectAuthorization): void {
  if (!PATH_TOOLS.has(toolName)) return;
  const root = requirePhysicalRoot(auth);
  if (toolName === 'read_file') {
    if (args.isUrl === true) throw Object.assign(new Error('read_file URL mode is disabled'), { code: 'PROJECT_DEVICE_DENIED' });
    args.path = scopePath(args.path, root, 'path');
    return;
  }
  if (toolName === 'read_multiple_files') {
    if (!Array.isArray(args.paths)) throw new Error('paths must be an array');
    args.paths = args.paths.map((value, index) => scopePath(value, root, `paths[${index}]`));
    return;
  }
  if (toolName === 'move_file') {
    args.source = scopePath(args.source, root, 'source');
    args.destination = scopePath(args.destination, root, 'destination');
    return;
  }
  if (toolName === 'edit_block') {
    args.file_path = scopePath(args.file_path, root, 'file_path');
    return;
  }
  if (toolName === 'write_pdf') {
    args.path = scopePath(args.path, root, 'path');
    if (args.outputPath !== undefined) args.outputPath = scopePath(args.outputPath, root, 'outputPath');
    if (Array.isArray(args.content)) {
      args.content = args.content.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const copy = { ...(entry as Record<string, unknown>) };
        if (copy.sourcePdfPath !== undefined) {
          copy.sourcePdfPath = scopePath(copy.sourcePdfPath, root, 'sourcePdfPath');
        }
        return copy;
      });
    }
    return;
  }
  args.path = scopePath(args.path, root, 'path');
}

function scopeArgs(toolName: string, input: Record<string, unknown>, auth: ControlProjectAuthorization): Record<string, unknown> {
  const args: Record<string, unknown> = { ...input };
  delete args.project_id;
  scopeFileArgs(toolName, args, auth);
  if (toolName === 'start_process') {
    const root = requirePhysicalRoot(auth);
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command.trim()) throw new Error('command is required');
    const requestedShell = typeof args.shell === 'string' ? args.shell.toLowerCase() : '';
    if (requestedShell && !requestedShell.includes('powershell') && !requestedShell.includes('pwsh')) {
      throw Object.assign(new Error('start_process permits only PowerShell/pwsh for deterministic project-root initialization'), { code: 'PROJECT_DEVICE_DENIED' });
    }
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    args.command = `$env:FLEET_PROJECT_ID=${quote(auth.projectId)}; $env:FLEET_PROJECT_ROOT=${quote(root)}; Set-Location -LiteralPath ${quote(root)}; ${command}`;
    args.shell = requestedShell || 'pwsh';
  }
  return args;
}

function textFromResult(result: any): string {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content
    .filter((entry: any) => entry?.type === 'text' && typeof entry.text === 'string')
    .map((entry: any) => entry.text).join('\n');
}
function recordOwnership(toolName: string, projectId: string, result: any): void {
  const text = textFromResult(result);
  if (toolName === 'start_process') {
    const match = text.match(/Process started with PID\s+(\d+)/i) ?? text.match(/\bPID\s*[:=]?\s*(\d+)\b/i);
    if (match) ownedProcesses.set(Number(match[1]), projectId);
  }
  if (toolName === 'start_search') {
    const match = text.match(/search session:\s*([^\s]+)/i) ?? text.match(/session(?:Id| ID)?\s*[:=]\s*([^\s]+)/i);
    if (match) ownedSearches.set(match[1], projectId);
  }
}

function assertOwnedContinuation(toolName: string, projectId: string, args: Record<string, unknown>): void {
  if (toolName === 'read_process_output' || toolName === 'interact_with_process' || toolName === 'force_terminate' || toolName === 'kill_process') {
    const pid = Number(args.pid);
    if (!Number.isInteger(pid) || ownedProcesses.get(pid) !== projectId) {
      throw Object.assign(new Error(`process ${String(args.pid)} is not owned by project ${projectId} in this Local Control MCP session`), { code: 'PROJECT_DEVICE_DENIED' });
    }
  }
  if (toolName === 'get_more_search_results' || toolName === 'stop_search') {
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
    if (!sessionId || ownedSearches.get(sessionId) !== projectId) {
      throw Object.assign(new Error(`search ${sessionId || '<missing>'} is not owned by project ${projectId} in this Local Control MCP session`), { code: 'PROJECT_DEVICE_DENIED' });
    }
  }
}

function scopedInventoryResult(toolName: string, projectId: string, result: any): any {
  if (toolName !== 'list_sessions' && toolName !== 'list_searches') return result;
  const raw = textFromResult(result);
  const identifiers = toolName === 'list_sessions'
    ? [...ownedProcesses.entries()].filter(([, owner]) => owner === projectId).map(([pid]) => String(pid))
    : [...ownedSearches.entries()].filter(([, owner]) => owner === projectId).map(([id]) => id);
  if (identifiers.length === 0) {
    return { content: [{ type: 'text', text: toolName === 'list_sessions' ? 'No LCM-owned terminal sessions.' : 'No LCM-owned searches.' }] };
  }
  const blocks = raw.split(/\r?\n\s*\r?\n/).filter((block) => identifiers.some((id) => block.includes(id)));
  return { content: [{ type: 'text', text: blocks.length ? blocks.join('\n\n') : identifiers.join('\n') }] };
}

function sanitizedConfigResult(projectId: string, auth: ControlProjectAuthorization, result: any): any {
  const raw = textFromResult(result);
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* sanitized fallback below */ }
  const source = parsed?.config && typeof parsed.config === 'object' ? parsed.config : parsed;
  const safe = source && typeof source === 'object' ? {
    product: 'Local Control MCP',
    project_id: projectId,
    device_name: localHostname,
    physical_root: auth.physicalRoot,
    version: source.version,
    defaultShell: source.defaultShell,
    fileReadLineLimit: source.fileReadLineLimit,
    fileWriteLineLimit: source.fileWriteLineLimit,
    telemetryEnabled: source.telemetryEnabled,
    blockedCommands: source.blockedCommands,
    systemInfo: source.systemInfo ? {
      platform: source.systemInfo.platform,
      platformName: source.systemInfo.platformName,
      isWindows: source.systemInfo.isWindows,
      isLinux: source.systemInfo.isLinux,
      isMacOS: source.systemInfo.isMacOS,
    } : undefined,
  } : {
    product: 'Local Control MCP', project_id: projectId, device_name: localHostname, physical_root: auth.physicalRoot,
  };
  return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
}
async function main(): Promise<void> {
  const controlRoot = await resolveControlRoot();
  const authorizer = new ControlPolicyAuthorizer({ controlRoot });
  const desktop = new DesktopCommanderIntegration();
  await authorizer.warmup();
  await desktop.initialize();
  const listed = await desktop.listClientTools();
  const exposed = listed.tools.filter((tool: any) => EXPOSED_TOOLS.has(tool.name)).map(addProjectIdSchema);
  const byName = new Map(exposed.map((tool: any) => [tool.name, tool]));

  const server = new Server(
    { name: 'local-control-mcp', version: '0.3.0' },
    { capabilities: { tools: {} }, instructions: 'Default local remote-control path. Every call requires exact L3 project_id and is re-authorized by local .control. Official Remote MCP is not used by this server.' },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposed }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    if (!byName.has(toolName)) {
      return { content: [{ type: 'text', text: `Tool ${toolName} is not exposed by Local Control MCP` }], isError: true };
    }
    const rawArgs = request.params.arguments && typeof request.params.arguments === 'object'
      ? request.params.arguments as Record<string, unknown> : {};
    const projectId = typeof rawArgs.project_id === 'string' ? rawArgs.project_id.trim() : '';
    if (!projectId) {
      return { content: [{ type: 'text', text: 'PROJECT_DEVICE_DENIED: exact project_id is required' }], isError: true };
    }
    try {
      const auth = await authorizer.authorize(projectId, localHostname);
      assertOwnedContinuation(toolName, projectId, rawArgs);
      const args = scopeArgs(toolName, rawArgs, auth);
      const result = await desktop.callClientTool(toolName, args, {
        project_id: projectId,
        local_control_mcp: true,
        physical_root: auth.physicalRoot,
      });
      recordOwnership(toolName, projectId, result);
      if (toolName === 'get_config') return sanitizedConfigResult(projectId, auth, result);
      return scopedInventoryResult(toolName, projectId, result) as any;
    } catch (error) {
      const code = typeof (error as any)?.code === 'string' ? `${(error as any).code}: ` : '';
      const message = error instanceof Error ? error.message : String(error);
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
