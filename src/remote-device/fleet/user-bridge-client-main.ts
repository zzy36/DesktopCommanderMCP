import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { InteractiveUserClient } from './interactive-user-bridge.js';
const args = process.argv.slice(2);
const get = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const file = get('--request');
if (!file) throw new Error('--request JSON file required');
const request = JSON.parse(await readFile(file, 'utf8'));
const scopeKind = request.scope_kind === 'machine_control' ? 'machine_control' : 'project';
if (typeof request.hostname !== 'string' || typeof request.tool !== 'string' || !request.args || typeof request.args !== 'object') throw new Error('exact hostname, tool and args required');
if (scopeKind === 'project' && typeof request.project_id !== 'string') throw new Error('project scope requires exact project_id');
if (scopeKind === 'machine_control' && request.project_id) throw new Error('machine_control scope must not borrow project_id');
if (scopeKind === 'machine_control' && request.machine_approval !== true) throw new Error('machine_control scope requires machine_approval=true');
const state = get('--state-dir') ?? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'LocalControlMCP-UserBridge');
try { console.log(JSON.stringify(await new InteractiveUserClient(state).callTool(request.tool, request.args, scopeKind === 'project' ? request.project_id : null, request.hostname, undefined, scopeKind, request.machine_approval === true))); }
catch (error) { console.error(JSON.stringify({ code: (error as { code?: string }).code ?? 'INTERACTIVE_EXECUTION_FAILED', error: error instanceof Error ? error.message : 'interactive failure' })); process.exitCode = 1; }
