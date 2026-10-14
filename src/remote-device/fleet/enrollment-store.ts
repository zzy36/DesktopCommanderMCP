import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalHostname } from './identity.js';
import type { DeviceBinding } from './protocol.js';

export type FleetPairingStatus = 'issued' | 'claimed' | 'approved' | 'expired';

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

type StoredPairing = FleetPairingRecord & { codeHash: string };
type StoredApprovedDevice = DeviceBinding & { approvedAtMs: number };
type EnrollmentState = {
    schemaVersion: 1;
    pairings: StoredPairing[];
    approvedDevices: StoredApprovedDevice[];
};

export class FleetEnrollmentStore {
    private readonly filePath: string;
    private state: EnrollmentState = { schemaVersion: 1, pairings: [], approvedDevices: [] };
    private loaded = false;

    constructor(filePath: string) {
        if (!filePath) throw new Error('enrollment store path is required');
        this.filePath = path.resolve(filePath);
    }

    async initialize(): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        try {
            const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<EnrollmentState>;
            if (raw.schemaVersion !== 1 || !Array.isArray(raw.pairings) || !Array.isArray(raw.approvedDevices)) {
                throw new Error('invalid Fleet enrollment state');
            }
            this.state = {
                schemaVersion: 1,
                pairings: raw.pairings as StoredPairing[],
                approvedDevices: raw.approvedDevices as StoredApprovedDevice[],
            };
        } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')) {
                throw error;
            }
            await this.persist();
        }
        this.loaded = true;
        await this.expireOldPairings();
    }

    async createPairing(hostnameInput: string, ttlMs = 10 * 60_000): Promise<FleetPairingRecord & { code: string }> {
        this.assertLoaded();
        const hostname = canonicalHostname(hostnameInput);
        if (!hostname) throw new Error('hostname is required');
        const now = Date.now();
        const code = randomBytes(18).toString('base64url');
        const record: StoredPairing = {
            id: randomUUID(),
            hostname,
            status: 'issued',
            createdAtMs: now,
            expiresAtMs: now + Math.max(60_000, Math.min(ttlMs, 60 * 60_000)),
            fingerprint: null,
            policyRevision: null,
            claimedAtMs: null,
            approvedAtMs: null,
            codeHash: hashCode(code),
        };
        this.state.pairings.push(record);
        this.state.pairings = this.state.pairings.slice(-100);
        await this.persist();
        return { ...this.publicRecord(record), code };
    }

    async claimPairing(input: {
        code: string;
        hostname: string;
        fingerprint: string;
        policyRevision: string;
    }): Promise<FleetPairingRecord> {
        this.assertLoaded();
        await this.expireOldPairings();
        const hostname = canonicalHostname(input.hostname);
        if (!/^control@[0-9a-f]{12}$/.test(input.policyRevision)) {
            throw new Error('invalid policy revision');
        }
        const codeHash = hashCode(input.code);
        const record = this.state.pairings.find((item) => item.codeHash === codeHash);
        if (!record || record.hostname !== hostname || record.status !== 'issued' || record.expiresAtMs <= Date.now()) {
            throw new Error('pairing code is invalid or expired');
        }
        const fingerprint = input.fingerprint.toLowerCase();
        if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new Error('invalid device fingerprint');
        record.status = 'claimed';
        record.fingerprint = fingerprint;
        record.policyRevision = input.policyRevision;
        record.claimedAtMs = Date.now();
        await this.persist();
        return this.publicRecord(record);
    }

    async approvePairing(id: string): Promise<DeviceBinding> {
        this.assertLoaded();
        await this.expireOldPairings();
        const record = this.state.pairings.find((item) => item.id === id);
        if (!record || record.status !== 'claimed' || !record.fingerprint) {
            throw new Error('pairing is not ready for approval');
        }
        const existing = this.state.approvedDevices.find((item) => item.hostname === record.hostname);
        if (existing && existing.publicKeyFingerprint !== record.fingerprint) {
            throw new Error(`device ${record.hostname} is already approved with a different identity`);
        }
        const approvedAtMs = Date.now();
        if (!existing) {
            this.state.approvedDevices.push({
                hostname: record.hostname,
                publicKeyFingerprint: record.fingerprint,
                approvedAtMs,
            });
        }
        record.status = 'approved';
        record.approvedAtMs = approvedAtMs;
        await this.persist();
        return { hostname: record.hostname, publicKeyFingerprint: record.fingerprint };
    }

    listPairings(): FleetPairingRecord[] {
        this.assertLoaded();
        return this.state.pairings.slice().reverse().map((item) => this.publicRecord(item));
    }

    getPairingByCode(code: string): FleetPairingRecord | null {
        this.assertLoaded();
        const codeHash = hashCode(code);
        const record = this.state.pairings.find((item) => item.codeHash === codeHash);
        return record ? this.publicRecord(record) : null;
    }

    listApprovedDevices(): DeviceBinding[] {
        this.assertLoaded();
        return this.state.approvedDevices.map(({ approvedAtMs: _approvedAtMs, ...device }) => ({ ...device }));
    }

    private async expireOldPairings(): Promise<void> {
        const now = Date.now();
        let changed = false;
        for (const record of this.state.pairings) {
            if ((record.status === 'issued' || record.status === 'claimed') && record.expiresAtMs <= now) {
                record.status = 'expired';
                changed = true;
            }
        }
        if (changed) await this.persist();
    }

    private publicRecord(record: StoredPairing): FleetPairingRecord {
        const { codeHash: _codeHash, ...safe } = record;
        return { ...safe };
    }

    private async persist(): Promise<void> {
        const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
        const body = `${JSON.stringify(this.state, null, 2)}\n`;
        try {
            await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
            await rename(temp, this.filePath);
        } catch (error) {
            await rm(temp, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    private assertLoaded(): void {
        if (!this.loaded) throw new Error('Fleet enrollment store is not initialized');
    }
}

function hashCode(code: string): string {
    return createHash('sha256').update(code, 'utf8').digest('hex');
}
