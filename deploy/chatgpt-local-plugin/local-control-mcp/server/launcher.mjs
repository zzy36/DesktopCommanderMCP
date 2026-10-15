import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const programData = process.env.ProgramData ?? process.env.PROGRAMDATA ?? path.join(path.parse(os.homedir()).root, 'ProgramData');
const canonicalRoot = path.join(programData, 'LocalControlMCP');
const legacyRoot = path.join(programData, 'LocalRemoteMCP');

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function firstJson(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const parsed = await readJson(candidate);
    if (parsed) return { path: candidate, value: parsed };
  }
  return { path: candidates.filter(Boolean)[0] ?? path.join(canonicalRoot, 'runtime.json'), value: null };
}

const runtimeConfigResolved = await firstJson([
  process.env.LOCAL_CONTROL_MCP_CONFIG,
  process.env.LOCAL_REMOTE_MCP_CONFIG,
  path.join(canonicalRoot, 'runtime.json'),
  path.join(legacyRoot, 'runtime.json'),
]);
const runtimeConfigPath = runtimeConfigResolved.path;
const runtimeConfig = runtimeConfigResolved.value;

const agentConfigPath = process.env.FLEET_AGENT_CONFIG ?? path.join(programData, 'NetworkFleet', 'agent.json');
const agentConfig = await readJson(agentConfigPath);
const controlRoot = process.env.MACHINE_CONTROL_ROOT
  ?? (typeof runtimeConfig?.controlRoot === 'string' ? runtimeConfig.controlRoot : null)
  ?? (typeof agentConfig?.controlRoot === 'string' ? agentConfig.controlRoot : null);
if (!controlRoot) {
  console.error(`Local Control MCP launcher cannot resolve controlRoot from env, ${runtimeConfigPath}, or ${agentConfigPath}`);
  process.exit(1);
}

const runtimeCandidates = [];
if (process.env.LOCAL_CONTROL_MCP_RUNTIME) runtimeCandidates.push(process.env.LOCAL_CONTROL_MCP_RUNTIME);
if (process.env.LOCAL_REMOTE_MCP_RUNTIME) runtimeCandidates.push(process.env.LOCAL_REMOTE_MCP_RUNTIME);
if (typeof runtimeConfig?.runtimeRoot === 'string' && runtimeConfig.runtimeRoot.trim()) runtimeCandidates.push(runtimeConfig.runtimeRoot);
runtimeCandidates.push(path.join(canonicalRoot, 'DesktopCommanderMCP'));
// One-way migration compatibility. Remove after the old ProgramData runtime is formally retired.
runtimeCandidates.push(path.join(legacyRoot, 'DesktopCommanderMCP'));

const projectsRoot = path.dirname(path.resolve(controlRoot));
runtimeCandidates.push(path.join(projectsRoot, 'local-control-mcp', 'local-only', 'mcp', 'DesktopCommanderMCP'));
// Development rollback compatibility only.
runtimeCandidates.push(path.join(projectsRoot, 'local-mcp', 'local-only', 'mcp', 'DesktopCommanderMCP'));

let target = null;
for (const candidate of runtimeCandidates) {
  const root = path.resolve(candidate);
  const file = root.toLowerCase().endsWith('.js')
    ? root
    : path.join(root, 'dist', 'remote-device', 'fleet', 'local-plugin-main.js');
  try { await fs.access(file); target = file; break; } catch { /* try next */ }
}
if (!target) {
  console.error(`Local Control MCP launcher cannot find a built runtime. Checked: ${runtimeCandidates.join('; ')}`);
  process.exit(1);
}

process.env.MACHINE_CONTROL_ROOT = path.resolve(controlRoot);
await import(pathToFileURL(target).href);
