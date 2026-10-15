import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { FleetGateway, FleetGatewayCallRecord } from './fleet-gateway.js';
import { FleetEnrollmentStore } from './enrollment-store.js';
import type { DeviceBinding } from './protocol.js';

export interface FleetAdminServerOptions {
    basePath?: string;
    projects: Array<{ projectId: string; hostname: string; policyRevision: string }>;
    enrollmentStore?: FleetEnrollmentStore;
    onApproveDevice?: (device: DeviceBinding) => void | Promise<void>;
}

export function createFleetAdminHttpServer(
    gateway: FleetGateway,
    options: FleetAdminServerOptions,
): Server {
    const basePath = normalizeBasePath(options.basePath ?? '/admin');
    return createServer((req, res) => {
        void handleRequest(req, res, gateway, options, basePath).catch((error) => {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
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
    if (req.method === 'GET' && url.pathname === `${basePath}/api/status`) {
        return sendJson(res, 200, buildStatus(gateway, options));
    }
    if (req.method === 'GET' && url.pathname === `${basePath}/api/calls`) {
        const requested = Number(url.searchParams.get('limit') ?? '20');
        const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.trunc(requested))) : 20;
        return sendJson(res, 200, { calls: redactCalls(gateway.listCallRecords(limit)) });
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
        const origin = externalOrigin(req);
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
        return sendHtml(res, authorization ? 200 : (code ? 404 : 200), renderDeviceApprovalHtml(code, authorization, prefersChinese(req)));
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
        return sendHtml(res, 200, renderAdminHtml(basePath));
    }
    return sendJson(res, 404, { error: 'not found' });
}

function externalOrigin(req: IncomingMessage): string {
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    const proto = forwardedProto || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
    const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
    const host = forwardedHost || String(req.headers.host ?? 'fleet-mcp.home.arpa:24443');
    return `${proto}://${host}`;
}

function prefersChinese(req: IncomingMessage): boolean {
    const value = String(req.headers['accept-language'] ?? '').toLowerCase();
    return !value || value.includes('zh');
}

function renderDeviceApprovalHtml(code: string, authorization: ReturnType<FleetEnrollmentStore['getDeviceAuthorizationByUserCode']>, zh: boolean): string {
    const safeCode = escapeHtml(code);
    const title = zh ? 'LCM 设备验证' : 'LCM device verification';
    if (!code) {
        const prompt = zh ? '请输入 PowerShell 中显示的验证码。' : 'Enter the verification code shown in PowerShell.';
        const button = zh ? '继续' : 'Continue';
        return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui;max-width:680px;margin:60px auto;padding:0 20px"><h1>Local Control MCP（LCM）</h1><p>${prompt}</p><form method="get" action="/pair"><input name="code" autocomplete="one-time-code" placeholder="ABCD-EFGH" style="font-size:24px;padding:10px"><button style="font-size:18px;padding:12px;margin-left:8px">${button}</button></form></body></html>`;
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
    const policyLabel = zh ? '策略版本' : 'Policy';
    const statusLabel = zh ? '状态' : 'Status';
    const approveText = zh ? '批准此设备' : 'Approve this device';
    const okText = zh ? '设备已批准。请返回 PowerShell。' : 'Device approved. Return to PowerShell.';
    const errorPrefix = zh ? '错误：' : 'ERROR: ';
    const approvedStatus = zh ? '已批准' : 'approved';
    return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;background:#101214;color:#eef2f6;max-width:760px;margin:50px auto;padding:0 20px}.card{background:#181c20;border:1px solid #30363d;border-radius:16px;padding:24px}code{word-break:break-all}button{padding:12px 18px;border:0;border-radius:10px;font-weight:700;font-size:16px;cursor:pointer}.muted{color:#a9b2bd}.ok{color:#66d19e}</style></head><body><h1>Local Control MCP（LCM）</h1><div class="card"><p class="muted">${intro}</p><h2>${host}</h2><p>${codeLabel}：<b style="font-size:24px">${safeCode}</b></p><p>${fingerprintLabel}：<code>${fingerprint}</code></p><p>${policyLabel}：<code>${policy}</code></p><p>${statusLabel}：<b id="status">${status}</b></p>${canApprove ? `<button id="approve">${approveText}</button>` : ''}<p id="message" class="ok"></p></div><script>${canApprove ? `document.getElementById('approve').onclick=async()=>{const b=document.getElementById('approve');b.disabled=true;const r=await fetch('/pair/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:${JSON.stringify(code)}})});const d=await r.json();if(r.ok){document.getElementById('status').textContent=${JSON.stringify(approvedStatus)};document.getElementById('message').textContent=${JSON.stringify(okText)};b.remove()}else{document.getElementById('message').textContent=${JSON.stringify(errorPrefix)}+(d.error||r.status);b.disabled=false}};` : ''}</script></body></html>`;
}

function escapeHtml(value: string): string {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
function buildStatus(gateway: FleetGateway, options: FleetAdminServerOptions) {
    const projectsByHost = new Map<string, string>();
    for (const project of options.projects) {
        if (!projectsByHost.has(project.hostname)) projectsByHost.set(project.hostname, project.projectId);
    }
    const devices = gateway.listKnownDeviceStatuses().map((status) => ({
        ...status,
        fingerprint: status.publicKeyFingerprint,
        projectId: projectsByHost.get(status.hostname) ?? null,
    }));
    return {
        ok: true,
        service: 'network-fleet-admin',
        generatedAt: new Date().toISOString(),
        devices,
        projects: options.projects.map((project) => ({ ...project })),
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
            '引导流程会安装 Local MCP 插件和 SYSTEM AtStartup Fleet Agent；项目权限仍只来自 canonical .control。',
            '最后验证一个允许项目和一个拒绝项目；官方 Remote MCP 仍只作为同项目、同 D0 的故障备用通道。',
        ],
        commands: {
            interactiveRemote: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Start-LCMRemote.ps1"',
            existingApprovedDevice: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Register-LocalControlMcpDevice.ps1" -Json -InstallTask -StartNow',
            validateR0: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Validate-R0DesktopProfile.ps1"',
        },
        note: '不需要账号数据库。设备验证只负责设备身份准入，不会授予项目权限，也不会绕过 .control。',
    };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > 64 * 1024) throw new Error('request body too large');
        chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

function renderAdminHtml(basePath: string): string {
    const api = JSON.stringify(basePath);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local Control MCP（LCM）</title><style>
:root{font-family:Inter,system-ui,sans-serif;color-scheme:light dark}body{margin:0;background:#101214;color:#eef2f6}.wrap{max-width:1180px;margin:auto;padding:32px 20px}h1{font-size:30px;margin:0}.sub{color:#a9b2bd;margin:8px 0 28px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.card{background:#181c20;border:1px solid #2a3037;border-radius:14px;padding:18px}.big{font-size:28px;font-weight:700}.ok{color:#66d19e}.bad{color:#ff8f8f}.warn{color:#ffd479}table{width:100%;border-collapse:collapse}.panel{margin-top:18px}.panel h2{font-size:18px}th,td{text-align:left;padding:10px;border-bottom:1px solid #2a3037;font-size:13px}code,pre,input{font-family:ui-monospace,Consolas,monospace}pre{white-space:pre-wrap;background:#0d0f11;padding:14px;border-radius:10px;overflow:auto}button{background:#e8edf2;color:#111;border:0;border-radius:9px;padding:9px 14px;font-weight:650;cursor:pointer}input{background:#0d0f11;color:#eef2f6;border:1px solid #38414b;border-radius:9px;padding:9px 11px;min-width:220px}.muted{color:#8e99a6}.pill{padding:3px 8px;border-radius:999px;background:#283039;display:inline-block;font-size:12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}</style></head>
<body><div class="wrap"><h1>Local Control MCP（LCM）</h1><div class="sub">自托管设备验证与项目隔离控制 · 不依赖官方 RDC 托管账号</div>
<div class="grid"><div class="card"><div class="muted">网关</div><div class="big ok" id="gateway">检查中…</div></div><div class="card"><div class="muted">在线设备</div><div class="big" id="online">—</div></div><div class="card"><div class="muted">项目</div><div class="big" id="projects">—</div></div><div class="card"><div class="muted">更新时间</div><div class="big" style="font-size:16px" id="updated">—</div></div></div>
<div class="panel card"><h2>设备</h2><table><thead><tr><th>设备</th><th>状态</th><th>项目</th><th>策略</th><th>最后在线</th></tr></thead><tbody id="devices"></tbody></table></div>
<div class="panel card"><h2>添加设备</h2><p class="muted">仅用于兼容旧手工配对流程。推荐新设备直接运行 <code>lcm remote</code>，通过浏览器短码完成验证。设备私钥始终保留在本机，配对不会授予任何项目权限。</p><div class="row"><input id="pairHost" placeholder="设备名"><button id="createPair">创建 10 分钟配对码</button></div><pre id="pairOutput">尚未创建配对码。</pre><table><thead><tr><th>设备</th><th>状态</th><th>指纹</th><th>过期时间</th><th>操作</th></tr></thead><tbody id="pairings"></tbody></table></div>
<div class="panel card"><h2>最近调用</h2><table><thead><tr><th>项目</th><th>设备</th><th>工具</th><th>状态</th><th>代码</th></tr></thead><tbody id="calls"></tbody></table></div>
<div class="panel card"><h2>新设备引导</h2><p class="muted">首次引导会安装本地插件和 SYSTEM 启动 Agent。项目授权仍必须来自该设备注册过的本地 <code>.control</code>。</p><button id="guide">加载引导说明</button><pre id="boot">尚未加载。</pre></div>
</div><script>
const base=${api}; const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function json(url,opts){const r=await fetch(url,{cache:'no-store',...opts});const d=await r.json();if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
async function refresh(){try{const d=await json(base+'/api/status');document.getElementById('gateway').textContent=d.ok?'在线':'异常';document.getElementById('gateway').className='big '+(d.ok?'ok':'bad');document.getElementById('online').textContent=d.devices.filter(x=>x.online).length+'/'+d.devices.length;document.getElementById('projects').textContent=d.projects.length;document.getElementById('updated').textContent=new Date(d.generatedAt).toLocaleTimeString();document.getElementById('devices').innerHTML=d.devices.map(x=>'<tr><td>'+esc(x.hostname)+'</td><td><span class="pill '+(x.online?'ok':'bad')+'">'+(x.online?'在线':'离线')+'</span></td><td>'+esc(x.projectId??'未分配')+'</td><td>'+esc(x.policyRevision??'—')+'</td><td>'+esc(x.lastSeenAtMs?new Date(x.lastSeenAtMs).toLocaleString():'—')+'</td></tr>').join('');document.getElementById('calls').innerHTML=d.recentCalls.map(x=>'<tr><td>'+esc(x.projectId)+'</td><td>'+esc(x.hostname)+'</td><td>'+esc(x.toolName)+'</td><td>'+esc(x.status)+'</td><td>'+esc(x.code??'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">No calls recorded.</td></tr>';await refreshPairings()}catch(e){document.getElementById('gateway').textContent='不可用';document.getElementById('gateway').className='big bad'}}
async function refreshPairings(){try{const d=await json(base+'/api/pairings');document.getElementById('pairings').innerHTML=d.pairings.map(x=>'<tr><td>'+esc(x.hostname)+'</td><td>'+esc(x.status)+'</td><td>'+esc(x.fingerprint??'—')+'</td><td>'+esc(new Date(x.expiresAtMs).toLocaleTimeString())+'</td><td>'+(x.status==='claimed'?'<button data-approve="'+esc(x.id)+'">批准</button>':'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">No pairings.</td></tr>';document.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{await json(base+'/api/pairings/'+encodeURIComponent(b.dataset.approve)+'/approve',{method:'POST'});await refresh()})}catch{}}
document.getElementById('createPair').onclick=async()=>{try{const h=document.getElementById('pairHost').value.trim();const d=await json(base+'/api/pairings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostname:h})});document.getElementById('pairOutput').textContent='配对码（仅显示一次）：'+d.code+'\n设备：'+d.hostname+'\n过期时间：'+new Date(d.expiresAtMs).toLocaleString()+'\n\n兼容旧流程：在一次性 PowerShell 7 引导中使用此配对码，随后本页会显示设备指纹供批准。';await refreshPairings()}catch(e){document.getElementById('pairOutput').textContent='错误：'+e.message}};
document.getElementById('guide').onclick=async()=>{const d=await json(base+'/api/bootstrap');document.getElementById('boot').textContent=d.flow.map((x,i)=>(i+1)+'. '+x).join('\n')+'\n\n'+Object.values(d.commands).join('\n')+'\n\n'+d.note};refresh();setInterval(refresh,5000);
</script></body></html>`;
}
