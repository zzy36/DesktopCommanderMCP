import { AdminAccessError, LocalAdminSecurity } from './local-admin-security.js';
import { localizeLcmError } from './presentation-zh.js';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { FleetGateway, FleetGatewayCallRecord } from './fleet-gateway.js';
import { FleetEnrollmentStore } from './enrollment-store.js';
import type { DeviceBinding } from './protocol.js';
import type { SingleUserOAuthProvider } from './single-user-oauth.js';

export type BridgeWindowMode = 'hidden' | 'visible';
export type RdcAction = 'status' | 'start' | 'stop' | 'restart' | 'show' | 'hide' | 'enable' | 'disable';
export interface RdcStatus { hostname: string; task?: string; state?: string; enabled?: boolean; autostart?: boolean; windowMode?: 'hidden' | 'visible'; rdcVersion?: string | null; processCount?: number; pids?: number[]; lastRunTime?: string | null; lastTaskResult?: number | null; error?: string; }

export interface FleetAdminServerOptions {
    security: LocalAdminSecurity;
    release?: string;
    onRevokeDevice?: (hostname: string) => void | Promise<void>;
    bridgeWindowModes?: Record<string, BridgeWindowMode>;
    onSetBridgeWindowMode?: (hostname: string, mode: BridgeWindowMode) => void | Promise<void>;
    onGetRdcStatuses?: () => Promise<Record<string, RdcStatus>>;
    onControlRdc?: (hostname: string, action: RdcAction) => Promise<RdcStatus>;
    basePath?: string;
    projects: Array<{ projectId: string; hostname: string; policyRevision: string }>;
    enrollmentStore?: FleetEnrollmentStore;
    onApproveDevice?: (device: DeviceBinding) => void | Promise<void>;
    oauthProvider?: SingleUserOAuthProvider;
}

export function createFleetAdminHttpServer(
    gateway: FleetGateway,
    options: FleetAdminServerOptions,
): Server {
    const basePath = normalizeBasePath(options.basePath ?? '/admin');
    return createServer((req, res) => {
        void handleRequest(req, res, gateway, options, basePath).catch((error) => {
            sendJson(res, error instanceof AdminAccessError ? error.status : 400, { error: localizeLcmError(error) });
        });
    });
}

