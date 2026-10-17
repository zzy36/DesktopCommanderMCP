import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { ControlProjectAuthorization } from './control-policy.js';

export const LCM_PROJECT_TOOLS = new Set([
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

export function textFromToolResult(result: any): string {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content
    .filter((entry: any) => entry?.type === 'text' && typeof entry.text === 'string')
    .map((entry: any) => entry.text).join('\n');
}

export function requirePhysicalRoot(auth: ControlProjectAuthorization): string {
  if (!auth.physicalRoot) {
    throw Object.assign(new Error(`project ${auth.projectId} has no authorized physical_root`), { code: 'PROJECT_DEVICE_DENIED' });
  }
  return path.resolve(auth.physicalRoot);
}

export function scopeProjectPath(raw: unknown, root: string, label: string): string {
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
    args.path = scopeProjectPath(args.path, root, 'path');
    return;
  }
  if (toolName === 'read_multiple_files') {
    if (!Array.isArray(args.paths)) throw new Error('paths must be an array');
    args.paths = args.paths.map((value, index) => scopeProjectPath(value, root, `paths[${index}]`));
    return;
  }
  if (toolName === 'move_file') {
    args.source = scopeProjectPath(args.source, root, 'source');
    args.destination = scopeProjectPath(args.destination, root, 'destination');
    return;
  }
  if (toolName === 'edit_block') {
    args.file_path = scopeProjectPath(args.file_path, root, 'file_path');
    return;
  }
  if (toolName === 'write_pdf') {
    args.path = scopeProjectPath(args.path, root, 'path');
    if (args.outputPath !== undefined) args.outputPath = scopeProjectPath(args.outputPath, root, 'outputPath');
    if (Array.isArray(args.content)) {
      args.content = args.content.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const copy = { ...(entry as Record<string, unknown>) };
        if (copy.sourcePdfPath !== undefined) copy.sourcePdfPath = scopeProjectPath(copy.sourcePdfPath, root, 'sourcePdfPath');
        return copy;
      });
    }
    return;
  }
  args.path = scopeProjectPath(args.path, root, 'path');
}

export function scopeProjectToolArgs(
  toolName: string,
  input: Record<string, unknown>,
  auth: ControlProjectAuthorization,
): Record<string, unknown> {
  if (!LCM_PROJECT_TOOLS.has(toolName)) {
    throw Object.assign(new Error(`tool is not exposed by Local Control MCP: ${toolName}`), { code: 'PROJECT_DEVICE_DENIED' });
  }
  const args: Record<string, unknown> = { ...input };
  delete args.project_id;
  delete args.hostname;
  delete args.execution_context;
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
    if (args.timeout_ms === undefined) args.timeout_ms = 3000;
  }
  return args;
}

export function scopeMachineToolArgs(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!LCM_PROJECT_TOOLS.has(toolName)) {
    throw Object.assign(new Error(`tool is not exposed by Local Control MCP: ${toolName}`), { code: 'PROJECT_DEVICE_DENIED' });
  }
  const args: Record<string, unknown> = { ...input };
  delete args.project_id;
  delete args.hostname;
  delete args.scope_kind;
  delete args.machine_approval;
  delete args.execution_context;
  if (toolName === 'read_file' && args.isUrl === true) {
    throw Object.assign(new Error('read_file URL mode is disabled through Local Control MCP machine scope'), { code: 'PROJECT_DEVICE_DENIED' });
  }
  if (toolName === 'start_process') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command.trim()) throw new Error('command is required');
    const requestedShell = typeof args.shell === 'string' ? args.shell.toLowerCase() : '';
    if (requestedShell && !requestedShell.includes('powershell') && !requestedShell.includes('pwsh')) {
      throw Object.assign(new Error('machine/control start_process permits only PowerShell/pwsh'), { code: 'PROJECT_DEVICE_DENIED' });
    }
    args.shell = requestedShell || 'pwsh';
    if (args.timeout_ms === undefined) args.timeout_ms = 3000;
  }
  return args;
}

export class ProjectResourceScope {
  private readonly ownedProcesses = new Map<number, string>();
  private readonly ownedSearches = new Map<string, string>();

