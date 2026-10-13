import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalHostname, fingerprintPublicKey } from './identity.js';

export interface StoredFleetIdentity {
    hostname: string;
    publicKeyPem: string;
    privateKeyPem: string;
    publicKeyFingerprint: string;
    createdAt: string;
}

export interface DeviceIdentityStoreOptions {
    stateDir: string;
    fileName?: string;
}

export class DeviceIdentityStore {
    private readonly stateDir: string;
    private readonly fileName: string;

    constructor(options: DeviceIdentityStoreOptions) {
        if (!options.stateDir) throw new Error('stateDir is required');
        this.stateDir = options.stateDir;
        this.fileName = options.fileName ?? 'device-identity.json';
    }

    async loadOrCreate(hostnameInput: string): Promise<StoredFleetIdentity> {
        const hostname = canonicalHostname(hostnameInput);
        await mkdir(this.stateDir, { recursive: true });
        const path = join(this.stateDir, this.fileName);
        try {
            const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredFleetIdentity>;
            return this.validate(parsed, hostname);
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
                return this.create(path, hostname);
            }
            throw error;
        }
    }

    private async create(path: string, hostname: string): Promise<StoredFleetIdentity> {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const identity: StoredFleetIdentity = {
            hostname,
            publicKeyPem,
            privateKeyPem,
            publicKeyFingerprint: fingerprintPublicKey(publicKeyPem),
            createdAt: new Date().toISOString(),
        };
        const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
        try {
            await writeFile(temp, `${JSON.stringify(identity, null, 2)}\n`, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx',
            });
            await rename(temp, path);
        } catch (error) {
            await rm(temp, { force: true }).catch(() => undefined);
            if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EEXIST') {
                const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredFleetIdentity>;
                return this.validate(parsed, hostname);
            }
            throw error;
        }
        return Object.freeze({ ...identity });
    }

    private validate(raw: Partial<StoredFleetIdentity>, expectedHostname: string): StoredFleetIdentity {
        const hostname = typeof raw.hostname === 'string' ? canonicalHostname(raw.hostname) : '';
        const publicKeyPem = typeof raw.publicKeyPem === 'string' ? raw.publicKeyPem : '';
        const privateKeyPem = typeof raw.privateKeyPem === 'string' ? raw.privateKeyPem : '';
        const storedFingerprint = typeof raw.publicKeyFingerprint === 'string' ? raw.publicKeyFingerprint : '';
        const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : '';
        if (!hostname || hostname !== expectedHostname) {
            throw new Error(`fleet identity hostname mismatch: expected ${expectedHostname}, got ${hostname || 'missing'}`);
        }
        if (!publicKeyPem || !privateKeyPem || !storedFingerprint || !createdAt) {
            throw new Error('fleet identity file is incomplete');
        }
        const actualFingerprint = fingerprintPublicKey(publicKeyPem);
        if (actualFingerprint !== storedFingerprint) {
            throw new Error('fleet identity public-key fingerprint mismatch');
        }
        return Object.freeze({
            hostname,
            publicKeyPem,
            privateKeyPem,
            publicKeyFingerprint: actualFingerprint,
            createdAt,
        });
    }
}
