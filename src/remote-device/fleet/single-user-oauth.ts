import {
    createHash,
    randomBytes,
    scrypt as scryptCallback,
    timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Response } from 'express';
import {
    InvalidClientMetadataError,
    InvalidGrantError,
    InvalidRequestError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
    AuthorizationParams,
    OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
    OAuthClientInformationFull,
    OAuthTokenRevocationRequest,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

export const FLEET_OAUTH_SCOPES = ['fleet:read', 'fleet:write'] as const;

interface PersistedTokenRecord {
    clientId: string;
    scopes: string[];
    resource: string;
    expiresAt: number;
    subject: string;
}

interface PersistedOAuthState {
    schemaVersion: 1;
    updatedAt: string;
    clients: Record<string, OAuthClientInformationFull>;
    accessTokens: Record<string, PersistedTokenRecord>;
    refreshTokens: Record<string, PersistedTokenRecord>;
}

interface PendingAuthorization {
    requestId: string;
    client: OAuthClientInformationFull;
    params: AuthorizationParams;
    scopes: string[];
    createdAtMs: number;
    attempts: number;
}

interface AuthorizationCodeRecord {
    clientId: string;
    params: AuthorizationParams;
    scopes: string[];
    expiresAtMs: number;
}

export interface SingleUserOAuthProviderOptions {
    statePath: string;
    issuerUrl: URL;
    resourceUrl: URL;
    verifyOwnerPassword: (password: string) => boolean | Promise<boolean>;
    subject?: string;
    supportedScopes?: string[];
}

export interface PendingAuthorizationView {
    requestId: string;
    clientId: string;
    clientName: string;
    redirectUri: string;
    scopes: string[];
    resource: string;
}

class PersistentOAuthRepository {
    private readonly path: string;
    private state: PersistedOAuthState | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(path: string) {
        if (!path) throw new Error('OAuth state path is required');
        this.path = path;
    }

    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        return this.read((state) => state.clients[clientId]);
    }

    async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
        return this.mutate((state) => {
            if (!client.client_id) throw new InvalidClientMetadataError('client_id is required');
            if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0) {
                throw new InvalidClientMetadataError('at least one redirect_uri is required');
            }
            for (const redirectUri of client.redirect_uris) validateRedirectUri(redirectUri);
            const method = client.token_endpoint_auth_method ?? 'client_secret_post';
            if (method !== 'none' && method !== 'client_secret_post') {
                throw new InvalidClientMetadataError(`unsupported token_endpoint_auth_method: ${method}`);
            }
            if (Object.keys(state.clients).length >= 50 && !state.clients[client.client_id]) {
                throw new InvalidClientMetadataError('client registration limit reached');
            }
            state.clients[client.client_id] = { ...client };
            return { ...client };
        });
    }

    async getAccessToken(tokenHash: string): Promise<PersistedTokenRecord | undefined> {
        return this.read((state) => state.accessTokens[tokenHash]);
    }

    async getRefreshToken(tokenHash: string): Promise<PersistedTokenRecord | undefined> {
        return this.read((state) => state.refreshTokens[tokenHash]);
    }

    async issueTokens(input: {
        clientId: string;
        scopes: string[];
        resource: string;
        subject: string;
        replaceRefreshTokenHash?: string;
    }): Promise<{ accessToken: string; refreshToken: string; access: PersistedTokenRecord; refresh: PersistedTokenRecord }> {
        const accessToken = randomToken(32);
        const refreshToken = randomToken(48);
        const now = Math.floor(Date.now() / 1000);
        const access: PersistedTokenRecord = {
            clientId: input.clientId,
            scopes: [...input.scopes],
            resource: input.resource,
            expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
            subject: input.subject,
        };
        const refresh: PersistedTokenRecord = {
            ...access,
            expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
        };
        await this.mutate((state) => {
            pruneExpiredTokens(state, now);
            if (input.replaceRefreshTokenHash) delete state.refreshTokens[input.replaceRefreshTokenHash];
            state.accessTokens[hashToken(accessToken)] = access;
            state.refreshTokens[hashToken(refreshToken)] = refresh;
        });
        return { accessToken, refreshToken, access, refresh };
    }

    async revokeToken(token: string): Promise<void> {
        const hash = hashToken(token);
        await this.mutate((state) => {
            delete state.accessTokens[hash];
            delete state.refreshTokens[hash];
        });
    }

    private async read<T>(reader: (state: PersistedOAuthState) => T): Promise<T> {
        return this.serialize(async () => {
            const state = await this.load();
            return reader(state);
        });
    }

    private async mutate<T>(mutator: (state: PersistedOAuthState) => T | Promise<T>): Promise<T> {
        return this.serialize(async () => {
            const state = await this.load();
            const value = await mutator(state);
            state.updatedAt = new Date().toISOString();
            await this.persist(state);
            return value;
        });
    }

    private async load(): Promise<PersistedOAuthState> {
        if (this.state) return this.state;
        try {
            const raw = JSON.parse(await readFile(this.path, 'utf8')) as PersistedOAuthState;
            if (raw.schemaVersion !== 1 || !raw.clients || !raw.accessTokens || !raw.refreshTokens) {
                throw new Error('invalid OAuth state file');
            }
            pruneExpiredTokens(raw, Math.floor(Date.now() / 1000));
            this.state = raw;
        } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')) {
                throw error;
            }
            this.state = {
                schemaVersion: 1,
                updatedAt: new Date().toISOString(),
                clients: {},
                accessTokens: {},
                refreshTokens: {},
            };
        }
        return this.state;
    }

    private async persist(state: PersistedOAuthState): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
        try {
            await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
            });
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

