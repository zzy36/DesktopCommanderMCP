import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const programData = process.env.ProgramData ?? process.env.PROGRAMDATA ?? path.join(path.parse(os.homedir()).root, 'ProgramData');
const sharedRoot = path.join(programData, 'LocalRemoteMCP');
const runtimeConfigPath = process.env.LOCAL_REMOTE_MCP_CONFIG ?? path.join(sharedRoot, 'runtime.json');

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

const runtimeConfig = await readJson(runtimeConfigPath);
const agentConfigPath = process.env.FLEET_AGENT_CONFIG ?? path.join(programData, 'NetworkFleet', 'agent.json');
const agentConfig = await readJson(agentConfigPath);

const controlRoot = process.env.MACHINE_CONTROL_ROOT
  ?? (typeof runtimeConfig?.controlRoot === 'string' ? runtimeConfig.controlRoot : null)
  ?? (typeof agentConfig?.controlRoot === 'string' ? agentConfig.controlRoot : null);
if (!controlRoot) {
  console.error(`Local Remote MCP launcher cannot resolve controlRoot from env, ${runtimeConfigPath}, or ${agentConfigPath}`);
  process.exit(1);
}

const runtimeCandidates = [];
if (process.env.LOCAL_REMOTE_MCP_RUNTIME) runtimeCandidates.push(process.env.LOCAL_REMOTE_MCP_RUNTIME);
if (typeof runtimeConfig?.runtimeRoot === 'string' && runtimeConfig.runtimeRoot.trim()) runtimeCandidates.push(runtimeConfig.runtimeRoot);
runtimeCandidates.push(path.join(sharedRoot, 'DesktopCommanderMCP'));

// Development compatibility only. Production bootstrap installs the shared ProgramData runtime above.
const projectsRoot = path.dirname(path.resolve(controlRoot));
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
  console.error(`Local Remote MCP launcher cannot find a built runtime. Checked: ${runtimeCandidates.join('; ')}`);
  process.exit(1);
}

process.env.MACHINE_CONTROL_ROOT = path.resolve(controlRoot);
await import(pathToFileURL(target).href);