  assertOwned(toolName: string, projectId: string, args: Record<string, unknown>): void {
    if (toolName === 'read_process_output' || toolName === 'interact_with_process' || toolName === 'force_terminate' || toolName === 'kill_process') {
      const pid = Number(args.pid);
      if (!Number.isInteger(pid) || this.ownedProcesses.get(pid) !== projectId) {
        throw Object.assign(new Error(`process ${String(args.pid)} is not owned by scope ${projectId} in this LCM runtime`), { code: 'PROJECT_DEVICE_DENIED' });
      }
    }
    if (toolName === 'get_more_search_results' || toolName === 'stop_search') {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      if (!sessionId || this.ownedSearches.get(sessionId) !== projectId) {
        throw Object.assign(new Error(`search ${sessionId || '<missing>'} is not owned by scope ${projectId} in this LCM runtime`), { code: 'PROJECT_DEVICE_DENIED' });
      }
    }
  }

  record(toolName: string, projectId: string, result: any, args: Record<string, unknown> = {}): void {
    const text = textFromToolResult(result);
    if (toolName === 'start_process') {
      const match = text.match(/Process started with PID\s+(\d+)/i) ?? text.match(/\bPID\s*[:=]?\s*(\d+)\b/i);
      if (match) this.ownedProcesses.set(Number(match[1]), projectId);
    }
    if (toolName === 'start_search') {
      const match = text.match(/search session:\s*([^\s]+)/i) ?? text.match(/session(?:Id| ID)?\s*[:=]\s*([^\s]+)/i);
      if (match) this.ownedSearches.set(match[1], projectId);
    }
    if (toolName === 'force_terminate' || toolName === 'kill_process') {
      const pid = Number(args.pid);
      if (Number.isInteger(pid)) this.ownedProcesses.delete(pid);
    }
    if (toolName === 'stop_search' && typeof args.sessionId === 'string') this.ownedSearches.delete(args.sessionId);
  }

  transform(toolName: string, projectId: string, auth: ControlProjectAuthorization, result: any, deviceName: string): any {
    if (toolName === 'get_config') return this.sanitizeConfig(projectId, auth, result, deviceName);
    if (toolName !== 'list_sessions' && toolName !== 'list_searches') return result;
    const raw = textFromToolResult(result);
    const identifiers = toolName === 'list_sessions'
      ? [...this.ownedProcesses.entries()].filter(([, owner]) => owner === projectId).map(([pid]) => String(pid))
      : [...this.ownedSearches.entries()].filter(([, owner]) => owner === projectId).map(([id]) => id);
    if (identifiers.length === 0) {
      return { content: [{ type: 'text', text: toolName === 'list_sessions' ? 'No LCM-owned terminal sessions.' : 'No LCM-owned searches.' }] };
    }
    const owned = new Set(identifiers);
    const blocks = toolName === 'list_sessions'
      ? raw.split(/\r?\n/).filter(line => { const match = line.match(/^PID:\s*(\d+)(?:\b|,)/); return match && owned.has(match[1]); })
      : raw.split(/\r?\n\s*\r?\n/).filter(block => { const match = block.match(/^Session:\s*([^\s]+)\s*$/m); return match && owned.has(match[1]); });
    return { content: [{ type: 'text', text: blocks.length ? blocks.join('\n\n') : (toolName === 'list_sessions' ? 'No LCM-owned terminal sessions.' : 'No LCM-owned searches.') }] };
  }

  transformDevice(toolName: string, result: any, deviceName: string): any {
    if (toolName === 'get_config') return this.sanitizeDeviceConfig(result, deviceName);
    return result;
  }

  transformMachine(toolName: string, ownerKey: string, result: any, deviceName: string): any {
    if (toolName === 'get_config') return this.sanitizeMachineConfig(result, deviceName);
    if (toolName !== 'list_sessions' && toolName !== 'list_searches') return result;
    const raw = textFromToolResult(result);
    const identifiers = toolName === 'list_sessions'
      ? [...this.ownedProcesses.entries()].filter(([, owner]) => owner === ownerKey).map(([pid]) => String(pid))
      : [...this.ownedSearches.entries()].filter(([, owner]) => owner === ownerKey).map(([id]) => id);
    if (identifiers.length === 0) return { content: [{ type: 'text', text: toolName === 'list_sessions' ? 'No LCM-owned terminal sessions.' : 'No LCM-owned searches.' }] };
    const owned = new Set(identifiers);
    const blocks = toolName === 'list_sessions'
      ? raw.split(/\r?\n/).filter(line => { const match = line.match(/^PID:\s*(\d+)(?:\b|,)/); return match && owned.has(match[1]); })
      : raw.split(/\r?\n\s*\r?\n/).filter(block => { const match = block.match(/^Session:\s*([^\s]+)\s*$/m); return match && owned.has(match[1]); });
    return { content: [{ type: 'text', text: blocks.length ? blocks.join('\n\n') : (toolName === 'list_sessions' ? 'No LCM-owned terminal sessions.' : 'No LCM-owned searches.') }] };
  }