async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    gateway: FleetGateway,
    options: FleetAdminServerOptions,
    basePath: string,
): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === `${basePath}/healthz`) {
        return sendJson(res, 200, { ok: true, service: 'network-fleet-admin' });
    }
    const security = options.security;
    if (!security) throw new Error('local admin security is required');
    // Public OAuth form landing is read-only. Final approval is a same-origin,
    // authenticated CSRF form; cross-site POST can never activate a binding.
    if (req.method === 'POST' && url.pathname === '/oauth/local-approve') {
        const form = await readFormBody(req);
        res.statusCode = 303;
        res.setHeader('cache-control', 'no-store');
        res.setHeader('location', `${security.origin}${basePath}/approve?request_id=${encodeURIComponent(form.request_id ?? '')}`);
        res.end(); return;
    }
    if (url.pathname === `${basePath}/login`) {
        if (req.method === 'GET') {
            const nonce = security.loginNonce(res);
            return sendHtml(res, 200, loginHtml(basePath, nonce, safeReturn(url.searchParams.get('return'), basePath)));
        }
        if (req.method === 'POST') {
            const body = await readFormBody(req);
            security.login(req, res, body.secret ?? '', body.nonce ?? '');
            res.statusCode = 303; res.setHeader('location', safeReturn(body.return, basePath)); res.end(); return;
        }
    }
    const protocol = ['/device/start', '/device/poll', '/pair/claim', '/pair/status'].includes(url.pathname);
    if (!protocol && !security.session(req) && req.method === 'GET' && !url.pathname.includes('/api/')) {
        res.statusCode = 303; res.setHeader('location', `${basePath}/login?return=${encodeURIComponent(url.pathname + url.search)}`); res.end(); return;
    }
    if (!protocol) security.requireSession(req);
    if (!protocol && req.method !== 'GET' && req.method !== 'HEAD' && url.pathname !== `${basePath}/approve`) security.requireMutation(req);
    if (req.method === 'GET' && url.pathname === `${basePath}/api/session`) return sendJson(res, 200, { csrf: security.requireSession(req).csrf });
    if (req.method === 'POST' && url.pathname === `${basePath}/logout`) { security.logout(req, res); return sendJson(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === `${basePath}/api/binding`) return sendJson(res, 200, options.oauthProvider ? await options.oauthProvider.bindingStatus() : { disabled: true });
    if (req.method === 'POST' && url.pathname === `${basePath}/api/binding/revoke`) {
        if (!options.oauthProvider) return sendJson(res, 404, { error: 'OAuth disabled' });
        const body = await readJsonBody(req);
        await options.oauthProvider.revokeBinding(String(body.expectedBindingId ?? ''));
        return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === `${basePath}/approve`) {
        if (!options.oauthProvider) return sendJson(res, 404, { error: 'OAuth disabled' });
        if (req.method === 'GET') {
            const pending = options.oauthProvider.getPendingAuthorization(url.searchParams.get('request_id') ?? '');
            if (!pending) return sendHtml(res, 404, '<h1>授权请求已过期</h1>');
            const { activeBinding } = await options.oauthProvider.bindingStatus();
            const fields = { csrf: security.requireSession(req).csrf, request_id: pending.requestId, expectedBindingId: activeBinding?.id ?? '' };
            return sendHtml(res, 200, `<h1>Local Control MCP</h1><h2>${activeBinding ? '替换当前 GPT 绑定' : '连接 GPT'}</h2><p>客户端：${escapeHtml(pending.clientName)}</p><p>权限：${escapeHtml(pending.scopes.join(', '))}</p><p>请对照 GPT 页面短码：<strong>${escapeHtml(pending.userCode)}</strong></p><p>${activeBinding ? '允许后，当前绑定及其所有令牌立即撤销。已登记设备保留。' : '允许此客户端访问 LCM 已授权设备。'}</p><form method="post" action="${basePath}/approve">${Object.entries(fields).map(([k,v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('')}<label>输入 GPT 页面短码 <input name="user_code" required autocomplete="off"></label><button>${activeBinding ? '撤销旧绑定并允许替换' : '允许连接'}</button></form>`);
        }
        if (req.method === 'POST') {
            const form = await readFormBody(req);
            security.requireMutation(req, form.csrf);
            const redirect = await options.oauthProvider.completeLocalApproval(form.request_id ?? '', form.user_code ?? '', form.expectedBindingId || null);
            res.statusCode = 303; res.setHeader('cache-control', 'no-store'); res.setHeader('location', redirect.href); res.end(); return;
        }
    }
    if (req.method === 'POST' && url.pathname === `${basePath}/api/devices/revoke`) {
        if (!options.onRevokeDevice) return sendJson(res, 404, { error: 'device revocation disabled' });
        const body = await readJsonBody(req); await options.onRevokeDevice(String(body.hostname ?? ''));
        return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === `${basePath}/api/devices/window-mode`) {
        if (!options.onSetBridgeWindowMode) return sendJson(res, 404, { error: 'bridge window control disabled' });
        const body = await readJsonBody(req);
        const hostname = String(body.hostname ?? '').trim();
        const mode = String(body.mode ?? '');
        if (mode !== 'hidden' && mode !== 'visible') return sendJson(res, 400, { error: 'mode must be hidden or visible' });
        await options.onSetBridgeWindowMode(hostname, mode);
        if (options.bridgeWindowModes) options.bridgeWindowModes[hostname.toUpperCase()] = mode;
        return sendJson(res, 200, { ok: true, hostname, mode });
    }
    if (req.method === 'GET' && url.pathname === `${basePath}/api/rdc`) {
        if (!options.onGetRdcStatuses) return sendJson(res, 404, { error: 'RDC control disabled' });
        return sendJson(res, 200, { devices: await options.onGetRdcStatuses() });
    }
    if (req.method === 'POST' && url.pathname === `${basePath}/api/devices/rdc`) {
        if (!options.onControlRdc) return sendJson(res, 404, { error: 'RDC control disabled' });
        const body = await readJsonBody(req);
        const hostname = String(body.hostname ?? '').trim();
        const action = String(body.action ?? '') as RdcAction;
        if (!['status','start','stop','restart','show','hide','enable','disable'].includes(action)) return sendJson(res, 400, { error: 'invalid RDC action' });
        const status = await options.onControlRdc(hostname, action);
        return sendJson(res, 200, { ok: true, status });
    }
    if (req.method === 'GET' && url.pathname === `${basePath}/api/status`) {
        return sendJson(res, 200, buildStatus(gateway, options));
    }
    if (req.method === 'GET' && url.pathname === `${basePath}/api/calls`) {
        const requested = Number(url.searchParams.get('limit') ?? '20');
        const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.trunc(requested))) : 20;
        return sendJson(res, 200, { calls: redactCalls(gateway.listCallRecords(limit)) });
    }
    if (req.method === 'GET' && url.pathname === `${basePath}/api/edge-health`) {
        if (!options.oauthProvider) return sendJson(res, 200, { available: false });
        try {
            const metadata = await options.oauthProvider.edgeHealth();
            return sendJson(res, 200, metadata);
        } catch { return sendJson(res, 200, { available: false, checkedAt: new Date().toISOString() }); }
    }
    if (req.method === 'GET' && url.pathname === `${basePath}/api/bootstrap`) {
        return sendJson(res, 200, bootstrapGuide());
    }
    if (req.method === 'GET' && url.pathname === `${basePath}/api/pairings`) {
        if (!options.enrollmentStore) return sendJson(res, 404, { error: 'pairing is disabled' });
        return sendJson(res, 200, { pairings: options.enrollmentStore.listPairings() });
    }
    if (req.method === 'POST' && url.pathname === `${basePath}/api/pairings`) {
        if (!options.enrollmentStore) return sendJson(res, 404, { error: 'pairing is disabled' });
        const body = await readJsonBody(req);
        const pairing = await options.enrollmentStore.createPairing(String(body.hostname ?? ''));
        return sendJson(res, 201, pairing);
    }
    if (req.method === 'POST' && url.pathname === '/device/start') {
        if (!options.enrollmentStore) return sendJson(res, 404, { error: 'device authorization is disabled' });
        const body = await readJsonBody(req);
        if (String(body.code_challenge_method ?? 'S256') !== 'S256') return sendJson(res, 400, { error: 'unsupported_code_challenge_method' });
        const authorization = await options.enrollmentStore.createDeviceAuthorization({
            hostname: String(body.device_name ?? body.hostname ?? ''),
            fingerprint: String(body.fingerprint ?? ''),
            policyRevision: String(body.policy_revision ?? body.policyRevision ?? ''),
            codeChallenge: String(body.code_challenge ?? ''),
        });
        const origin = options.security.origin;
        return sendJson(res, 200, {
            device_code: authorization.deviceCode,
            user_code: authorization.userCode,
            verification_uri: `${origin}/pair`,
            verification_uri_complete: `${origin}/pair?code=${encodeURIComponent(authorization.userCode)}`,
            expires_in: Math.max(1, Math.floor((authorization.expiresAtMs - Date.now()) / 1000)),
            interval: 2,
        });
    }
    if (req.method === 'POST' && url.pathname === '/device/poll') {
        if (!options.enrollmentStore) return sendJson(res, 404, { error: 'device authorization is disabled' });
        const body = await readJsonBody(req);
        const authorization = await options.enrollmentStore.pollDeviceAuthorization({
            deviceCode: String(body.device_code ?? ''),
            codeVerifier: String(body.code_verifier ?? ''),
        });
        if (authorization.status === 'pending') return sendJson(res, 400, { error: 'authorization_pending' });
        if (authorization.status === 'expired') return sendJson(res, 400, { error: 'expired_token' });
        return sendJson(res, 200, {
            status: 'approved',
            device_id: authorization.hostname,
            hostname: authorization.hostname,
            public_key_fingerprint: authorization.fingerprint,
            policy_revision: authorization.policyRevision,
            credential_type: 'ed25519',
        });
    }
    if (req.method === 'GET' && url.pathname === '/pair') {
        if (!options.enrollmentStore) return sendHtml(res, 404, '<h1>设备验证功能未启用</h1>');
        const code = url.searchParams.get('code') ?? '';
        const authorization = code ? options.enrollmentStore.getDeviceAuthorizationByUserCode(code) : null;
        return sendHtml(res, authorization ? 200 : (code ? 404 : 200), renderDeviceApprovalHtml(code, authorization, prefersChinese(req), security.requireSession(req).csrf));
    }
    if (req.method === 'POST' && url.pathname === '/pair/approve') {
        if (!options.enrollmentStore || !options.onApproveDevice) return sendJson(res, 404, { error: 'device authorization is disabled' });
        const body = await readJsonBody(req);
        const approved = await options.enrollmentStore.approveDeviceAuthorizationByUserCode(String(body.code ?? ''));
        await options.onApproveDevice(approved.device);
        return sendJson(res, 200, { ok: true, authorization: approved.authorization, device: approved.device });
    }
    if (req.method === 'POST' && url.pathname === '/pair/claim') {
        if (!options.enrollmentStore) return sendJson(res, 404, { error: 'pairing is disabled' });
        const body = await readJsonBody(req);
        const pairing = await options.enrollmentStore.claimPairing({
            code: String(body.code ?? ''),
            hostname: String(body.hostname ?? ''),
            fingerprint: String(body.fingerprint ?? ''),
            policyRevision: String(body.policyRevision ?? ''),
        });
        return sendJson(res, 200, pairing);
    }
    if (req.method === 'GET' && url.pathname === '/pair/status') {
        if (!options.enrollmentStore) return sendJson(res, 404, { error: 'pairing is disabled' });
        const code = url.searchParams.get('code') ?? '';
        const pairing = options.enrollmentStore.getPairingByCode(code);
        if (!pairing) return sendJson(res, 404, { error: 'pairing not found' });
        return sendJson(res, 200, pairing);
    }
    const approveMatch = url.pathname.match(new RegExp(`^${escapeRegExp(basePath)}/api/pairings/([^/]+)/approve$`));
    if (req.method === 'POST' && approveMatch) {
        if (!options.enrollmentStore || !options.onApproveDevice) return sendJson(res, 404, { error: 'pairing is disabled' });
        const device = await options.enrollmentStore.approvePairing(decodeURIComponent(approveMatch[1]));
        await options.onApproveDevice(device);
        return sendJson(res, 200, { ok: true, device });
    }
    if (req.method === 'GET' && (url.pathname === basePath || url.pathname === `${basePath}/`)) {
        return sendHtml(res, 200, renderAdminHtml(basePath, security.requireSession(req).csrf));
    }
    return sendJson(res, 404, { error: 'not found' });
}