class PersistentClientsStore implements OAuthRegisteredClientsStore {
    private readonly repo: PersistentOAuthRepository;

    constructor(repo: PersistentOAuthRepository) {
        this.repo = repo;
    }

    getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        return this.repo.getClient(clientId);
    }

    async registerClient(
        client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
    ): Promise<OAuthClientInformationFull> {
        return this.repo.registerClient(client as OAuthClientInformationFull);
    }
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
    readonly clientsStore: OAuthRegisteredClientsStore;
    private readonly repo: PersistentOAuthRepository;
    private readonly issuerUrl: URL;
    private readonly resourceUrl: URL;
    private readonly verifyOwnerPassword: SingleUserOAuthProviderOptions['verifyOwnerPassword'];
    private readonly subject: string;
    private readonly supportedScopes: Set<string>;
    private readonly pending = new Map<string, PendingAuthorization>();
    private readonly codes = new Map<string, AuthorizationCodeRecord>();

    constructor(options: SingleUserOAuthProviderOptions) {
        this.repo = new PersistentOAuthRepository(options.statePath);
        this.clientsStore = new PersistentClientsStore(this.repo);
        this.issuerUrl = new URL(options.issuerUrl.href);
        this.resourceUrl = normalizeResourceUrl(options.resourceUrl);
        this.verifyOwnerPassword = options.verifyOwnerPassword;
        this.subject = options.subject ?? 'owner';
        this.supportedScopes = new Set(options.supportedScopes ?? FLEET_OAUTH_SCOPES);
    }

    async authorize(
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
        res: Response,
    ): Promise<void> {
        this.cleanupEphemeralState();
        const resource = params.resource ? normalizeResourceUrl(params.resource) : null;
        if (!resource || resource.href !== this.resourceUrl.href) {
            throw new InvalidRequestError('resource must exactly match the Fleet MCP resource URL');
        }
        const scopes = params.scopes ?? [];
        this.validateScopes(scopes);
        const requestId = randomToken(24);
        this.pending.set(requestId, {
            requestId,
            client,
            params,
            scopes: [...scopes],
            createdAtMs: Date.now(),
            attempts: 0,
        });
        const loginUrl = new URL('/oauth/login', this.issuerUrl);
        loginUrl.searchParams.set('request_id', requestId);
        res.redirect(302, loginUrl.href);
    }

    getPendingAuthorization(requestId: string): PendingAuthorizationView | null {
        this.cleanupEphemeralState();
        const pending = this.pending.get(requestId);
        if (!pending) return null;
        return {
            requestId,
            clientId: pending.client.client_id,
            clientName: pending.client.client_name ?? 'ChatGPT MCP client',
            redirectUri: pending.params.redirectUri,
            scopes: [...pending.scopes],
            resource: pending.params.resource?.href ?? '',
        };
    }

    async completeOwnerLogin(requestId: string, password: string): Promise<URL> {
        this.cleanupEphemeralState();
        const pending = this.pending.get(requestId);
        if (!pending) throw new InvalidGrantError('authorization request expired or invalid');
        pending.attempts += 1;
        if (pending.attempts > MAX_LOGIN_ATTEMPTS) {
            this.pending.delete(requestId);
            throw new InvalidGrantError('too many failed login attempts');
        }
        const accepted = await this.verifyOwnerPassword(password);
        if (!accepted) {
            if (pending.attempts >= MAX_LOGIN_ATTEMPTS) this.pending.delete(requestId);
            throw new InvalidGrantError('owner authentication failed');
        }
        this.pending.delete(requestId);
        const code = randomToken(32);
        this.codes.set(code, {
            clientId: pending.client.client_id,
            params: pending.params,
            scopes: [...pending.scopes],
            expiresAtMs: Date.now() + AUTHORIZATION_CODE_TTL_MS,
        });
        const redirect = new URL(pending.params.redirectUri);
        redirect.searchParams.set('code', code);
        if (pending.params.state !== undefined) redirect.searchParams.set('state', pending.params.state);
        return redirect;
    }

    async challengeForAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
    ): Promise<string> {
        const code = this.requireCode(client, authorizationCode);
        return code.params.codeChallenge;
    }

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        _codeVerifier?: string,
        redirectUri?: string,
        resource?: URL,
    ): Promise<OAuthTokens> {
        const code = this.requireCode(client, authorizationCode);
        if (!redirectUri || redirectUri !== code.params.redirectUri) {
            throw new InvalidGrantError('redirect_uri does not match authorization request');
        }
        const normalizedResource = resource ? normalizeResourceUrl(resource) : null;
        if (!normalizedResource || normalizedResource.href !== this.resourceUrl.href) {
            throw new InvalidGrantError('resource does not match authorization request');
        }
        this.codes.delete(authorizationCode);
        return this.issueOAuthTokens(client.client_id, code.scopes);
    }

    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        resource?: URL,
    ): Promise<OAuthTokens> {
        const tokenHash = hashToken(refreshToken);
        const stored = await this.repo.getRefreshToken(tokenHash);
        const now = Math.floor(Date.now() / 1000);
        if (!stored || stored.expiresAt <= now) throw new InvalidGrantError('invalid or expired refresh token');
        if (stored.clientId !== client.client_id) throw new InvalidGrantError('refresh token belongs to a different client');
        const normalizedResource = resource ? normalizeResourceUrl(resource) : null;
        if (!normalizedResource || normalizedResource.href !== stored.resource || stored.resource !== this.resourceUrl.href) {
            throw new InvalidGrantError('resource does not match refresh token');
        }
        const requestedScopes = scopes ?? stored.scopes;
        this.validateScopes(requestedScopes);
        if (requestedScopes.some((scope) => !stored.scopes.includes(scope))) {
            throw new InvalidGrantError('refresh request cannot expand scopes');
        }
        return this.issueOAuthTokens(client.client_id, requestedScopes, tokenHash);
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const stored = await this.repo.getAccessToken(hashToken(token));
        const now = Math.floor(Date.now() / 1000);
        if (!stored || stored.expiresAt <= now) throw new InvalidGrantError('invalid or expired access token');
        if (stored.resource !== this.resourceUrl.href) throw new InvalidGrantError('access token has wrong resource');
        return {
            token,
            clientId: stored.clientId,
            scopes: [...stored.scopes],
            expiresAt: stored.expiresAt,
            resource: new URL(stored.resource),
            extra: { subject: stored.subject },
        };
    }

    async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
        await this.repo.revokeToken(request.token);
    }

    private requireCode(client: OAuthClientInformationFull, authorizationCode: string): AuthorizationCodeRecord {
        this.cleanupEphemeralState();
        const code = this.codes.get(authorizationCode);
        if (!code || code.expiresAtMs <= Date.now()) {
            this.codes.delete(authorizationCode);
            throw new InvalidGrantError('invalid or expired authorization code');
        }
        if (code.clientId !== client.client_id) throw new InvalidGrantError('authorization code belongs to a different client');
        return code;
    }

    private async issueOAuthTokens(
        clientId: string,
        scopes: string[],
        replaceRefreshTokenHash?: string,
    ): Promise<OAuthTokens> {
        this.validateScopes(scopes);
        const issued = await this.repo.issueTokens({
            clientId,
            scopes,
            resource: this.resourceUrl.href,
            subject: this.subject,
            replaceRefreshTokenHash,
        });
        return {
            access_token: issued.accessToken,
            refresh_token: issued.refreshToken,
            token_type: 'bearer',
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            scope: scopes.join(' '),
        };
    }

    private validateScopes(scopes: string[]): void {
        for (const scope of scopes) {
            if (!this.supportedScopes.has(scope)) throw new InvalidRequestError(`unsupported scope: ${scope}`);
        }
    }

    private cleanupEphemeralState(): void {
        const now = Date.now();
        for (const [requestId, pending] of this.pending) {
            if (now - pending.createdAtMs > AUTHORIZATION_REQUEST_TTL_MS) this.pending.delete(requestId);
        }
        for (const [code, record] of this.codes) {
            if (record.expiresAtMs <= now) this.codes.delete(code);
        }
    }
}