  private sanitizeDeviceConfig(result: any, deviceName: string): any {
    const raw = textFromToolResult(result);
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { /* fallback below */ }
    const source = parsed?.config && typeof parsed.config === 'object' ? parsed.config : parsed;
    const safe = source && typeof source === 'object' ? {
      product: 'Local Control MCP', scope_kind: 'device', device_name: deviceName,
      defaultShell: source.defaultShell,
      fileReadLineLimit: source.fileReadLineLimit, fileWriteLineLimit: source.fileWriteLineLimit,
      telemetryEnabled: source.telemetryEnabled, blockedCommands: source.blockedCommands,
      systemInfo: source.systemInfo ? { platform: source.systemInfo.platform, platformName: source.systemInfo.platformName, isWindows: source.systemInfo.isWindows, isLinux: source.systemInfo.isLinux, isMacOS: source.systemInfo.isMacOS } : undefined,
    } : { product: 'Local Control MCP', scope_kind: 'device', device_name: deviceName };
    return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
  }

  private sanitizeMachineConfig(result: any, deviceName: string): any {
    const raw = textFromToolResult(result);
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { /* fallback below */ }
    const source = parsed?.config && typeof parsed.config === 'object' ? parsed.config : parsed;
    const safe = source && typeof source === 'object' ? {
      product: 'Local Control MCP', scope_kind: 'machine_control', device_name: deviceName,
      version: source.version, defaultShell: source.defaultShell,
      fileReadLineLimit: source.fileReadLineLimit, fileWriteLineLimit: source.fileWriteLineLimit,
      telemetryEnabled: source.telemetryEnabled, blockedCommands: source.blockedCommands,
      systemInfo: source.systemInfo ? { platform: source.systemInfo.platform, platformName: source.systemInfo.platformName, isWindows: source.systemInfo.isWindows, isLinux: source.systemInfo.isLinux, isMacOS: source.systemInfo.isMacOS } : undefined,
    } : { product: 'Local Control MCP', scope_kind: 'machine_control', device_name: deviceName };
    return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
  }

  private sanitizeConfig(projectId: string, auth: ControlProjectAuthorization, result: any, deviceName: string): any {
    const raw = textFromToolResult(result);
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { /* fallback below */ }
    const source = parsed?.config && typeof parsed.config === 'object' ? parsed.config : parsed;
    const safe = source && typeof source === 'object' ? {
      product: 'Local Control MCP', project_id: projectId, device_name: deviceName, physical_root: auth.physicalRoot,
      version: source.version, defaultShell: source.defaultShell,
      fileReadLineLimit: source.fileReadLineLimit, fileWriteLineLimit: source.fileWriteLineLimit,
      telemetryEnabled: source.telemetryEnabled, blockedCommands: source.blockedCommands,
      systemInfo: source.systemInfo ? {
        platform: source.systemInfo.platform, platformName: source.systemInfo.platformName,
        isWindows: source.systemInfo.isWindows, isLinux: source.systemInfo.isLinux, isMacOS: source.systemInfo.isMacOS,
      } : undefined,
    } : { product: 'Local Control MCP', project_id: projectId, device_name: deviceName, physical_root: auth.physicalRoot };
    return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
  }
}

/** Resolve existing ancestors as well as lexical scope: a junction/symlink cannot
 * turn a project file tool into an unrelated-file access. Terminal remains an
 * authorized machine capability, not an invented filesystem sandbox. */
export async function validateProjectToolPaths(toolName: string, args: Record<string, unknown>, auth: ControlProjectAuthorization): Promise<void> {
  if (!PATH_TOOLS.has(toolName)) return;
  const root = await realpath(requirePhysicalRoot(auth));
  const values: unknown[] = toolName === 'read_multiple_files' ? (args.paths as unknown[] ?? [])
    : toolName === 'move_file' ? [args.source, args.destination]
    : toolName === 'edit_block' ? [args.file_path] : [args.path];
  if (toolName === 'write_pdf') {
    if (args.outputPath) values.push(args.outputPath);
    if (Array.isArray(args.content)) for (const entry of args.content) if (entry?.sourcePdfPath) values.push(entry.sourcePdfPath);
  }
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('filesystem path required');
    let ancestor = path.resolve(value);
    let resolved: string;
    for (;;) {
      try { resolved = await realpath(ancestor); break; }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw cause;
        ancestor = parent;
      }
    }
    const relative = path.relative(root, resolved);
    if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) throw Object.assign(new Error('path resolves outside authorized project root'), { code: 'PROJECT_DEVICE_DENIED' });
  }
}