function prefersChinese(req: IncomingMessage): boolean {
    const value = String(req.headers['accept-language'] ?? '').toLowerCase();
    return !value || value.includes('zh');
}

function renderDeviceApprovalHtml(code: string, authorization: ReturnType<FleetEnrollmentStore['getDeviceAuthorizationByUserCode']>, zh: boolean, csrf: string): string {
    const safeCode = escapeHtml(code);
    const title = zh ? 'LCM 设备验证' : 'LCM device verification';
    if (!code) {
        const prompt = zh ? '请输入 PowerShell 中显示的验证码。' : 'Enter the verification code shown in PowerShell.';
        const button = zh ? '继续' : 'Continue';
        return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui;max-width:680px;margin:60px auto;padding:0 20px"><h1>Local Control MCP</h1><p>${prompt}</p><form method="get" action="/pair"><input name="code" autocomplete="one-time-code" placeholder="ABCD-EFGH" style="font-size:24px;padding:10px"><button style="font-size:18px;padding:12px;margin-left:8px">${button}</button></form></body></html>`;
    }
    if (!authorization) {
        const heading = zh ? '验证码无效' : 'Code not found';
        const text = zh ? `验证码 <b>${safeCode}</b> 不存在或已过期。` : `The code <b>${safeCode}</b> is invalid or expired.`;
        return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui;max-width:680px;margin:60px auto;padding:0 20px"><h1>${heading}</h1><p>${text}</p></body></html>`;
    }
    const canApprove = authorization.status === 'pending';
    const rawStatus = authorization.status;
    const status = escapeHtml(zh ? ({pending:'等待确认',approved:'已批准',expired:'已过期'}[rawStatus] ?? rawStatus) : rawStatus);
    const host = escapeHtml(authorization.hostname);
    const fingerprint = escapeHtml(authorization.fingerprint);
    const policy = escapeHtml(authorization.policyRevision);
    const intro = zh ? '请确认下面的设备、验证码和 PowerShell 窗口中显示的信息完全一致。' : 'Verify that the device and code match the PowerShell window.';
    const codeLabel = zh ? '验证码' : 'Verification code';
    const fingerprintLabel = zh ? '设备指纹' : 'Fingerprint';
    const policyLabel = zh ? '传输协议' : 'Protocol';
    const statusLabel = zh ? '状态' : 'Status';
    const approveText = zh ? '批准此设备' : 'Approve this device';
    const okText = zh ? '设备已批准。请返回 PowerShell。' : 'Device approved. Return to PowerShell.';
    const errorPrefix = zh ? '错误：' : 'ERROR: ';
    const approvedStatus = zh ? '已批准' : 'approved';
    return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;background:#101214;color:#eef2f6;max-width:760px;margin:50px auto;padding:0 20px}.card{background:#181c20;border:1px solid #30363d;border-radius:16px;padding:24px}code{word-break:break-all}button{padding:12px 18px;border:0;border-radius:10px;font-weight:700;font-size:16px;cursor:pointer}.muted{color:#a9b2bd}.ok{color:#66d19e}</style></head><body><h1>Local Control MCP</h1><div class="card"><p class="muted">${intro}</p><h2>${host}</h2><p>${codeLabel}：<b style="font-size:24px">${safeCode}</b></p><p>${fingerprintLabel}：<code>${fingerprint}</code></p><p>${policyLabel}：<code>${policy}</code></p><p>${statusLabel}：<b id="status">${status}</b></p>${canApprove ? `<button id="approve">${approveText}</button>` : ''}<p id="message" class="ok"></p></div><script>${canApprove ? `document.getElementById('approve').onclick=async()=>{const b=document.getElementById('approve');b.disabled=true;const r=await fetch('/pair/approve',{method:'POST',headers:{'content-type':'application/json','x-lcm-csrf':${JSON.stringify(csrf)}},body:JSON.stringify({code:${JSON.stringify(code)}})});const d=await r.json();if(r.ok){document.getElementById('status').textContent=${JSON.stringify(approvedStatus)};document.getElementById('message').textContent=${JSON.stringify(okText)};b.remove()}else{document.getElementById('message').textContent=${JSON.stringify(errorPrefix)}+(d.error||r.status);b.disabled=false}};` : ''}</script></body></html>`;
}

