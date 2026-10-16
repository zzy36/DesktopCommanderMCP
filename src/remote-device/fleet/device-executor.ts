import { spawn } from 'node:child_process';
import { DesktopCommanderIntegration } from '../desktop-commander-integration.js';

/** An opaque, device-local extension point. LCM does not interpret project policy. */
export interface ExecutionPolicyCommand { command: string; args: string[]; timeoutMs?: number; }
export async function checkExecutionPolicy(policy: ExecutionPolicyCommand | undefined, request: Record<string, unknown>): Promise<void> {
    if (!policy) return; // Owner trust + OS permissions; governance may be installed separately.
    await new Promise<void>((resolve, reject) => {
        const child = spawn(policy.command, policy.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = ''; let bytes = 0; let done = false;
        const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); if (error) { child.kill(); reject(error); } else resolve(); };
        const timer = setTimeout(() => finish(Object.assign(new Error('External execution policy unavailable'), { code: 'EXECUTION_POLICY_UNAVAILABLE' })), policy.timeoutMs ?? 5000);
        child.on('error', () => finish(Object.assign(new Error('External execution policy unavailable'), { code: 'EXECUTION_POLICY_UNAVAILABLE' })));
        child.stdout.on('data', data => { bytes += data.length; if (bytes > 65536) return finish(new Error('External execution policy response too large')); output += data.toString(); });
        // Never log policy stderr: it may contain private local context.
        child.stderr.resume();
        child.on('close', code => {
            try {
                const decision = JSON.parse(output);
                if (code !== 0 || decision.allow !== true) throw Object.assign(new Error(typeof decision.reason === 'string' ? decision.reason : 'External execution policy denied'), { code: 'EXECUTION_POLICY_DENIED' });
                finish();
            } catch (error) { finish(error instanceof Error ? error : new Error('Invalid external policy decision')); }
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(JSON.stringify(request) + '\n');
    });
}

export class DeviceExecutor {
    constructor(private readonly desktop: Pick<DesktopCommanderIntegration, 'callClientTool'>, private readonly hostname: string, private readonly policy?: ExecutionPolicyCommand) {}
    async execute(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
        const args = { ...input }; const context = args._lcm_context; delete args._lcm_context;
        delete args.execution_context;
        await checkExecutionPolicy(this.policy, { hostname: this.hostname, tool: toolName, args, context });
        if (toolName === 'start_process' && args.timeout_ms === undefined) args.timeout_ms = 3000;
        return this.desktop.callClientTool(toolName, args, { local_control_mcp: true, fleet_hostname: this.hostname }, { signal, timeout: 55000, maxTotalTimeout: 55000 });
    }
}
