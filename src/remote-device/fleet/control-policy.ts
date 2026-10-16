import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { createInterface, Interface as ReadlineInterface } from 'node:readline';
import { promisify } from 'node:util';
import { canonicalHostname } from './identity.js';

const execFileAsync = promisify(execFile);

export interface ControlProjectAuthorization {
    scopeKind: 'project';
    projectId: string;
    partitionId: string | null;
    physicalRoot: string | null;
    deviceName: string;
}

export interface ControlMachineAuthorization {
    scopeKind: 'machine_control';
    projectId: null;
    partitionId: null;
    physicalRoot: null;
    deviceName: string;
}

export type ControlAuthorization = ControlProjectAuthorization | ControlMachineAuthorization;

export class ControlPolicyError extends Error {
    readonly code: 'PROJECT_DEVICE_DENIED' | 'POLICY_SKEW';
    readonly details: Readonly<Record<string, unknown>>;

    constructor(
        code: 'PROJECT_DEVICE_DENIED' | 'POLICY_SKEW',
        message: string,
        details: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = 'ControlPolicyError';
        this.code = code;
        this.details = Object.freeze({ ...details });
    }
}

export interface ControlPolicyAuthorizerOptions {
    controlRoot: string;
    pythonCommand?: string;
    gitCommand?: string;
    timeoutMs?: number;
}

