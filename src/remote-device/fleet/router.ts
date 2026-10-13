import { canonicalHostname } from './identity.js';
import {
    AgentDescriptor,
    DeviceBinding,
    FleetRoutingError,
    ProjectBinding,
} from './protocol.js';

export class FleetRouter {
    private readonly devices = new Map<string, DeviceBinding>();
    private readonly projects = new Map<string, ProjectBinding>();
    private readonly sessions = new Map<string, Map<string, AgentDescriptor>>();

    constructor(devices: DeviceBinding[], projects: ProjectBinding[]) {
        for (const device of devices) {
            const hostname = canonicalHostname(device.hostname);
            if (this.devices.has(hostname)) {
                throw new Error(`duplicate device binding for ${hostname}`);
            }
            this.devices.set(hostname, { ...device, hostname });
        }

        for (const project of projects) {
            if (this.projects.has(project.projectId)) {
                throw new Error(`duplicate project binding for ${project.projectId}`);
            }
            this.projects.set(project.projectId, {
                ...project,
                hostname: canonicalHostname(project.hostname),
            });
        }
    }

    registerAgent(input: AgentDescriptor): AgentDescriptor {
        const hostname = canonicalHostname(input.hostname);
        const expected = this.devices.get(hostname);
        if (!expected || expected.publicKeyFingerprint !== input.publicKeyFingerprint) {
            throw new FleetRoutingError(
                'IDENTITY_MISMATCH',
                `agent identity does not match pinned identity for ${hostname}`,
                { hostname, sessionId: input.sessionId },
            );
        }

        const session = Object.freeze({ ...input, hostname });
        let bySession = this.sessions.get(hostname);
        if (!bySession) {
            bySession = new Map();
            this.sessions.set(hostname, bySession);
        }
        bySession.set(session.sessionId, session);
        return session;
    }

    unregisterAgent(hostnameInput: string, sessionId: string): void {
        const hostname = canonicalHostname(hostnameInput);
        const bySession = this.sessions.get(hostname);
        bySession?.delete(sessionId);
        if (bySession?.size === 0) this.sessions.delete(hostname);
    }

    resolve(projectId: string, requestedHostname: string): AgentDescriptor {
        const project = this.projects.get(projectId);
        const hostname = canonicalHostname(requestedHostname);

        if (!project || project.hostname !== hostname) {
            throw new FleetRoutingError(
                'PROJECT_DEVICE_DENIED',
                `project ${projectId} is not authorized for ${hostname}`,
                { projectId, hostname, requiredHostname: project?.hostname ?? null },
            );
        }

        const bySession = this.sessions.get(hostname);
        if (!bySession || bySession.size === 0) {
            throw new FleetRoutingError(
                'TARGET_OFFLINE',
                `target ${hostname} is offline`,
                { projectId, hostname },
            );
        }

        if (bySession.size !== 1) {
            throw new FleetRoutingError(
                'TARGET_AMBIGUOUS',
                `target ${hostname} has ${bySession.size} active sessions`,
                { projectId, hostname, sessionIds: [...bySession.keys()] },
            );
        }

        const session = bySession.values().next().value as AgentDescriptor;
        const expected = this.devices.get(hostname);
        if (!expected || session.publicKeyFingerprint !== expected.publicKeyFingerprint) {
            throw new FleetRoutingError(
                'IDENTITY_MISMATCH',
                `active session identity no longer matches ${hostname}`,
                { projectId, hostname, sessionId: session.sessionId },
            );
        }

        if (session.policyRevision !== project.policyRevision) {
            throw new FleetRoutingError(
                'POLICY_SKEW',
                `target ${hostname} advertises a different policy revision`,
                {
                    projectId,
                    hostname,
                    gatewayPolicyRevision: project.policyRevision,
                    agentPolicyRevision: session.policyRevision,
                },
            );
        }

        return session;
    }
}
