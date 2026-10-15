import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class AdminAccessError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}
export interface AdminSession { csrf: string; expiresAt: number; }
const digest = (value: string) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');

/** LAN filtering is defense in depth. Management additionally requires a local credential,
 * an expiring cookie session and exact configured Origin + CSRF for every mutation. */
export class LocalAdminSecurity {
    readonly origin: string;
    private readonly keyHash: Buffer;
    private readonly sessions = new Map<string, AdminSession>();
    private readonly nonces = new Map<string, number>();
    private attempts: number[] = [];
    constructor(origin: string, secret: string) {
        const url = new URL(origin);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('admin origin requires HTTPS');
        if (url.href !== url.origin + '/' || url.username || url.password) throw new Error('admin origin must be an origin only');
        if (secret.length < 43) throw new Error('local admin credential must have at least 256 bits');
        this.origin = url.origin; this.keyHash = digest(secret);
    }
    static async load(origin: string, keyPath: string): Promise<LocalAdminSecurity> {
        await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
        try { await writeFile(keyPath, token() + '\n', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        return new LocalAdminSecurity(origin, (await readFile(keyPath, 'utf8')).trim());
    }
    session(req: IncomingMessage): AdminSession | undefined {
        const id = this.cookie(req, 'lcm_admin');
        const session = this.sessions.get(digest(id).toString('hex'));
        if (session && session.expiresAt > Date.now()) return session;
        if (session) this.sessions.delete(digest(id).toString('hex'));
        return undefined;
    }
    requireSession(req: IncomingMessage): AdminSession {
        const session = this.session(req);
        if (!session) throw new AdminAccessError(401, 'local administrator sign-in required');
        return session;
    }
    requireMutation(req: IncomingMessage, csrf?: string): AdminSession {
        const session = this.requireSession(req);
        this.requireOrigin(req);
        if (!timingSafeEqual(digest(csrf ?? String(req.headers['x-lcm-csrf'] ?? '')), digest(session.csrf))) throw new AdminAccessError(403, 'CSRF validation failed');
        return session;
    }
    loginNonce(res: ServerResponse): string {
        for (const [id, expiry] of this.nonces) if (expiry < Date.now()) this.nonces.delete(id);
        if (this.nonces.size >= 100) throw new AdminAccessError(429, 'too many sign-in requests');
        const nonce = token(); this.nonces.set(nonce, Date.now() + 300_000);
        this.setCookie(res, 'lcm_login', nonce, 300);
        return nonce;
    }
    login(req: IncomingMessage, res: ServerResponse, secret: string, nonce: string): void {
        this.requireOrigin(req);
        const expiry = this.nonces.get(nonce); this.nonces.delete(nonce);
        if (!expiry || expiry < Date.now() || !timingSafeEqual(digest(nonce), digest(this.cookie(req, 'lcm_login')))) throw new AdminAccessError(403, 'sign-in form expired');
        this.attempts = this.attempts.filter(t => t > Date.now() - 60_000);
        if (this.attempts.length >= 10) throw new AdminAccessError(429, 'sign-in rate limit');
        this.attempts.push(Date.now());
        if (!timingSafeEqual(digest(secret), this.keyHash)) throw new AdminAccessError(403, 'invalid local credential');
        for (const [id, s] of this.sessions) if (s.expiresAt <= Date.now()) this.sessions.delete(id);
        if (this.sessions.size >= 20) throw new AdminAccessError(429, 'administrator session limit');
        const id = token(); this.sessions.set(digest(id).toString('hex'), { csrf: token(), expiresAt: Date.now() + 3600_000 });
        this.setCookie(res, 'lcm_admin', id, 3600); // rotated after every sign-in
    }
    logout(req: IncomingMessage, res: ServerResponse): void {
        this.requireMutation(req);
        this.sessions.delete(digest(this.cookie(req, 'lcm_admin')).toString('hex'));
        this.setCookie(res, 'lcm_admin', '', 0);
    }
    private requireOrigin(req: IncomingMessage): void {
        if (req.headers.origin !== this.origin) throw new AdminAccessError(403, 'untrusted management Origin');
    }
    private cookie(req: IncomingMessage, name: string): string {
        return String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) ?? '';
    }
    private setCookie(res: ServerResponse, name: string, value: string, age: number): void {
        res.setHeader('set-cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.origin.startsWith('https:') ? '; Secure' : ''}`);
    }
}
