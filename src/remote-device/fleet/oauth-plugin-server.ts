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
    approvalUrl: URL;
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

    app.get('/oauth/login', (req: Request, res: Response) => {
        const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : '';
        const target = new URL('/oauth/approve', issuerUrl);
        if (requestId) target.searchParams.set('request_id', requestId);
        res.redirect(302, target.href);
    });

    app.get('/oauth/approve', (req: Request, res: Response) => {
        setApprovalHeaders(res, options.approvalUrl);
        const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : '';
        const pending = requestId ? options.provider.getPendingAuthorization(requestId) : null;
        const zh = prefersChinese(req);
        if (!pending) {
            res.status(400).send(renderApprovalError(zh ? '此授权请求无效或已过期。' : 'This authorization request is invalid or expired.', zh));
            return;
        }
        res.status(200).send(renderApprovalPage(pending, options.approvalUrl, zh));
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

function setApprovalHeaders(res: Response, approvalUrl: URL): void {
    setNoStore(res);
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${approvalUrl.origin}; frame-ancestors 'none'; base-uri 'none'`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
}

function prefersChinese(req: Request): boolean {
    const value = String(req.headers['accept-language'] ?? '').toLowerCase();
    return !value || value === '*' || value.includes('zh');
}

function renderApprovalPage(
    pending: ReturnType<SingleUserOAuthProvider['getPendingAuthorization']> extends infer T ? Exclude<T, null> : never,
    approvalUrl: URL,
    zh: boolean,
): string {
    const scopeLabel = pending.scopes.length ? pending.scopes.join(', ') : (zh ? '未请求显式权限范围' : 'No explicit scopes requested');
    const title = zh ? '确认 Local Control MCP 授权' : 'Confirm Local Control MCP authorization';
    const clientLabel = zh ? '客户端' : 'Client';
    const accessLabel = zh ? '请求权限' : 'Requested access';
    const codeLabel = zh ? '验证码' : 'Verification code';
    const intro = zh
        ? '请核对验证码，然后点击“允许”。批准动作只会提交到你家里的 LCM 本地网关。'
        : 'Verify the code, then click Allow. Approval is submitted only to your local LCM gateway.';
    const buttonLabel = zh ? '允许' : 'Allow';
    return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1.25rem;line-height:1.5;color:#111}.card{border:1px solid #d0d7de;border-radius:14px;padding:22px}.code{font:700 30px ui-monospace,Consolas,monospace;letter-spacing:.08em}button{margin-top:1rem;padding:.75rem 1.2rem;font-size:16px;font-weight:700}code{overflow-wrap:anywhere}.muted{color:#57606a}
</style>
</head>
<body>
<h1>Local Control MCP（LCM）</h1>
<div class="card">
<p class="muted">${intro}</p>
<p>${clientLabel}：<strong>${escapeHtml(pending.clientName)}</strong></p>
<p>${accessLabel}：<code>${escapeHtml(scopeLabel)}</code></p>
<p>${codeLabel}：</p><div class="code">${escapeHtml(pending.userCode)}</div>
<form method="post" action="${escapeHtml(approvalUrl.href)}">
<input type="hidden" name="request_id" value="${escapeHtml(pending.requestId)}">
<input type="hidden" name="user_code" value="${escapeHtml(pending.userCode)}">
<button type="submit">${buttonLabel}</button>
</form>
</div>
</body>
</html>`;
}

function renderApprovalError(message: string, zh: boolean): string {
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
