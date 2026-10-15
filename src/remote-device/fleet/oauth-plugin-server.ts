import express, { Request, Response } from 'express';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { FleetPluginBackend, createFleetPluginMcpServer } from './plugin-server.js';
import { FLEET_OAUTH_SCOPES, SingleUserOAuthProvider } from './single-user-oauth.js';

export interface FleetOAuthPluginServerOptions {
    backend: FleetPluginBackend;
    provider: SingleUserOAuthProvider;
    issuerUrl: URL;
    resourceUrl: URL;
    serviceDocumentationUrl?: URL;
}

export function createFleetOAuthPluginApp(options: FleetOAuthPluginServerOptions) {
    const issuerUrl = new URL(options.issuerUrl.href);
    const resourceUrl = new URL(options.resourceUrl.href);
    const app = express();
    app.disable('x-powered-by');

    app.get('/healthz', (_req: Request, res: Response) => {
        setNoStore(res);
        res.status(200).json({ ok: true, service: 'network-fleet-plugin' });
    });

    app.get('/readyz', (_req: Request, res: Response) => {
        setNoStore(res);
        res.status(200).json({ ok: true, service: 'network-fleet-plugin', ready: true });
    });

    const loginParser = express.urlencoded({ extended: false, limit: '8kb' });
    app.get('/oauth/login', (req: Request, res: Response) => {
        setLoginHeaders(res);
        const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : '';
        const pending = requestId ? options.provider.getPendingAuthorization(requestId) : null;
        if (!pending) {
            res.status(400).send(renderLoginError(prefersChinese(req) ? '此授权请求无效或已过期。' : 'This authorization request is invalid or expired.', prefersChinese(req)));
            return;
        }
        res.status(200).send(renderLoginPage(pending.requestId, pending.clientName, pending.scopes, prefersChinese(req)));
    });

    app.post('/oauth/login', loginParser, async (req: Request, res: Response) => {
        setLoginHeaders(res);
        const requestId = typeof req.body?.request_id === 'string' ? req.body.request_id : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!requestId || !password) {
            res.status(400).send(renderLoginError(prefersChinese(req) ? '缺少授权请求或密码。' : 'Missing authorization request or password.', prefersChinese(req)));
            return;
        }
        try {
            const redirect = await options.provider.completeOwnerLogin(requestId, password);
            res.redirect(302, redirect.href);
        } catch {
            const pending = options.provider.getPendingAuthorization(requestId);
            const retryForm = pending
                ? renderLoginPage(pending.requestId, pending.clientName, pending.scopes, prefersChinese(req), prefersChinese(req) ? '认证失败。' : 'Authentication failed.')
                : renderLoginError(prefersChinese(req) ? '认证失败或授权请求已过期。' : 'Authentication failed or the authorization request expired.', prefersChinese(req));
            res.status(401).send(retryForm);
        }
    });

    app.use(mcpAuthRouter({
        provider: options.provider,
        issuerUrl,
        resourceServerUrl: resourceUrl,
        serviceDocumentationUrl: options.serviceDocumentationUrl,
        scopesSupported: [...FLEET_OAUTH_SCOPES],
        resourceName: 'Local Control MCP',
        clientRegistrationOptions: {
            clientSecretExpirySeconds: 0,
        },
    }));

    const bearer = requireBearerAuth({
        verifier: options.provider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
        expectedResource: resourceUrl,
    });

    app.post(
        resourceUrl.pathname,
        express.json({ limit: '256kb' }),
        bearer,
        async (req: Request, res: Response) => {
            await handleAuthenticatedMcp(options.backend, req, res);
        },
    );

    app.get(resourceUrl.pathname, bearer, (_req: Request, res: Response) => {
        res.status(405).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed.' },
            id: null,
        });
    });

    app.delete(resourceUrl.pathname, bearer, (_req: Request, res: Response) => {
        res.status(405).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed.' },
            id: null,
        });
    });

    app.use((_req: Request, res: Response) => {
        res.status(404).json({ error: 'not found' });
    });

    return app;
}

export function createFleetOAuthPluginHttpServer(options: FleetOAuthPluginServerOptions) {
    return createServer(createFleetOAuthPluginApp(options));
}

async function handleAuthenticatedMcp(
    backend: FleetPluginBackend,
    req: Request,
    res: Response,
): Promise<void> {
    let server: ReturnType<typeof createFleetPluginMcpServer> | null = null;
    let transport: StreamableHTTPServerTransport | null = null;
    try {
        server = createFleetPluginMcpServer(backend, { enforceOAuthScopes: true });
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch {
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            });
        }
    } finally {
        await transport?.close().catch(() => undefined);
        await server?.close().catch(() => undefined);
    }
}

function setNoStore(res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
}

function setLoginHeaders(res: Response): void {
    setNoStore(res);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
}

function prefersChinese(req: Request): boolean {
    const value = String(req.headers['accept-language'] ?? '').toLowerCase();
    return !value || value === '*' || value.includes('zh');
}

function renderLoginPage(
    requestId: string,
    clientName: string,
    scopes: string[],
    zh: boolean,
    errorMessage?: string,
): string {
    const scopeLabel = scopes.length ? scopes.join(', ') : (zh ? '未请求显式权限范围' : 'No explicit scopes requested');
    const title = zh ? '授权 Local Control MCP' : 'Authorize Local Control MCP';
    const clientLabel = zh ? '客户端' : 'Client';
    const accessLabel = zh ? '请求权限' : 'Requested access';
    const passwordLabel = zh ? '所有者密码' : 'Owner password';
    const buttonLabel = zh ? '授权' : 'Authorize';
    return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.25rem;line-height:1.45;color:#111}label{display:block;margin:.8rem 0 .35rem}input{box-sizing:border-box;width:100%;padding:.7rem;border:1px solid #777;border-radius:.35rem}button{margin-top:1rem;padding:.7rem 1rem}code{overflow-wrap:anywhere}.error{color:#a00}
</style>
</head>
<body>
<h1>Local Control MCP（LCM）</h1>
<p>${clientLabel}：<strong>${escapeHtml(clientName)}</strong></p>
<p>${accessLabel}：<code>${escapeHtml(scopeLabel)}</code></p>
${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ''}
<form method="post" action="/oauth/login" autocomplete="off">
<input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<label for="password">${passwordLabel}</label>
<input id="password" name="password" type="password" required autocomplete="current-password">
<button type="submit">${buttonLabel}</button>
</form>
</body>
</html>`;
}

function renderLoginError(message: string, zh: boolean): string {
    const title = zh ? '授权错误' : 'Authorization error';
    return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
    return value
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;')
        .split("'").join('&#39;');
}
