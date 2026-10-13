import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalHostname } from './identity.js';

export interface FleetGenerationStore {
    next(hostname: string): Promise<number>;
    current(hostname: string): Promise<number | null>;
}

export class MemoryGenerationStore implements FleetGenerationStore {
    private readonly generations = new Map<string, number>();

    async next(hostnameInput: string): Promise<number> {
        const hostname = canonicalHostname(hostnameInput);
        const previous = this.generations.get(hostname) ?? 0;
        const generation = Math.max(previous + 1, Date.now() * 1000);
        this.generations.set(hostname, generation);
        return generation;
    }

    async current(hostnameInput: string): Promise<number | null> {
        return this.generations.get(canonicalHostname(hostnameInput)) ?? null;
    }
}

export class FileGenerationStore implements FleetGenerationStore {
    private readonly path: string;
    private loaded = false;
    private readonly generations = new Map<string, number>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(path: string) {
        if (!path) throw new Error('generation store path is required');
        this.path = path;
    }

    next(hostnameInput: string): Promise<number> {
        const hostname = canonicalHostname(hostnameInput);
        return this.serialize(async () => {
            await this.load();
            const previous = this.generations.get(hostname) ?? 0;
            const generation = Math.max(previous + 1, Date.now() * 1000);
            if (!Number.isSafeInteger(generation)) throw new Error('fleet generation exceeded safe integer range');
            this.generations.set(hostname, generation);
            await this.persist();
            return generation;
        });
    }

    current(hostnameInput: string): Promise<number | null> {
        const hostname = canonicalHostname(hostnameInput);
        return this.serialize(async () => {
            await this.load();
            return this.generations.get(hostname) ?? null;
        });
    }

    private async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const raw = JSON.parse(await readFile(this.path, 'utf8')) as { generations?: Record<string, unknown> };
            for (const [hostnameInput, value] of Object.entries(raw.generations ?? {})) {
                if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
                    throw new Error(`invalid generation for ${hostnameInput}`);
                }
                this.generations.set(canonicalHostname(hostnameInput), value);
            }
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
                return;
            }
            throw error;
        }
    }

    private async persist(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true });
        const payload = {
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            generations: Object.fromEntries([...this.generations.entries()].sort(([a], [b]) => a.localeCompare(b))),
        };
        const temp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
        try {
            await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
            await rename(temp, this.path);
        } catch (error) {
            await rm(temp, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    private serialize<T>(work: () => Promise<T>): Promise<T> {
        const next = this.queue.then(work, work);
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }
}
