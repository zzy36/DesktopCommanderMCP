import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { InteractiveUserClient } from './interactive-user-bridge.js';
const args = process.argv.slice(2);
const get = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const file = get('--request');
if (!file) throw new Error('--request JSON file required');
const request = JSON.parse(await readFile(file, 'utf8'));
if (typeof request.project_id !== 'string' || typeof request.hostname !== 'string' || typeof request.tool !== 'string' || !request.args || typeof request.args !== 'object') throw new Error('exact project_id, hostname, tool and args required');
const state = get('--state-dir') ?? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'LocalControlMCP-UserBridge');
try { console.log(JSON.stringify(await new InteractiveUserClient(state).callTool(request.tool, request.args, request.project_id, request.hostname))); }
catch (error) { console.error(JSON.stringify({ code: (error as { code?: string }).code ?? 'INTERACTIVE_EXECUTION_FAILED', error: error instanceof Error ? error.message : 'interactive failure' })); process.exitCode = 1; }