function escapeHtml(value: string): string {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
function buildStatus(gateway: FleetGateway, options: FleetAdminServerOptions) {
    const devices = gateway.listKnownDeviceStatuses().map((status) => ({
        ...status,
        fingerprint: status.publicKeyFingerprint,
        agentVersion: status.agentVersion,
        versionStatus: status.agentVersion ? 'reported' : 'not-reported',
        bridgeWindowMode: options.bridgeWindowModes?.[status.hostname.toUpperCase()] ?? 'unknown',
    }));
    return {
        ok: true,
        service: 'network-fleet-admin',
        release: options.release ?? 'development',
        generatedAt: new Date().toISOString(),
        devices,
        revokedDevices: options.enrollmentStore?.listRevokedDevices() ?? [],
        usage: gateway.usageStats(),
        recentCalls: redactCalls(gateway.listCallRecords(20)),
    };
}

function redactCalls(records: FleetGatewayCallRecord[]) {
    return records.map(({ result: _result, ...record }) => record);
}

function bootstrapGuide() {
    return {
        flow: [
            '在受管 Windows 设备上运行 Start-LCMRemote.ps1（或 lcm remote）。',
            '设备生成或加载自己的 Ed25519 身份并创建 PKCE challenge，然后向 KVM 请求短期验证码并自动打开浏览器。',
            '在浏览器中核对设备名、验证码和指纹，确认无误后批准该设备。',
            'PowerShell 会持续轮询直到批准完成；设备私钥不会离开本机。',
            '引导流程只安装内部 LCM Agent 与登录用户执行器，不注册 Native LCM 插件。',
            '最后验证 list_devices、ping 与文件/搜索/进程/配置能力；业务项目角色由外部治理另行分配。',
        ],
        commands: {
            provisionOnly: 'pwsh -NoProfile -File ".\\Install-LCMAgent.ps1" -Release <PINNED_COMMIT> -ExpectedHostname <EXACT_HOSTNAME> -ProvisionOnly',
            installAndStart: 'pwsh -NoProfile -File ".\\Install-LCMAgent.ps1" -Release <PINNED_COMMIT> -ExpectedHostname <EXACT_HOSTNAME> -BridgeWindowMode hidden -InstallTask -StartNow',
            verifyTransport: 'Use the private App to run list_devices(), ping(hostname), then exact-host read/search/process/config smoke tests.',
        },
        note: '不需要账号数据库。Owner 设备验证只建立设备身份与可达性，不会授予业务项目权限；业务授权由外部治理单独决定。',
    };
}

async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
    const raw = await readRequestBody(req);
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > 64 * 1024) throw new Error('request body too large');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readRequestBody(req);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
    return parsed as Record<string, unknown>;
}