export async function hashOwnerPassword(password: string): Promise<string> {
    if (password.length < 16) throw new Error('owner password must be at least 16 characters');
    const salt = randomBytes(16);
    const derived = await deriveScrypt(password, salt, 32);
    return `scrypt$v1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyOwnerPasswordHash(encoded: string, password: string): Promise<boolean> {
    const [kind, version, saltEncoded, hashEncoded] = encoded.split('$');
    if (kind !== 'scrypt' || version !== 'v1' || !saltEncoded || !hashEncoded) return false;
    let salt: Buffer;
    let expected: Buffer;
    try {
        salt = Buffer.from(saltEncoded, 'base64url');
        expected = Buffer.from(hashEncoded, 'base64url');
    } catch {
        return false;
    }
    if (expected.length !== 32) return false;
    const actual = await deriveScrypt(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
}

function deriveScrypt(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scryptCallback(password, salt, keyLength, { N: 16_384, r: 8, p: 1 }, (error, derivedKey) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(derivedKey as Buffer);
        });
    });
}
function validateRedirectUri(value: string): void {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new InvalidClientMetadataError(`invalid redirect_uri: ${value}`);
    }
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
        throw new InvalidClientMetadataError('redirect_uri must use HTTPS except for loopback development clients');
    }
    if (url.username || url.password || url.hash) {
        throw new InvalidClientMetadataError('redirect_uri must not include credentials or fragments');
    }
}

function normalizeResourceUrl(value: URL): URL {
    const url = new URL(value.href);
    url.hash = '';
    return url;
}

function randomToken(bytes: number): string {
    return randomBytes(bytes).toString('base64url');
}

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function pruneExpiredTokens(state: PersistedOAuthState, nowSeconds: number): void {
    for (const [hash, token] of Object.entries(state.accessTokens)) {
        if (token.expiresAt <= nowSeconds) delete state.accessTokens[hash];
    }
    for (const [hash, token] of Object.entries(state.refreshTokens)) {
        if (token.expiresAt <= nowSeconds) delete state.refreshTokens[hash];
    }
}
