import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalHostname } from './identity.js';
import type { DeviceBinding } from './protocol.js';

export type FleetPairingStatus = 'issued' | 'claimed' | 'approved' | 'expired';
export type FleetDeviceAuthorizationStatus = 'pending' | 'approved' | 'expired';

export interface FleetPairingRecord {
    id: string;
    hostname: string;
    status: FleetPairingStatus;
    createdAtMs: number;
    expiresAtMs: number;
    fingerprint: string | null;
    policyRevision: string | null;
    claimedAtMs: number | null;
    approvedAtMs: number | null;
}

export interface FleetDeviceAuthorizationRecord {
    id: string;
    hostname: string;
    status: FleetDeviceAuthorizationStatus;
    createdAtMs: number;
    expiresAtMs: number;
    fingerprint: string;
    policyRevision: string;
    approvedAtMs: number | null;
}

type StoredPairing = FleetPairingRecord & { codeHash: string };
type StoredApprovedDevice = DeviceBinding & { approvedAtMs: number };
type StoredDeviceAuthorization = FleetDeviceAuthorizationRecord & {
    deviceCodeHash: string;
    userCodeHash: string;
    codeChallenge: string;
};
type EnrollmentState = {
    schemaVersion: 2;
    pairings: StoredPairing[];
    approvedDevices: StoredApprovedDevice[];
    deviceAuthorizations: StoredDeviceAuthorization[];
};

export class FleetEnrollmentStore {
    private readonly filePath: string;
    private state: EnrollmentState = { schemaVersion: 2, pairings: [], approvedDevices: [], deviceAuthorizations: [] };
    private loaded = false;

    constructor(filePath: string) {
        if (!filePath) throw new Error('enrollment store path is required');
        this.filePath = path.resolve(filePath);
    }

