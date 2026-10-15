import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

export const FLEET_OAUTH_SCOPES = ['fleet:read', 'fleet:write', 'offline_access'] as const;

export interface GPTBinding {
    id: string; clientId: string; createdAt: string; scopes: string[]; resource: string;
}

interface PersistedTokenRecord {
    bindingId: string;
    clientId: string;
    scopes: string[];
    resource: string;
    expiresAt: number;
    subject: string;
}

interface PersistedOAuthState {
    schemaVersion: 2;
    owner: { id: string; createdAt: string };
    activeBinding: GPTBinding | null;
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
    userCode: string;
}

interface AuthorizationCodeRecord {
    bindingId: string;
    clientId: string;
    params: AuthorizationParams;
    scopes: string[];
    expiresAtMs: number;
}

export interface SingleUserOAuthProviderOptions {
    statePath: string;
    issuerUrl: URL;
    resourceUrl: URL;
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
    userCode: string;
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
        return this.read((state) => { const token = state.accessTokens[tokenHash]; return token?.bindingId === state.activeBinding?.id ? token : undefined; });
    }

    async getRefreshToken(tokenHash: string): Promise<PersistedTokenRecord | undefined> {
        return this.read((state) => { const token = state.refreshTokens[tokenHash]; return token?.bindingId === state.activeBinding?.id ? token : undefined; });
    }

    async status() {
        return this.read((state) => structuredClone({ owner: state.owner, activeBinding: state.activeBinding }));
    }

    async activateBinding(clientId: string, scopes: string[], resource: string, expectedBindingId: string | null): Promise<GPTBinding> {
        return this.mutate((state) => {
            if ((state.activeBinding?.id ?? null) !== expectedBindingId) throw new InvalidGrantError('binding changed; review and explicitly approve replacement');
            // Revoke every previous credential in the same durable transaction as activation.
            state.accessTokens = {}; state.refreshTokens = {};
            const binding = { id: randomUUID(), clientId, scopes: [...scopes], resource, createdAt: new Date().toISOString() };
            state.activeBinding = binding;
            return structuredClone(binding);
        });
    }

    async revokeBinding(expectedBindingId: string): Promise<void> {
        await this.mutate((state) => {
            if (!state.activeBinding || state.activeBinding.id !== expectedBindingId) throw new InvalidGrantError('binding changed; review before revoking');
            state.accessTokens = {}; state.refreshTokens = {}; state.activeBinding = null;
        });
    }

    async issueTokens(input: {
        bindingId: string;
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
            bindingId: input.bindingId,
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
            if (state.activeBinding?.id !== input.bindingId || state.activeBinding.clientId !== input.clientId) throw new InvalidGrantError('binding revoked or replaced');
            if (input.replaceRefreshTokenHash) {
                const previous = state.refreshTokens[input.replaceRefreshTokenHash];
                if (!previous || previous.bindingId !== input.bindingId) throw new InvalidGrantError('refresh token already used or revoked');
                delete state.refreshTokens[input.replaceRefreshTokenHash];
            }
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
            const state = structuredClone(await this.load());
            const value = await mutator(state);
            state.updatedAt = new Date().toISOString();
            await this.persist(state);
            this.state = state;
            return value;
        });
    }

    private async load(): Promise<PersistedOAuthState> {
        if (this.state) return this.state;
        try {
            const raw = JSON.parse(await readFile(this.path, 'utf8'));
            if (![1, 2].includes(raw.schemaVersion) || !raw.clients || !raw.accessTokens || !raw.refreshTokens) throw new Error('invalid OAuth state file');
            pruneExpiredTokens(raw, Math.floor(Date.now() / 1000));
            if (raw.schemaVersion === 1) {
                const records = [...Object.values(raw.accessTokens), ...Object.values(raw.refreshTokens)] as PersistedTokenRecord[];
                const clients = new Set(records.map((record) => record.clientId));
                if (clients.size > 1) throw new Error('ambiguous legacy OAuth grants; explicit migration required');
                raw.schemaVersion = 2;
                raw.owner = { id: randomUUID(), createdAt: new Date().toISOString() };
                raw.activeBinding = records.length ? { id: randomUUID(), clientId: records[0].clientId, createdAt: new Date().toISOString(), scopes: [...new Set(records.flatMap(r => r.scopes))], resource: records[0].resource } : null;
                for (const record of records) record.bindingId = raw.activeBinding.id;
                await this.persist(raw);
            }
            if (!raw.owner?.id || !('activeBinding' in raw)) throw new Error('invalid owner/binding state');
            this.state = raw;
        } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')) {
                throw error;
            }
            this.state = {
                schemaVersion: 2,
                owner: { id: randomUUID(), createdAt: new Date().toISOString() },
                activeBinding: null,
                updatedAt: new Date().toISOString(),
                clients: {},
                accessTokens: {},
                refreshTokens: {},
            };
            await this.persist(this.state);
        }
        return this.state!;
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
    private readonly subject: string;
    private readonly supportedScopes: Set<string>;
    private readonly pending = new Map<string, PendingAuthorization>();
    private readonly codes = new Map<string, AuthorizationCodeRecord>();

    constructor(options: SingleUserOAuthProviderOptions) {
        this.repo = new PersistentOAuthRepository(options.statePath);
        this.clientsStore = new PersistentClientsStore(this.repo);
        this.issuerUrl = new URL(options.issuerUrl.href);
        this.resourceUrl = normalizeResourceUrl(options.resourceUrl);
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
            userCode: randomUserCode(),
        });
        const approvalUrl = new URL('/oauth/approve', this.issuerUrl);
        approvalUrl.searchParams.set('request_id', requestId);
        res.redirect(302, approvalUrl.href);
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
            userCode: pending.userCode,
        };
    }

    async edgeHealth() {
        const response = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', this.issuerUrl), { signal: AbortSignal.timeout(5000), redirect: 'error' });
        const metadata = await response.json() as { resource?: string };
        return { available: response.ok && metadata.resource === this.resourceUrl.href, checkedAt: new Date().toISOString() };
    }

    async bindingStatus() { return this.repo.status(); }

    async revokeBinding(expectedBindingId: string): Promise<void> {
        await this.repo.revokeBinding(expectedBindingId);
        this.codes.clear();
    }

    async completeLocalApproval(requestId: string, userCode: string, expectedBindingId: string | null = null): Promise<URL> {
        this.cleanupEphemeralState();
        const pending = this.pending.get(requestId);
        if (!pending) throw new InvalidGrantError('authorization request expired or invalid');
        if (normalizeUserCode(userCode) !== normalizeUserCode(pending.userCode)) {
            throw new InvalidGrantError('verification code does not match authorization request');
        }
        // Consume before awaiting storage so parallel approvals cannot mint duplicate codes.
        this.pending.delete(requestId);
        const binding = await this.repo.activateBinding(pending.client.client_id, pending.scopes, this.resourceUrl.href, expectedBindingId);
        const code = randomToken(32);
        this.codes.set(code, {
            bindingId: binding.id,
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
        return this.issueOAuthTokens(client.client_id, code.scopes, code.bindingId);
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
        return this.issueOAuthTokens(client.client_id, requestedScopes, stored.bindingId, tokenHash);
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
        bindingId: string,
        replaceRefreshTokenHash?: string,
    ): Promise<OAuthTokens> {
        this.validateScopes(scopes);
        const issued = await this.repo.issueTokens({
            bindingId,
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

function normalizeUserCode(value: string): string {
    return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomUserCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(8);
    let raw = '';
    for (const byte of bytes) raw += alphabet[byte % alphabet.length];
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
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