function normalizeBasePath(value: string): string {
    let result = value.trim();
    if (!result.startsWith('/')) result = `/${result}`;
    result = result.replace(/\/+$/, '');
    if (!result || result === '/') throw new Error('admin basePath must be a non-root path');
    return result;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
    res.statusCode = status;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.end(body);
}

function renderAdminHtml(basePath: string, csrf: string): string {
    const api = JSON.stringify(basePath);
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local Control MCP</title><style>
:root{font-family:Inter,"Segoe UI",system-ui,sans-serif;color-scheme:dark;--bg:#0d0f12;--panel:#15191e;--panel2:#1b2026;--line:#29313a;--text:#eef3f8;--muted:#95a0ad;--accent:#8db7ff;--good:#6fd7a6;--bad:#ff8f96;--warn:#ffd37b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}.wrap{max-width:1280px;margin:auto;padding:28px 22px 52px}.page-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:22px}.eyebrow{font-size:11px;letter-spacing:.15em;color:var(--accent);font-weight:750}h1{font-size:30px;line-height:1.15;margin:6px 0 7px}.sub,.section-copy{color:var(--muted);margin:0;line-height:1.55}.head-badges{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.tag,.pill{display:inline-flex;align-items:center;border:1px solid var(--line);background:#20262d;border-radius:999px;padding:5px 9px;font-size:12px;color:#c8d1db}.summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:24px}.summary{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px 16px}.summary-label{font-size:12px;color:var(--muted);margin-bottom:6px}.summary-value{font-size:23px;font-weight:760;letter-spacing:-.02em}.summary-value.small{font-size:15px;padding-top:6px}.ok{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.section,.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px}.section{margin-bottom:16px}.section-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px}.section h2,.panel h2{font-size:18px;margin:0 0 5px}.section-meta{font-size:12px;color:var(--muted);white-space:nowrap}.device-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:12px}.device-card{border:1px solid var(--line);background:var(--panel2);border-radius:14px;padding:15px;min-width:0}.device-card.offline{opacity:.78}.device-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.device-name{font-size:19px;font-weight:760;letter-spacing:.01em}.status{display:inline-flex;align-items:center;gap:6px;font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--bad)}.status.online .dot{background:var(--good);box-shadow:0 0 0 3px rgba(111,215,166,.12)}.device-version{font-size:12px;color:var(--muted);margin-top:4px}.control-block{margin:16px 0 13px;padding:12px;border-radius:12px;background:#11151a;border:1px solid #252d35}.control-label{font-size:12px;color:var(--muted);margin-bottom:8px}.window-row{display:flex;justify-content:space-between;gap:12px;align-items:center}.window-state{font-weight:720}.seg{display:inline-flex;padding:3px;background:#0c1014;border:1px solid var(--line);border-radius:10px;gap:2px}.seg-btn{border:0;background:transparent;color:#b8c2cd;padding:7px 11px;border-radius:7px;font-weight:700;cursor:pointer}.seg-btn:hover:not(:disabled){background:#222a32;color:white}.seg-btn.active{background:#e8eef6;color:#111}.seg-btn:disabled{cursor:default;opacity:1}.control-note{font-size:11px;color:var(--muted);margin-top:8px}.rdc-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.rdc-actions button{padding:7px 9px;font-size:11px}.device-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.meta-box{background:#12161b;border-radius:10px;padding:9px 10px;min-width:0}.meta-label{font-size:11px;color:var(--muted)}.meta-value{font-size:12px;font-weight:650;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}details{margin-top:10px}summary{cursor:pointer;color:#aab5c1;font-size:12px}.details-grid{display:grid;gap:7px;margin-top:9px;font-size:12px}.detail-row{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px}.detail-row span:first-child{color:var(--muted)}code,.mono,pre,input{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.mono{overflow-wrap:anywhere}.danger-row{display:flex;justify-content:flex-end;margin-top:12px;padding-top:11px;border-top:1px solid var(--line)}button{border:0;border-radius:9px;padding:9px 13px;font-weight:700;cursor:pointer;background:#e8eef6;color:#111}button:hover{filter:brightness(1.04)}button:disabled{cursor:not-allowed;opacity:.62}.btn-secondary{background:#252c34;color:#e8edf3;border:1px solid #343e48}.btn-danger{background:transparent;color:#ff9aa1;border:1px solid #6d3439}.btn-danger:hover{background:#30191c}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}.panel{min-width:0}.panel-copy{font-size:12px;color:var(--muted);line-height:1.55;margin:0 0 12px}.kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:7px 10px;font-size:13px}.kv .k{color:var(--muted)}pre{white-space:pre-wrap;background:#0d1115;border:1px solid #232a31;padding:12px;border-radius:10px;overflow:auto;font-size:12px}input{background:#0d1115;color:var(--text);border:1px solid #39434d;border-radius:9px;padding:10px 11px;min-width:220px;outline:none}input:focus{border-color:var(--accent)}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:11px}table{width:100%;border-collapse:collapse;min-width:650px}th,td{text-align:left;padding:10px 11px;border-bottom:1px solid var(--line);font-size:12px}th{position:sticky;top:0;background:#1a2026;color:#aab4bf;font-weight:700}tr:last-child td{border-bottom:0}.maintenance{margin-top:16px}.notice{position:fixed;right:22px;bottom:22px;max-width:380px;background:#20272e;border:1px solid #38434d;border-radius:12px;padding:12px 14px;box-shadow:0 12px 35px rgba(0,0,0,.35);font-size:13px;z-index:20}.notice.bad{color:#ffd4d7;border-color:#6d3439;background:#30191c}@media(max-width:820px){.summary-grid{grid-template-columns:1fr 1fr}.two-col{grid-template-columns:1fr}.page-head{flex-direction:column}.head-badges{justify-content:flex-start}}@media(max-width:480px){.wrap{padding:18px 12px 40px}.summary-grid{grid-template-columns:1fr 1fr}.device-grid{grid-template-columns:1fr}.window-row{align-items:flex-start;flex-direction:column}.device-meta{grid-template-columns:1fr}}
</style></head>
<body><div class="wrap">
<header class="page-head"><div><div class="eyebrow">LOCAL CONTROL MCP</div><h1>设备控制中心</h1><p class="sub">Owner 设备状态与本机交互控制。日常操作集中在设备卡片，危险操作单独隔离。</p></div><div class="head-badges"><span class="tag">LAN Admin</span><span class="tag">Exact-host</span><span class="tag">Device-first</span></div></header>
<div class="summary-grid"><div class="summary"><div class="summary-label">网关</div><div class="summary-value ok" id="gateway">检查中…</div></div><div class="summary"><div class="summary-label">在线设备</div><div class="summary-value" id="online">—</div></div><div class="summary"><div class="summary-label">进行中调用</div><div class="summary-value" id="inflight">—</div></div><div class="summary"><div class="summary-label">最后刷新</div><div class="summary-value small" id="updated">—</div></div></div>
<section class="section"><div class="section-head"><div><h2>设备控制</h2><p class="section-copy">每台设备独立控制登录用户窗口。切换只重启 User Bridge，SYSTEM Agent 保持在线。</p></div><div class="section-meta" id="deviceCount">加载中</div></div><div id="devices" class="device-grid"></div></section>
<div class="two-col"><section class="panel"><h2>连接与发布</h2><p class="panel-copy">查看公网 MCP 可达性与当前 Gateway 版本。</p><div class="kv"><div class="k">公网 MCP</div><div id="edgeHealth">检查中</div><div class="k">Gateway</div><div id="release">加载中</div></div></section><section class="panel"><h2>所有者 / GPT 绑定</h2><p class="panel-copy">更换 GPT 时从新 GPT 发起连接，再在本机批准。设备身份不会改变。</p><div id="binding">加载中</div><div class="danger-row"><button class="btn-danger" id="revokeBinding">撤销 GPT 绑定</button></div></section></div>
<div class="two-col"><section class="panel"><h2>添加设备</h2><p class="panel-copy">推荐新设备运行 <code>lcm remote</code> 使用浏览器短码验证。下方保留旧手工配对流程。</p><div class="row"><input id="pairHost" placeholder="设备名"><button id="createPair">创建 10 分钟配对码</button></div><pre id="pairOutput">尚未创建配对码。</pre><div class="table-wrap"><table><thead><tr><th>设备</th><th>状态</th><th>指纹</th><th>过期时间</th><th>操作</th></tr></thead><tbody id="pairings"></tbody></table></div></section><section class="panel"><h2>新设备引导</h2><p class="panel-copy">仅安装内部 Agent 与登录用户执行器，不注册 Native LCM 插件。Owner 登记只建立身份与可达性。</p><button class="btn-secondary" id="guide">加载引导说明</button><pre id="boot">尚未加载。</pre></section></div>
<section class="panel maintenance"><div class="section-head"><div><h2>最近调用</h2><p class="section-copy">用于排障和审计，不占用主控制区。</p></div></div><div class="table-wrap"><table><thead><tr><th>调用 ID</th><th>设备</th><th>工具</th><th>状态</th><th>代码</th></tr></thead><tbody id="calls"></tbody></table></div></section>
</div><div id="notice" class="notice" hidden></div><script>
const stateLabel=s=>({pending:'等待批准',claimed:'等待核对指纹',approved:'已批准',expired:'已过期',revoked:'已撤销',queued:'排队中',sent:'已发送',accepted:'已接收',running:'运行中',completed:'已完成',failed:'失败',cancelled:'已取消',timed_out:'已超时'}[s]??s);
const base=${api}; const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shortVersion=v=>v?String(v).slice(0,8):'未上报'; const fmtTime=v=>v?new Date(v).toLocaleString():'—';
async function json(url,opts){const r=await fetch(url,{cache:'no-store',...opts,headers:{...opts?.headers,'x-lcm-csrf':${JSON.stringify(csrf)}}});const d=await r.json();if(!r.ok)throw new Error('操作失败（HTTP '+r.status+'）：'+(d.error||'请重试'));return d}
let noticeTimer;function notify(message,type='ok'){const n=document.getElementById('notice');clearTimeout(noticeTimer);n.textContent=message;n.className='notice '+(type==='bad'?'bad':'');n.hidden=false;noticeTimer=setTimeout(()=>n.hidden=true,2600)}
function deviceCard(x){const mode=x.bridgeWindowMode;const modeText=mode==='visible'?'显示':(mode==='hidden'?'隐藏':'未设置');const online=x.online;const r=rdcState[x.hostname]||{};const rState=r.error?'异常':(r.state==='Running'?'运行':(r.state==='Disabled'?'已禁用':(r.state||'检查中')));const rMode=r.windowMode==='visible'?'显示':(r.windowMode==='hidden'?'隐藏':'—');return '<article class="device-card '+(online?'':'offline')+'"><div class="device-top"><div><div class="device-name">'+esc(x.hostname)+'</div><div class="device-version">Agent '+esc(shortVersion(x.agentVersion))+'</div></div><div class="status '+(online?'online':'')+'"><span class="dot"></span>'+(online?'在线':'离线')+'</div></div><div class="control-block"><div class="control-label">登录用户连接窗口</div><div class="window-row"><div class="window-state">'+esc(modeText)+'</div><div class="seg"><button class="seg-btn '+(mode==='hidden'?'active':'')+'" data-window-mode="hidden" data-host="'+esc(x.hostname)+'" '+(mode==='hidden'?'disabled':'')+'>隐藏</button><button class="seg-btn '+(mode==='visible'?'active':'')+'" data-window-mode="visible" data-host="'+esc(x.hostname)+'" '+(mode==='visible'?'disabled':'')+'>显示</button></div></div><div class="control-note">切换仅重启 User Bridge；SYSTEM Agent 不断线。</div></div><div class="control-block"><div class="control-label">RDC 备用通道</div><div class="window-row"><div class="window-state">'+esc(rState)+' · '+esc(rMode)+(r.rdcVersion?' · v'+esc(r.rdcVersion):'')+'</div><div class="seg"><button class="seg-btn '+(r.windowMode==='hidden'?'active':'')+'" data-rdc-action="hide" data-host="'+esc(x.hostname)+'">隐藏</button><button class="seg-btn '+(r.windowMode==='visible'?'active':'')+'" data-rdc-action="show" data-host="'+esc(x.hostname)+'">显示</button></div></div><div class="rdc-actions"><button class="btn-secondary" data-rdc-action="start" data-host="'+esc(x.hostname)+'">启动</button><button class="btn-secondary" data-rdc-action="stop" data-host="'+esc(x.hostname)+'">停止</button><button class="btn-secondary" data-rdc-action="restart" data-host="'+esc(x.hostname)+'">重启</button><button class="btn-secondary" data-rdc-action="'+(r.enabled===false?'enable':'disable')+'" data-host="'+esc(x.hostname)+'">自动启动 '+(r.enabled===false?'开':'关')+'</button></div><div class="control-note">RDC 登录后自动启动，异常退出自动重拉；显示/隐藏会短暂重启 RDC 进程。</div></div><div class="device-meta"><div class="meta-box"><div class="meta-label">最后在线</div><div class="meta-value">'+esc(fmtTime(x.lastSeenAtMs))+'</div></div><div class="meta-box"><div class="meta-label">策略</div><div class="meta-value">'+esc(x.policyRevision??'—')+'</div></div></div><details><summary>设备详情</summary><div class="details-grid"><div class="detail-row"><span>完整版本</span><span class="mono">'+esc(x.agentVersion??'—')+'</span></div><div class="detail-row"><span>设备指纹</span><span class="mono">'+esc(x.fingerprint??'—')+'</span></div></div></details><div class="danger-row"><button class="btn-danger" data-revoke-device="'+esc(x.hostname)+'">撤销设备</button></div></article>'}
function bindDeviceActions(){document.querySelectorAll('[data-window-mode]').forEach(b=>b.onclick=async()=>{const host=b.dataset.host;const mode=b.dataset.windowMode;const peers=[...document.querySelectorAll('[data-window-mode][data-host="'+CSS.escape(host)+'"]')];peers.forEach(x=>x.disabled=true);try{await json(base+'/api/devices/window-mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostname:host,mode})});notify(host+' 已切换为'+(mode==='visible'?'显示':'隐藏'));await refresh()}catch(e){notify(e.message,'bad');peers.forEach(x=>x.disabled=false)}});document.querySelectorAll('[data-rdc-action]').forEach(b=>b.onclick=async()=>{const host=b.dataset.host;const action=b.dataset.rdcAction;b.disabled=true;try{const d=await json(base+'/api/devices/rdc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostname:host,action})});rdcState[host]=d.status;notify(host+' RDC 操作完成');lastRdcRefresh=Date.now();await refresh()}catch(e){notify(e.message,'bad');b.disabled=false}});document.querySelectorAll('[data-revoke-device]').forEach(b=>b.onclick=async()=>{if(confirm('撤销设备 '+b.dataset.revokeDevice+'？设备将断开，需要本地重新批准。')){try{await json(base+'/api/devices/revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostname:b.dataset.revokeDevice})});notify('设备已撤销');await refresh()}catch(e){notify(e.message,'bad')}}})}
let rdcState={};let lastRdcRefresh=0;async function refreshRdc(){try{const d=await json(base+'/api/rdc');rdcState=d.devices||{};lastRdcRefresh=Date.now();await refresh()}catch(e){lastRdcRefresh=Date.now();notify('RDC 状态刷新失败：'+e.message,'bad')}}
async function refresh(){try{const d=await json(base+'/api/status');document.getElementById('gateway').textContent=d.ok?'在线':'异常';document.getElementById('gateway').className='summary-value '+(d.ok?'ok':'bad');document.getElementById('online').textContent=d.devices.filter(x=>x.online).length+'/'+d.devices.length;document.getElementById('inflight').textContent=d.usage.in_flight;document.getElementById('updated').textContent=new Date(d.generatedAt).toLocaleTimeString();document.getElementById('deviceCount').textContent=d.devices.length+' 台已登记';document.getElementById('devices').innerHTML=d.devices.map(deviceCard).join('')||'<div class="section-copy">暂无已登记设备。</div>';bindDeviceActions();if(Date.now()-lastRdcRefresh>15000)void refreshRdc();document.getElementById('calls').innerHTML=d.recentCalls.map(x=>'<tr><td class="mono">'+esc(x.callId)+'</td><td>'+esc(x.hostname)+'</td><td>'+esc(x.toolName)+'</td><td>'+esc(stateLabel(x.status))+'</td><td>'+esc(x.code??'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="section-copy">暂无调用记录。</td></tr>';document.getElementById('release').textContent=esc(d.release);await refreshPairings()}catch(e){document.getElementById('gateway').textContent='不可用';document.getElementById('gateway').className='summary-value bad';notify(e.message,'bad')}}
async function refreshPairings(){try{const d=await json(base+'/api/pairings');document.getElementById('pairings').innerHTML=d.pairings.map(x=>'<tr><td>'+esc(x.hostname)+'</td><td>'+esc(stateLabel(x.status))+'</td><td class="mono">'+esc(x.fingerprint??'—')+'</td><td>'+esc(new Date(x.expiresAtMs).toLocaleTimeString())+'</td><td>'+(x.status==='claimed'?'<button data-approve="'+esc(x.id)+'">批准</button>':'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="section-copy">暂无配对请求。</td></tr>';document.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{await json(base+'/api/pairings/'+encodeURIComponent(b.dataset.approve)+'/approve',{method:'POST'});notify('设备已批准');await refresh()})}catch{}}
document.getElementById('createPair').onclick=async()=>{try{const h=document.getElementById('pairHost').value.trim();const d=await json(base+'/api/pairings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostname:h})});document.getElementById('pairOutput').textContent='配对码（仅显示一次）：'+d.code+'\\n设备：'+d.hostname+'\\n过期时间：'+new Date(d.expiresAtMs).toLocaleString()+'\\n\\n兼容旧流程：在一次性 PowerShell 7 引导中使用此配对码，随后本页会显示设备指纹供批准。';await refreshPairings()}catch(e){document.getElementById('pairOutput').textContent='错误：'+e.message}};
document.getElementById('revokeBinding').onclick=async()=>{const b=await json(base+'/api/binding');if(b.activeBinding&&confirm('撤销当前 GPT 绑定及所有令牌？')){try{await json(base+'/api/binding/revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedBindingId:b.activeBinding.id})});notify('GPT 绑定已撤销');await binding()}catch(e){notify(e.message,'bad')}}};async function binding(){const d=await json(base+'/api/binding');document.getElementById('binding').innerHTML=d.disabled?'<span class="bad">GPT 连接功能未启用</span>':('<div class="kv"><div class="k">所有者</div><div>已配置</div><div class="k">GPT 绑定</div><div>'+(d.activeBinding?'<span class="ok">已连接</span>':'尚未连接')+'</div>'+(d.activeBinding?'<div class="k">绑定标识</div><div class="mono">'+esc(d.activeBinding.id)+'</div>':'')+'</div>')};binding();json(base+'/api/edge-health').then(d=>{document.getElementById('edgeHealth').innerHTML=d.available?'<span class="ok">正常</span>':'<span class="bad">检查失败</span>'}).catch(()=>{document.getElementById('edgeHealth').innerHTML='<span class="bad">检查失败</span>'});
document.getElementById('guide').onclick=async()=>{const d=await json(base+'/api/bootstrap');document.getElementById('boot').textContent=d.flow.map((x,i)=>(i+1)+'. '+x).join('\\n')+'\\n\\n'+Object.values(d.commands).join('\\n')+'\\n\\n'+d.note};refresh();setInterval(refresh,5000);
</script></body></html>`;
}

function safeReturn(value: string | null | undefined, base: string): string {
    if (!value || !(value === base || value.startsWith(base + '/') || value.startsWith('/pair?'))) return base;
    if (/[\\\r\n]/.test(value)) return base;
    return value;
}
function loginHtml(base: string, nonce: string, returnTo: string): string {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Local Control MCP</title><h1>Local Control MCP</h1><h2>本地管理中心</h2><p>仅本地管理员可管理 GPT 绑定和设备。输入恢复材料中的本地管理密钥。</p><form method="post" action="${base}/login"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><input type="hidden" name="return" value="${escapeHtml(returnTo)}"><input type="password" name="secret" required autocomplete="current-password"><button>登录</button></form>`;
}