    async initialize(): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        try {
            const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, unknown>;
            if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || !Array.isArray(raw.pairings) || !Array.isArray(raw.approvedDevices)) {
                throw new Error('invalid Fleet enrollment state');
            }
            this.state = {
                schemaVersion: 2,
                pairings: raw.pairings as StoredPairing[],
                approvedDevices: raw.approvedDevices as StoredApprovedDevice[],
                deviceAuthorizations: Array.isArray(raw.deviceAuthorizations)
                    ? raw.deviceAuthorizations as StoredDeviceAuthorization[]
                    : [],
            };
            if (raw.schemaVersion === 1) await this.persist();
        } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')) {
                throw error;
            }
            await this.persist();
        }
        this.loaded = true;
        await this.expireOldRecords();
    }

    async createPairing(hostnameInput: string, ttlMs = 10 * 60_000): Promise<FleetPairingRecord & { code: string }> {
        this.assertLoaded();
        const hostname = canonicalHostname(hostnameInput);
        if (!hostname) throw new Error('hostname is required');
        const now = Date.now();
        const code = randomBytes(18).toString('base64url');
        const record: StoredPairing = {
            id: randomUUID(), hostname, status: 'issued', createdAtMs: now,
            expiresAtMs: now + clampTtl(ttlMs), fingerprint: null, policyRevision: null,
            claimedAtMs: null, approvedAtMs: null, codeHash: hashCode(code),
        };
        this.state.pairings.push(record);
        this.state.pairings = this.state.pairings.slice(-100);
        await this.persist();
        return { ...this.publicPairing(record), code };
    }

    async claimPairing(input: { code: string; hostname: string; fingerprint: string; policyRevision: string }): Promise<FleetPairingRecord> {
        this.assertLoaded();
        await this.expireOldRecords();
        const hostname = canonicalHostname(input.hostname);
        assertPolicyRevision(input.policyRevision);
        const codeHash = hashCode(input.code);
        const record = this.state.pairings.find((item) => item.codeHash === codeHash);
        if (!record || record.hostname !== hostname || record.status !== 'issued' || record.expiresAtMs <= Date.now()) {
            throw new Error('pairing code is invalid or expired');
        }
        const fingerprint = normalizeFingerprint(input.fingerprint);
        record.status = 'claimed'; record.fingerprint = fingerprint; record.policyRevision = input.policyRevision;
        record.claimedAtMs = Date.now();
        await this.persist();
        return this.publicPairing(record);
    }

    async approvePairing(id: string): Promise<DeviceBinding> {
        this.assertLoaded();
        await this.expireOldRecords();
        const record = this.state.pairings.find((item) => item.id === id);
        if (!record || record.status !== 'claimed' || !record.fingerprint) throw new Error('pairing is not ready for approval');
        const device = this.approveDeviceIdentity(record.hostname, record.fingerprint);
        record.status = 'approved'; record.approvedAtMs = Date.now();
        await this.persist();
        return device;
    }

    async createDeviceAuthorization(input: {
        hostname: string;
        fingerprint: string;
        policyRevision: string;
        codeChallenge: string;
        ttlMs?: number;
    }): Promise<FleetDeviceAuthorizationRecord & { deviceCode: string; userCode: string }> {
        this.assertLoaded();
        await this.expireOldRecords();
        const hostname = canonicalHostname(input.hostname);
        if (!hostname) throw new Error('hostname is required');
        const fingerprint = normalizeFingerprint(input.fingerprint);
        assertPolicyRevision(input.policyRevision);
        const codeChallenge = String(input.codeChallenge ?? '');
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw new Error('invalid PKCE code challenge');
        const now = Date.now();
        const deviceCode = randomBytes(32).toString('base64url');
        const userCode = generateUserCode();
        const record: StoredDeviceAuthorization = {
            id: randomUUID(), hostname, status: 'pending', createdAtMs: now,
            expiresAtMs: now + clampTtl(input.ttlMs ?? 10 * 60_000), fingerprint, policyRevision: input.policyRevision,
            approvedAtMs: null, deviceCodeHash: hashCode(deviceCode), userCodeHash: hashCode(normalizeUserCode(userCode)), codeChallenge,
        };
        this.state.deviceAuthorizations.push(record);
        this.state.deviceAuthorizations = this.state.deviceAuthorizations.slice(-100);
        await this.persist();
        return { ...this.publicDeviceAuthorization(record), deviceCode, userCode };
    }

    getDeviceAuthorizationByUserCode(userCode: string): FleetDeviceAuthorizationRecord | null {
        this.assertLoaded();
        const hash = hashCode(normalizeUserCode(userCode));
        const record = this.state.deviceAuthorizations.find((item) => item.userCodeHash === hash);
        if (!record) return null;
        if (record.status === 'pending' && record.expiresAtMs <= Date.now()) record.status = 'expired';
        return this.publicDeviceAuthorization(record);
    }

    async approveDeviceAuthorizationByUserCode(userCode: string): Promise<{ authorization: FleetDeviceAuthorizationRecord; device: DeviceBinding }> {
        this.assertLoaded();
        await this.expireOldRecords();
        const hash = hashCode(normalizeUserCode(userCode));
        const record = this.state.deviceAuthorizations.find((item) => item.userCodeHash === hash);
        if (!record || record.status !== 'pending' || record.expiresAtMs <= Date.now()) throw new Error('device authorization code is invalid or expired');
        const device = this.approveDeviceIdentity(record.hostname, record.fingerprint);
        record.status = 'approved'; record.approvedAtMs = Date.now();
        await this.persist();
        return { authorization: this.publicDeviceAuthorization(record), device };
    }

    async pollDeviceAuthorization(input: { deviceCode: string; codeVerifier: string }): Promise<FleetDeviceAuthorizationRecord> {
        this.assertLoaded();
        await this.expireOldRecords();
        const record = this.state.deviceAuthorizations.find((item) => item.deviceCodeHash === hashCode(input.deviceCode));
        if (!record) throw new Error('invalid device code');
        const verifier = String(input.codeVerifier ?? '');
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('invalid PKCE code verifier');
        const actualChallenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
        if (!timingSafeTextEqual(actualChallenge, record.codeChallenge)) throw new Error('PKCE verification failed');
        if (record.expiresAtMs <= Date.now() || record.status === 'expired') {
            record.status = 'expired';
            await this.persist();
        }
        return this.publicDeviceAuthorization(record);
    }

    listPairings(): FleetPairingRecord[] {
        this.assertLoaded();
        return this.state.pairings.slice().reverse().map((item) => this.publicPairing(item));
    }

    getPairingByCode(code: string): FleetPairingRecord | null {
        this.assertLoaded();
        const record = this.state.pairings.find((item) => item.codeHash === hashCode(code));
        return record ? this.publicPairing(record) : null;
    }

    listDeviceAuthorizations(): FleetDeviceAuthorizationRecord[] {
        this.assertLoaded();
        return this.state.deviceAuthorizations.slice().reverse().map((item) => this.publicDeviceAuthorization(item));
    }

    listApprovedDevices(): DeviceBinding[] {
        this.assertLoaded();
        return this.state.approvedDevices.map(({ approvedAtMs: _approvedAtMs, ...device }) => ({ ...device }));
    }

    private approveDeviceIdentity(hostname: string, fingerprint: string): DeviceBinding {
        const existing = this.state.approvedDevices.find((item) => item.hostname === hostname);
        if (existing && existing.publicKeyFingerprint !== fingerprint) throw new Error(`device ${hostname} is already approved with a different identity`);
        if (!existing) this.state.approvedDevices.push({ hostname, publicKeyFingerprint: fingerprint, approvedAtMs: Date.now() });
        return { hostname, publicKeyFingerprint: fingerprint };
    }

    private async expireOldRecords(): Promise<void> {
        const now = Date.now();
        let changed = false;
        for (const record of this.state.pairings) {
            if ((record.status === 'issued' || record.status === 'claimed') && record.expiresAtMs <= now) { record.status = 'expired'; changed = true; }
        }
        for (const record of this.state.deviceAuthorizations) {
            if (record.status === 'pending' && record.expiresAtMs <= now) { record.status = 'expired'; changed = true; }
        }
        if (changed) await this.persist();
    }

    private publicPairing(record: StoredPairing): FleetPairingRecord {
        const { codeHash: _codeHash, ...safe } = record;
        return { ...safe };
    }

    private publicDeviceAuthorization(record: StoredDeviceAuthorization): FleetDeviceAuthorizationRecord {
        const { deviceCodeHash: _deviceCodeHash, userCodeHash: _userCodeHash, codeChallenge: _codeChallenge, ...safe } = record;
        return { ...safe };
    }

    private async persist(): Promise<void> {
        const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
        const body = `${JSON.stringify(this.state, null, 2)}\n`;
        try { await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.filePath); }
        catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
    }

    private assertLoaded(): void { if (!this.loaded) throw new Error('Fleet enrollment store is not initialized'); }
}

function clampTtl(ttlMs: number): number { return Math.max(60_000, Math.min(ttlMs, 60 * 60_000)); }
function hashCode(code: string): string { return createHash('sha256').update(code, 'utf8').digest('hex'); }
function normalizeFingerprint(value: string): string { const result = value.toLowerCase(); if (!/^sha256:[0-9a-f]{64}$/.test(result)) throw new Error('invalid device fingerprint'); return result; }
function assertPolicyRevision(value: string): void { if (!/^control@[0-9a-f]{12}$/.test(value)) throw new Error('invalid policy revision'); }
function normalizeUserCode(value: string): string { return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function generateUserCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(8);
    let raw = '';
    for (const byte of bytes) raw += alphabet[byte % alphabet.length];
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
function timingSafeTextEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8'); const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}
