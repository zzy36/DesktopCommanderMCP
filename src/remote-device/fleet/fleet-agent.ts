import { InteractiveUserClient } from './interactive-user-bridge.js';
import os from 'node:os';
import path from 'node:path';
import { DesktopCommanderIntegration } from '../desktop-commander-integration.js';
import { ControlAuthorization, ControlPolicyAuthorizer, ControlPolicyError, ControlProjectAuthorization } from './control-policy.js';
import { DeviceIdentityStore, StoredFleetIdentity } from './device-identity.js';
import { FleetChannel, FleetChannelOptions, FleetChannelState } from './fleet-channel.js';
import { canonicalHostname } from './identity.js';
import { ProjectResourceScope, scopeMachineToolArgs, scopeProjectToolArgs, validateProjectToolPaths } from './project-tool-contract.js';

export interface FleetToolPolicyContext {
    authorization: ControlAuthorization;
    scopeKind: 'project' | 'machine_control';
    projectId: string | null;
    hostname: string;
    callId: string;
    generation: number;
}

export type FleetToolPolicy = (
    toolName: string,
    args: Record<string, unknown>,
    context: FleetToolPolicyContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface FleetAgentOptions {
    gatewayUrl: string;
    controlRoot: string;
    stateDir: string;
    toolPolicy: FleetToolPolicy;
    hostname?: string;
    interactiveStateDir?: string;
    desktop?: DesktopCommanderIntegration;
    policyWatchMs?: number;
    channel?: Partial<Pick<
        FleetChannelOptions,
        | 'reconnectBaseMs'
        | 'reconnectMaxMs'
        | 'heartbeatMs'
        | 'heartbeatTimeoutMs'
        | 'callTimeoutMs'
        | 'maxInFlight'
        | 'completedResultCacheSize'
        | 'random'
        | 'socketFactory'
    >>;
}

export interface FleetAgentState {
    started: boolean;
    hostname: string;
    policyRevision: string | null;
    publicKeyFingerprint: string | null;
    desktopReady: boolean;
    channel: FleetChannelState | null;
}

export class FleetAgent {
    private readonly options: FleetAgentOptions;
    private readonly hostname: string;
    private readonly authorizer: ControlPolicyAuthorizer;
    private readonly identityStore: DeviceIdentityStore;
    private readonly desktop: DesktopCommanderIntegration;
    private channel: FleetChannel | null = null;
    private identity: StoredFleetIdentity | null = null;
    private policyRevision: string | null = null;
    private policyTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    private refreshPromise: Promise<void> | null = null;
    private readonly resources = new ProjectResourceScope();
    private readonly processContexts = new Map<number, string>();
    private readonly searchContexts = new Map<string, string>();

    constructor(options: FleetAgentOptions) {
        if (!options.gatewayUrl) throw new Error('gatewayUrl is required');
        if (!options.controlRoot) throw new Error('controlRoot is required');
        if (!options.stateDir) throw new Error('stateDir is required');
        if (!options.toolPolicy) throw new Error('toolPolicy is required');
        this.options = options;
        this.hostname = canonicalHostname(options.hostname ?? os.hostname());
        this.authorizer = new ControlPolicyAuthorizer({ controlRoot: options.controlRoot });
        this.identityStore = new DeviceIdentityStore({ stateDir: options.stateDir });
        this.desktop = options.desktop ?? new DesktopCommanderIntegration();
    }

    getState(): FleetAgentState {
        return {
            started: this.started,
            hostname: this.hostname,
            policyRevision: this.policyRevision,
            publicKeyFingerprint: this.identity?.publicKeyFingerprint ?? null,
            desktopReady: this.desktop.ready,
            channel: this.channel?.getState() ?? null,
        };
    }

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        try {
            await this.authorizer.warmup();
            this.policyRevision = await this.authorizer.policyRevision();
            this.identity = await this.identityStore.loadOrCreate(this.hostname);
            await this.desktop.initialize();
            await this.replaceChannel(this.policyRevision);
            this.startPolicyWatcher();
        } catch (error) {
            this.started = false;
            await this.stopComponents();
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (!this.started && !this.channel) return;
        this.started = false;
        if (this.policyTimer) clearInterval(this.policyTimer);
        this.policyTimer = null;
        await this.stopComponents();
    }

    private async stopComponents(): Promise<void> {
        const channel = this.channel;
        this.channel = null;
        await channel?.stop().catch(() => undefined);
        await this.desktop.shutdown().catch(() => undefined);
        await this.authorizer.stop().catch(() => undefined);
    }

    private startPolicyWatcher(): void {
        if (this.policyTimer) clearInterval(this.policyTimer);
        const watchMs = this.options.policyWatchMs ?? 5_000;
        this.policyTimer = setInterval(() => {
            void this.refreshPolicyRevision().catch(() => undefined);
        }, watchMs);
    }

    private async refreshPolicyRevision(): Promise<void> {
        if (!this.started) return;
        if (!this.refreshPromise) {
            this.refreshPromise = this.refreshPolicyRevisionOnce()
                .catch(async (error) => {
                    await this.suspendChannel();
                    throw error;
                })
                .finally(() => {
                    this.refreshPromise = null;
                });
        }
        await this.refreshPromise;
    }

    private async refreshPolicyRevisionOnce(): Promise<void> {
        const revision = await this.authorizer.policyRevision();
        if (!this.started) return;
        if (revision === this.policyRevision && this.channel) return;
        this.policyRevision = revision;
        await this.replaceChannel(revision);
    }

    private async suspendChannel(): Promise<void> {
        const channel = this.channel;
        this.channel = null;
        await channel?.stop().catch(() => undefined);
    }

    private async replaceChannel(revision: string): Promise<void> {
        if (!this.identity) throw new Error('fleet identity is not initialized');
        const previous = this.channel;
        this.channel = null;
        await previous?.stop();

        const channel = new FleetChannel({
            url: this.options.gatewayUrl,
            hostname: this.hostname,
            policyRevision: revision,
            agentVersion: process.env.LCM_RELEASE,
            publicKeyPem: this.identity.publicKeyPem,
            privateKey: this.identity.privateKeyPem,
            authorize: async (projectId, hostname) => {
                const currentRevision = await this.authorizer.policyRevision();
                if (currentRevision !== revision) {
                    throw new ControlPolicyError('POLICY_SKEW', 'local .control policy changed after this Fleet session was authenticated', { sessionRevision: revision, currentRevision });
                }
                await this.authorizer.authorize(projectId, hostname);
                return true;
            },
            authorizeMachine: async (hostname, explicitAuthorization) => {
                const currentRevision = await this.authorizer.policyRevision();
                if (currentRevision !== revision) {
                    throw new ControlPolicyError('POLICY_SKEW', 'local .control policy changed after this Fleet session was authenticated', { sessionRevision: revision, currentRevision });
                }
                await this.authorizer.authorizeMachine(hostname, explicitAuthorization);
                return true;
            },
            execute: async (toolName, args, context) => {
                if (context.scopeKind === 'device') throw new Error('Use DeviceAgent for device transport');
                const authorization: ControlAuthorization = context.scopeKind === 'machine_control'
                    ? await this.authorizer.authorizeMachine(context.hostname, context.machineApproval)
                    : await this.authorizer.authorize(context.projectId!, context.hostname);
                const ownerKey = context.scopeKind === 'machine_control' ? `machine:${context.hostname}` : `project:${context.projectId}`;
                this.resources.assertOwned(toolName, ownerKey, args);
                const safeArgs = await this.options.toolPolicy(toolName, args, {
                    authorization,
                    scopeKind: context.scopeKind,
                    projectId: context.projectId,
                    hostname: context.hostname,
                    callId: context.callId,
                    generation: context.generation,
                });
                const explicitContext = args.execution_context;
                if (explicitContext !== undefined && explicitContext !== 'system' && explicitContext !== 'interactive') throw new ControlPolicyError('PROJECT_DEVICE_DENIED', 'invalid execution_context');
                const ownerContext = typeof args.pid === 'number' ? this.processContexts.get(args.pid) : (typeof args.sessionId === 'string' ? this.searchContexts.get(args.sessionId) : undefined);
                if (ownerContext && explicitContext && explicitContext !== ownerContext) throw new ControlPolicyError('PROJECT_DEVICE_DENIED', 'resource belongs to another execution context');
                const executionContext = explicitContext ?? ownerContext ?? 'system';
                if (executionContext === 'interactive' && !this.options.interactiveStateDir) throw Object.assign(new Error('interactive user session is not configured; SYSTEM fallback is denied'), { code: 'INTERACTIVE_SESSION_UNAVAILABLE' });
                const result = executionContext === 'interactive'
                    ? await new InteractiveUserClient(this.options.interactiveStateDir!).callTool(
                        toolName, safeArgs, context.projectId, context.hostname, context.signal, context.scopeKind, context.machineApproval,
                    )
                    : await this.desktop.callClientTool(toolName, safeArgs, {
                    ...(context.projectId ? { project_id: context.projectId } : {}),
                    scope_kind: context.scopeKind,
                    local_control_mcp: true,
                    fleet_hostname: context.hostname,
                    fleet_call_id: context.callId,
                    fleet_generation: context.generation,
                }, {
                    signal: context.signal,
                    timeout: this.options.channel?.callTimeoutMs,
                    maxTotalTimeout: this.options.channel?.callTimeoutMs,
                });
                this.resources.record(toolName, ownerKey, result, safeArgs);
                const text = JSON.stringify(result);
                if (toolName === 'start_process') { const match = text.match(/Process started with PID\s+(\d+)/i); if (match) this.processContexts.set(Number(match[1]), executionContext as string); }
                if (toolName === 'start_search') { const match = text.match(/search session:\s*([^\s"\\]+)/i); if (match) this.searchContexts.set(match[1], executionContext as string); }
                return context.scopeKind === 'machine_control'
                    ? this.resources.transformMachine(toolName, ownerKey, result, context.hostname)
                    : this.resources.transform(toolName, context.projectId!, authorization as ControlProjectAuthorization, result, context.hostname);
            },
            ...this.options.channel,
        });
        this.channel = channel;
        channel.start();
    }
}

export function createProjectControlPolicy(): FleetToolPolicy {
    return async (toolName, args, context) => {
        if (context.scopeKind === 'machine_control') return scopeMachineToolArgs(toolName, args);
        const authorization = context.authorization as ControlProjectAuthorization;
        const safe = scopeProjectToolArgs(toolName, args, authorization);
        await validateProjectToolPaths(toolName, safe, authorization);
        return safe;
    };
}
export function createProjectProbePolicy(
    fileName = '.network-fleet-plugin-probe.txt',
    maxWriteBytes = 4_096,
): FleetToolPolicy {
    if (!fileName || path.basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
        throw new Error('project probe fileName must be a single file name without path separators');
    }
    return async (toolName, args, context) => {
        if (toolName !== 'read_file' && toolName !== 'write_file') {
            throw Object.assign(new Error(`tool is not enabled by the project-probe policy: ${toolName}`), {
                code: 'PROJECT_DEVICE_DENIED',
            });
        }
        if (args.path !== undefined) {
            throw Object.assign(new Error('project-probe policy does not accept a caller-supplied path'), {
                code: 'PROJECT_DEVICE_DENIED',
            });
        }
        if (context.authorization.scopeKind !== 'project') {
            throw Object.assign(new Error('project-probe policy does not permit machine/control scope'), { code: 'PROJECT_DEVICE_DENIED' });
        }
        const physicalRoot = context.authorization.physicalRoot;
        if (!physicalRoot) {
            throw Object.assign(new Error('authorized project has no physical_root'), {
                code: 'PROJECT_DEVICE_DENIED',
            });
        }
        const probePath = path.join(physicalRoot, fileName);
        if (toolName === 'write_file') {
            if (args.mode !== undefined && args.mode !== 'rewrite') {
                throw Object.assign(new Error('project-probe policy permits rewrite mode only'), {
                    code: 'PROJECT_DEVICE_DENIED',
                });
            }
            const content = typeof args.content === 'string' ? args.content : '';
            if (Buffer.byteLength(content, 'utf8') > maxWriteBytes) {
                throw Object.assign(new Error(`project-probe write exceeds ${maxWriteBytes} bytes`), {
                    code: 'PROJECT_DEVICE_DENIED',
                });
            }
            return { ...args, path: probePath, mode: 'rewrite' };
        }
        return { ...args, path: probePath };
    };
}

export function createDedicatedTestFilePolicy(testFilePath: string, maxWriteBytes = 4_096): FleetToolPolicy {
    const expected = normalizePath(testFilePath);
    return async (toolName, args) => {
        if (toolName !== 'read_file' && toolName !== 'write_file') {
            throw Object.assign(new Error(`tool is not enabled by the test-only policy: ${toolName}`), {
                code: 'PROJECT_DEVICE_DENIED',
            });
        }
        const requested = typeof args.path === 'string' ? normalizePath(args.path) : '';
        if (!requested || requested !== expected) {
            throw Object.assign(new Error('test-only policy rejected path outside the dedicated probe file'), {
                code: 'PROJECT_DEVICE_DENIED',
            });
        }
        if (toolName === 'write_file') {
            if (args.mode !== undefined && args.mode !== 'rewrite') {
                throw Object.assign(new Error('test-only policy permits rewrite mode only'), {
                    code: 'PROJECT_DEVICE_DENIED',
                });
            }
            const content = typeof args.content === 'string' ? args.content : '';
            if (Buffer.byteLength(content, 'utf8') > maxWriteBytes) {
                throw Object.assign(new Error(`test-only write exceeds ${maxWriteBytes} bytes`), {
                    code: 'PROJECT_DEVICE_DENIED',
                });
            }
        }
        return { ...args, path: testFilePath };
    };
}

function normalizePath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
