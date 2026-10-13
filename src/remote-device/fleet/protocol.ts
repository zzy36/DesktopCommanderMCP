export const FLEET_PROTOCOL_VERSION = 1;

export type FleetErrorCode =
    | 'TARGET_OFFLINE'
    | 'IDENTITY_MISMATCH'
    | 'TARGET_AMBIGUOUS'
    | 'PROJECT_DEVICE_DENIED'
    | 'POLICY_SKEW';

export class FleetRoutingError extends Error {
    readonly code: FleetErrorCode;
    readonly details: Readonly<Record<string, unknown>>;

    constructor(code: FleetErrorCode, message: string, details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'FleetRoutingError';
        this.code = code;
        this.details = Object.freeze({ ...details });
    }
}

export interface DeviceBinding {
    hostname: string;
    publicKeyFingerprint: string;
}

export interface ProjectBinding {
    projectId: string;
    hostname: string;
    policyRevision: string;
}

export interface AgentDescriptor {
    sessionId: string;
    hostname: string;
    publicKeyFingerprint: string;
    policyRevision: string;
    connectedAtMs: number;
}
