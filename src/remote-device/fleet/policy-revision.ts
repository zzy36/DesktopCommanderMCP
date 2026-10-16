import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Only these inputs define authorization. R0 model/UI/profile and documentation
// commits must not disconnect every enrolled device.
export const CONTROL_POLICY_PATHS = [
    'projects.registry.json', 'devices.registry.json', 'coordination.policy.json',
    'commands.registry.json', 'tools/machine-control',
    'tools/coordination_lease.py', 'tools/project_command.py',
];

export async function resolveControlPolicyRevision(controlRoot: string, gitCommand = 'git', timeoutMs = 5_000): Promise<string> {
    const options = { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8' as const };
    // Never attest dirty or untracked authorization inputs as a committed policy.
    const dirty = await execFileAsync(gitCommand, ['-C', controlRoot, 'status', '--porcelain', '--untracked-files=all', '--', ...CONTROL_POLICY_PATHS], options);
    if (dirty.stdout.trim()) throw new Error('authorization inputs have uncommitted changes');
    const { stdout } = await execFileAsync(gitCommand, ['-C', controlRoot, 'log', '-1', '--format=%H', '--', ...CONTROL_POLICY_PATHS], options);
    const revision = stdout.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('no committed authorization policy revision');
    return `control@${revision.slice(0, 12)}`;
}
