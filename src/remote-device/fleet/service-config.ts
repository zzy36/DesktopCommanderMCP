import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { canonicalHostname } from './identity.js';

const PositiveInt = z.number().int().positive();
const ListenPort = z.number().int().min(0).max(65535);

const AgentChannelSchema = z.object({
    reconnectBaseMs: PositiveInt.optional(),
    reconnectMaxMs: PositiveInt.optional(),
    heartbeatMs: PositiveInt.optional(),
    heartbeatTimeoutMs: PositiveInt.optional(),
    callTimeoutMs: PositiveInt.optional(),
    maxInFlight: PositiveInt.optional(),
    completedResultCacheSize: PositiveInt.optional(),
}).strict();

const AgentConfigSchema = z.object({
    schemaVersion: z.literal(1),
    gatewayUrl: z.string().url(),
    controlRoot: z.string().min(1).optional(),
    stateDir: z.string().min(1).optional(),
    hostname: z.string().min(1).optional(),
    probeFileName: z.string().min(1).optional(),
    policyWatchMs: PositiveInt.optional(),
    channel: AgentChannelSchema.optional(),
}).strict();

const DeviceBindingSchema = z.object({
    hostname: z.string().min(1),
    publicKeyFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

const ProjectBindingSchema = z.object({
    projectId: z.string().min(1),
    hostname: z.string().min(1),
    policyRevision: z.string().regex(/^control@[0-9a-f]{12}$/),
}).strict();

const ProbeBindingSchema = z.object({
    projectId: z.string().min(1),
    hostname: z.string().min(1),
}).strict();

const GatewayBearerAuthSchema = z.object({
    type: z.literal('bearer'),
    tokenEnv: z.string().min(1).default('FLEET_MCP_BEARER_TOKEN'),
}).strict();

const GatewayOAuthAuthSchema = z.object({
    type: z.literal('oauth'),
    issuerUrl: z.string().url(),
    resourceUrl: z.string().url(),
    ownerPasswordHashEnv: z.string().min(1).default('FLEET_OWNER_PASSWORD_HASH'),
}).strict();

const GatewayAdminSchema = z.object({
    listenHost: z.string().min(1).default('127.0.0.1'),
    listenPort: ListenPort,
    basePath: z.string().min(1).default('/admin'),
}).strict();

const GatewayConfigSchema = z.object({
    schemaVersion: z.literal(1),
    mcp: z.object({
        listenHost: z.string().min(1).default('127.0.0.1'),
        listenPort: ListenPort,
        auth: z.discriminatedUnion('type', [GatewayBearerAuthSchema, GatewayOAuthAuthSchema]),
    }).strict(),
    agent: z.object({
        listenHost: z.string().min(1).default('127.0.0.1'),
        listenPort: ListenPort,
        path: z.string().min(1).default('/agent'),
    }).strict(),
    admin: GatewayAdminSchema.optional(),
    stateDir: z.string().min(1),
    devices: z.array(DeviceBindingSchema).min(1),
    projects: z.array(ProjectBindingSchema).min(1),
    probes: z.array(ProbeBindingSchema).default([]),
    callTimeoutMs: PositiveInt.optional(),
    maxPendingCalls: PositiveInt.optional(),
    callRecordLimit: PositiveInt.optional(),
    heartbeatTimeoutMs: PositiveInt.optional(),
    heartbeatSweepMs: PositiveInt.optional(),
}).strict();

export interface ResolvedAgentServiceConfig {
    gatewayUrl: string;
    controlRoot: string;
    stateDir: string;
    hostname: string;
    probeFileName: string;
    policyWatchMs?: number;
    channel?: z.infer<typeof AgentChannelSchema>;
}

export type ResolvedGatewayAuth =
    | { type: 'bearer'; tokenEnv: string }
    | { type: 'oauth'; issuerUrl: URL; resourceUrl: URL; ownerPasswordHashEnv: string };

export interface ResolvedGatewayServiceConfig {
    mcpListenHost: string;
    mcpListenPort: number;
    mcpAuth: ResolvedGatewayAuth;
    agentListenHost: string;
    agentListenPort: number;
    agentPath: string;
    adminListenHost?: string;
    adminListenPort?: number;
    adminBasePath?: string;
    stateDir: string;
    devices: Array<{ hostname: string; publicKeyFingerprint: string }>;
    projects: Array<{ projectId: string; hostname: string; policyRevision: string }>;
    probes: Array<{ projectId: string; hostname: string }>;
    callTimeoutMs?: number;
    maxPendingCalls?: number;
    callRecordLimit?: number;
    heartbeatTimeoutMs?: number;
    heartbeatSweepMs?: number;
}

export async function loadAgentServiceConfig(
    configPath: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedAgentServiceConfig> {
    const raw = AgentConfigSchema.parse(await readJson(configPath));
    const gatewayUrl = new URL(raw.gatewayUrl);
    if (gatewayUrl.protocol !== 'ws:' && gatewayUrl.protocol !== 'wss:') {
        throw new Error('agent gatewayUrl must use ws:// or wss://');
    }
    if (gatewayUrl.protocol === 'ws:' && !isLoopbackHostname(gatewayUrl.hostname) && env.FLEET_DANGEROUS_ALLOW_INSECURE_WS !== '1') {
        throw new Error('non-loopback Fleet Agent connections must use wss://');
    }
    const controlRoot = await discoverControlRoot(raw.controlRoot, env);
    const stateDir = path.resolve(
        raw.stateDir
        ?? env.FLEET_STATE_DIR
        ?? defaultAgentStateDir(env),
    );
    const hostname = canonicalHostname(raw.hostname ?? os.hostname());
    const probeFileName = raw.probeFileName ?? '.network-fleet-plugin-probe.txt';
    if (path.basename(probeFileName) !== probeFileName || probeFileName === '.' || probeFileName === '..') {
        throw new Error('probeFileName must be a single file name');
    }
    return {
        gatewayUrl: gatewayUrl.href,
        controlRoot,
        stateDir,
        hostname,
        probeFileName,
        policyWatchMs: raw.policyWatchMs,
        channel: raw.channel,
    };
}

export async function loadGatewayServiceConfig(
    configPath: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedGatewayServiceConfig> {
    const raw = GatewayConfigSchema.parse(await readJson(configPath));
    if (!raw.agent.path.startsWith('/') || raw.agent.path.includes('?') || raw.agent.path.includes('#')) {
        throw new Error('agent.path must be an absolute URL path without query or fragment');
    }
    if (raw.agent.path === '/mcp') {
        throw new Error('agent.path must be distinct from the MCP endpoint');
    }
    if (
        raw.mcp.listenPort !== 0
        && raw.mcp.listenPort === raw.agent.listenPort
        && raw.mcp.listenHost === raw.agent.listenHost
    ) {
        throw new Error('MCP and Agent listeners must use distinct host/port bindings');
    }
    if (raw.admin) {
        if (!raw.admin.basePath.startsWith('/') || raw.admin.basePath === '/' || raw.admin.basePath.includes('?') || raw.admin.basePath.includes('#')) {
            throw new Error('admin.basePath must be a non-root absolute URL path without query or fragment');
        }
        const conflicts = [
            [raw.mcp.listenHost, raw.mcp.listenPort, 'MCP'],
            [raw.agent.listenHost, raw.agent.listenPort, 'Agent'],
        ] as const;
        for (const [host, port, label] of conflicts) {
            if (raw.admin.listenPort !== 0 && raw.admin.listenHost === host && raw.admin.listenPort === port) {
                throw new Error(`Admin and ${label} listeners must use distinct host/port bindings`);
            }
        }
    }

    const devices = raw.devices.map((device) => ({
        hostname: canonicalHostname(device.hostname),
        publicKeyFingerprint: device.publicKeyFingerprint,
    }));
    const projects = raw.projects.map((project) => ({
        projectId: project.projectId,
        hostname: canonicalHostname(project.hostname),
        policyRevision: project.policyRevision,
    }));
    const probes = raw.probes.map((probe) => ({
        projectId: probe.projectId,
        hostname: canonicalHostname(probe.hostname),
    }));
    assertNoDuplicates(devices.map((device) => device.hostname), 'device hostname');
    assertNoDuplicates(projects.map((project) => project.projectId), 'project_id');
    assertNoDuplicates(probes.map((probe) => `${probe.projectId}\u0000${probe.hostname}`), 'probe binding');

    const knownHosts = new Set(devices.map((device) => device.hostname));
    for (const project of projects) {
        if (!knownHosts.has(project.hostname)) throw new Error(`project ${project.projectId} references unknown device ${project.hostname}`);
    }
    const projectHost = new Map(projects.map((project) => [project.projectId, project.hostname]));
    for (const probe of probes) {
        if (projectHost.get(probe.projectId) !== probe.hostname) {
            throw new Error(`probe ${probe.projectId}/${probe.hostname} does not match project routing`);
        }
    }

    let mcpAuth: ResolvedGatewayAuth;
    if (raw.mcp.auth.type === 'bearer') {
        mcpAuth = { type: 'bearer', tokenEnv: raw.mcp.auth.tokenEnv };
    } else {
        const issuerUrl = new URL(raw.mcp.auth.issuerUrl);
        const resourceUrl = new URL(raw.mcp.auth.resourceUrl);
        if (resourceUrl.pathname !== '/mcp') throw new Error('OAuth resourceUrl path must be /mcp');
        if (!isSecureUrl(issuerUrl, env) || !isSecureUrl(resourceUrl, env)) {
            throw new Error('OAuth issuerUrl/resourceUrl must use https:// outside loopback tests');
        }
        mcpAuth = {
            type: 'oauth',
            issuerUrl,
            resourceUrl,
            ownerPasswordHashEnv: raw.mcp.auth.ownerPasswordHashEnv,
        };
    }

    return {
        mcpListenHost: raw.mcp.listenHost,
        mcpListenPort: raw.mcp.listenPort,
        mcpAuth,
        agentListenHost: raw.agent.listenHost,
        agentListenPort: raw.agent.listenPort,
        agentPath: raw.agent.path,
        adminListenHost: raw.admin?.listenHost,
        adminListenPort: raw.admin?.listenPort,
        adminBasePath: raw.admin?.basePath,
        stateDir: path.resolve(raw.stateDir),
        devices,
        projects,
        probes,
        callTimeoutMs: raw.callTimeoutMs,
        maxPendingCalls: raw.maxPendingCalls,
        callRecordLimit: raw.callRecordLimit,
        heartbeatTimeoutMs: raw.heartbeatTimeoutMs,
        heartbeatSweepMs: raw.heartbeatSweepMs,
    };
}

export async function discoverControlRoot(
    explicit?: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
    const candidates: string[] = [];
    if (explicit) candidates.push(explicit);
    if (env.FLEET_CONTROL_ROOT) candidates.push(env.FLEET_CONTROL_ROOT);
    if (env.MACHINE_CONTROL_ROOT) candidates.push(env.MACHINE_CONTROL_ROOT);

    let current = path.resolve(process.cwd());
    for (;;) {
        candidates.push(current);
        candidates.push(path.join(current, '.control'));
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    const home = env.USERPROFILE || env.HOME || os.homedir();
    if (home) candidates.push(path.join(home, 'Projects', '.control'));

    if (process.platform === 'win32') {
        for (let code = 65; code <= 90; code += 1) {
            candidates.push(`${String.fromCharCode(code)}:\\Projects\\.control`);
        }
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (seen.has(key)) continue;
        seen.add(key);
        if (await isControlRoot(resolved)) return resolved;
    }
    throw new Error('unable to discover .control root; set FLEET_CONTROL_ROOT explicitly');
}

async function isControlRoot(candidate: string): Promise<boolean> {
    try {
        await Promise.all([
            access(path.join(candidate, 'projects.registry.json')),
            access(path.join(candidate, 'devices.registry.json')),
            access(path.join(candidate, 'tools', 'machine-control', 'machine_control_gateway.py')),
        ]);
        return true;
    } catch {
        return false;
    }
}

async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

function defaultAgentStateDir(env: NodeJS.ProcessEnv): string {
    const base = env.ProgramData || env.PROGRAMDATA;
    if (base) return path.join(base, 'NetworkFleet', 'agent');
    return path.join(os.homedir(), '.network-fleet', 'agent');
}

function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function isSecureUrl(url: URL, env: NodeJS.ProcessEnv): boolean {
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname) && env.FLEET_DANGEROUS_ALLOW_HTTP === '1');
}

function assertNoDuplicates(values: string[], label: string): void {
    const seen = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
        seen.add(value);
    }
}
