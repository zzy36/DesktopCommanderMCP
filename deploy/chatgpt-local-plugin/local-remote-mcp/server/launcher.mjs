import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const programData = process.env.ProgramData ?? process.env.PROGRAMDATA ?? path.join(path.parse(os.homedir()).root, 'ProgramData');
const agentConfigPath = process.env.FLEET_AGENT_CONFIG ?? path.join(programData, 'NetworkFleet', 'agent.json');
let config;
try {
  config = JSON.parse(await fs.readFile(agentConfigPath, 'utf8'));
} catch (error) {
  console.error(`Local Remote MCP launcher cannot read ${agentConfigPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (typeof config.controlRoot !== 'string' || !config.controlRoot.trim()) {
  console.error('Local Remote MCP launcher: controlRoot missing from NetworkFleet agent config');
  process.exit(1);
}
const projectsRoot = path.dirname(path.resolve(config.controlRoot));
const target = path.join(projectsRoot, 'local-mcp', 'local-only', 'mcp', 'DesktopCommanderMCP', 'dist', 'remote-device', 'fleet', 'local-plugin-main.js');
try {
  await fs.access(target);
} catch {
  console.error(`Local Remote MCP launcher cannot find built server at ${target}`);
  process.exit(1);
}
process.env.MACHINE_CONTROL_ROOT = path.resolve(config.controlRoot);
await import(pathToFileURL(target).href);