type PendingRequest = {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

const BRIDGE_SCRIPT = String.raw`
import json, os, sys
root = os.path.abspath(sys.argv[1])
os.environ['MACHINE_CONTROL_ROOT'] = root
sys.path.insert(0, os.path.join(root, 'tools', 'machine-control'))
import machine_control_gateway as gateway
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request_id = None
    try:
        request = json.loads(line)
        request_id = request.get('id')
        scope_kind = str(request.get('scope_kind') or 'project')
        if scope_kind == 'machine_control':
            result = gateway._authorize_machine_scope(
                str(request.get('hostname') or ''),
                explicit_authorization=(request.get('explicit_authorization') is True),
            )
        elif scope_kind == 'project':
            result = gateway._authorize_project(str(request['project_id']))
        else:
            raise RuntimeError(f'unsupported scope_kind: {scope_kind}')
        payload = {'id': request_id, 'ok': True, 'result': result}
    except Exception as exc:
        payload = {'id': request_id, 'ok': False, 'error': str(exc)}
    print(json.dumps(payload, ensure_ascii=False), flush=True)
`;

export class ControlPolicyAuthorizer {
    private readonly controlRoot: string;
    private readonly pythonCommand: string;
    private readonly gitCommand: string;
    private readonly timeoutMs: number;
    private child: ChildProcessWithoutNullStreams | null = null;
    private readline: ReadlineInterface | null = null;
    private requestCounter = 0;
    private readonly pending = new Map<number, PendingRequest>();
    private stderrTail = '';

    constructor(options: ControlPolicyAuthorizerOptions) {
        if (!options.controlRoot) throw new Error('controlRoot is required');
        this.controlRoot = options.controlRoot;
        this.pythonCommand = options.pythonCommand ?? process.env.FLEET_POLICY_PYTHON ?? 'python';
        this.gitCommand = options.gitCommand ?? process.env.FLEET_POLICY_GIT ?? 'git';
        this.timeoutMs = options.timeoutMs ?? 5_000;
    }

    async warmup(): Promise<void> {
        this.ensureBridge();
        await this.policyRevision();
    }

    async authorize(projectId: string, requestedHostname: string): Promise<ControlProjectAuthorization> {
        if (!projectId) throw new ControlPolicyError('PROJECT_DEVICE_DENIED', 'project_id is required');
        const hostname = canonicalHostname(requestedHostname);
        try {
            const raw = await this.requestAuthorization(projectId);
            const deviceName = typeof raw.device_name === 'string' ? raw.device_name : '';
            if (!deviceName || canonicalHostname(deviceName) !== hostname) {
                throw new ControlPolicyError(
                    'PROJECT_DEVICE_DENIED',
                    `project ${projectId} was authorized for a different local device`,
                    { projectId, requestedHostname: hostname, localDevice: deviceName || null },
                );
            }
            return {
                scopeKind: 'project',
                projectId,
                partitionId: typeof raw.partition_id === 'string' ? raw.partition_id : null,
                physicalRoot: typeof raw.physical_root === 'string' ? raw.physical_root : null,
                deviceName: canonicalHostname(deviceName),
            };
        } catch (error) {
            if (error instanceof ControlPolicyError) throw error;
            throw new ControlPolicyError(
                'PROJECT_DEVICE_DENIED',
                `local .control policy denied ${projectId} on ${hostname}`,
                {
                    projectId,
                    hostname,
                    cause: error instanceof Error ? error.message : String(error),
                },
            );
        }
    }

    async authorizeMachine(requestedHostname: string, explicitAuthorization: boolean): Promise<ControlMachineAuthorization> {
        const hostname = canonicalHostname(requestedHostname);
        if (!hostname) throw new ControlPolicyError('PROJECT_DEVICE_DENIED', 'machine/control scope requires exact hostname');
        if (!explicitAuthorization) throw new ControlPolicyError('PROJECT_DEVICE_DENIED', 'machine/control scope requires explicit current-task authorization');
        try {
            const raw = await this.requestMachineAuthorization(hostname, explicitAuthorization);
            const deviceName = typeof raw.device_name === 'string' ? raw.device_name : '';
            if (!deviceName || canonicalHostname(deviceName) !== hostname || raw.scope_kind !== 'machine_control') {
                throw new ControlPolicyError(
                    'PROJECT_DEVICE_DENIED',
                    'machine/control scope was authorized for a different local device',
                    { requestedHostname: hostname, localDevice: deviceName || null },
                );
            }
            return { scopeKind: 'machine_control', projectId: null, partitionId: null, physicalRoot: null, deviceName: canonicalHostname(deviceName) };
        } catch (error) {
            if (error instanceof ControlPolicyError) throw error;
            throw new ControlPolicyError(
                'PROJECT_DEVICE_DENIED',
                `local .control policy denied machine/control scope on ${hostname}`,
                { hostname, cause: error instanceof Error ? error.message : String(error) },
            );
        }
    }

    async policyRevision(): Promise<string> {
        try {
            const { stdout } = await execFileAsync(
                this.gitCommand,
                ['-C', this.controlRoot, 'rev-parse', 'HEAD'],
                {
                    windowsHide: true,
                    timeout: this.timeoutMs,
                    maxBuffer: 64 * 1024,
                    encoding: 'utf8',
                },
            );
            const head = stdout.trim().toLowerCase();
            if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`invalid git HEAD: ${head}`);
            return `control@${head.slice(0, 12)}`;
        } catch (error) {
            throw new ControlPolicyError(
                'POLICY_SKEW',
                'unable to resolve local .control policy revision',
                { cause: error instanceof Error ? error.message : String(error) },
            );
        }
    }

    async stop(): Promise<void> {
        const child = this.child;
        this.child = null;
        this.readline?.close();
        this.readline = null;
        this.rejectAll(new Error('control policy bridge stopped'));
        if (!child || child.killed) return;
        child.stdin.end();
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                child.kill();
                resolve();
            }, 500);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    private requestAuthorization(projectId: string): Promise<Record<string, unknown>> {
        return this.requestPolicy({ scope_kind: 'project', project_id: projectId }, `project ${projectId}`);
    }

    private requestMachineAuthorization(hostname: string, explicitAuthorization: boolean): Promise<Record<string, unknown>> {
        return this.requestPolicy(
            { scope_kind: 'machine_control', hostname, explicit_authorization: explicitAuthorization },
            `machine ${hostname}`,
        );
    }

    private requestPolicy(payload: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
        const child = this.ensureBridge();
        const id = ++this.requestCounter;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`control policy request timed out: ${label}`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
                if (!error) return;
                const pending = this.pending.get(id);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.reject(error);
            });
        });
    }

    private ensureBridge(): ChildProcessWithoutNullStreams {
        if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;

        const child = spawn(
            this.pythonCommand,
            ['-u', '-c', BRIDGE_SCRIPT, this.controlRoot],
            {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        );
        this.child = child;
        this.stderrTail = '';
        const readline = createInterface({ input: child.stdout });
        this.readline = readline;

        readline.on('line', (line) => this.handleBridgeLine(line));
        child.stderr.on('data', (chunk) => {
            this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-8_000);
        });
        child.on('error', (error) => {
            if (this.child === child) this.child = null;
            this.rejectAll(error);
        });
        child.on('exit', (code, signal) => {
            if (this.child === child) this.child = null;
            const details = this.stderrTail.trim();
            this.rejectAll(new Error(
                `control policy bridge exited (${String(code ?? signal ?? 'unknown')})${details ? `: ${details}` : ''}`,
            ));
        });
        return child;
    }

    private handleBridgeLine(line: string): void {
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(line) as Record<string, unknown>;
        } catch {
            return;
        }
        const id = typeof payload.id === 'number' ? payload.id : null;
        if (id === null) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (payload.ok === true && payload.result && typeof payload.result === 'object') {
            pending.resolve(payload.result as Record<string, unknown>);
            return;
        }
        pending.reject(new Error(typeof payload.error === 'string' ? payload.error : 'control policy denied'));
    }

    private rejectAll(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
