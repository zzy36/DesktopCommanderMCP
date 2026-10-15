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
        if (!options.enrollmentStore) return sendHtml(res, 404, '<h1>Device authorization disabled</h1>');
        const code = url.searchParams.get('code') ?? '';
        const authorization = code ? options.enrollmentStore.getDeviceAuthorizationByUserCode(code) : null;
        return sendHtml(res, authorization ? 200 : (code ? 404 : 200), renderDeviceApprovalHtml(code, authorization));
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

function renderDeviceApprovalHtml(code: string, authorization: ReturnType<FleetEnrollmentStore['getDeviceAuthorizationByUserCode']>): string {
    const safeCode = escapeHtml(code);
    if (!code) {
        return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LCM device verification</title></head><body style="font-family:system-ui;max-width:680px;margin:60px auto;padding:0 20px"><h1>Local Control MCP</h1><p>Enter the verification code shown in PowerShell.</p><form method="get" action="/pair"><input name="code" autocomplete="one-time-code" placeholder="ABCD-EFGH" style="font-size:24px;padding:10px"><button style="font-size:18px;padding:12px;margin-left:8px">Continue</button></form></body></html>`;
    }
    if (!authorization) {
        return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LCM device verification</title></head><body style="font-family:system-ui;max-width:680px;margin:60px auto;padding:0 20px"><h1>Code not found</h1><p>The code <b>${safeCode}</b> is invalid or expired.</p></body></html>`;
    }
    const canApprove = authorization.status === 'pending';
    const status = escapeHtml(authorization.status);
    const host = escapeHtml(authorization.hostname);
    const fingerprint = escapeHtml(authorization.fingerprint);
    const policy = escapeHtml(authorization.policyRevision);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LCM device verification</title><style>body{font-family:system-ui;background:#101214;color:#eef2f6;max-width:760px;margin:50px auto;padding:0 20px}.card{background:#181c20;border:1px solid #30363d;border-radius:16px;padding:24px}code{word-break:break-all}button{padding:12px 18px;border:0;border-radius:10px;font-weight:700;font-size:16px;cursor:pointer}.muted{color:#a9b2bd}.ok{color:#66d19e}</style></head><body><h1>Local Control MCP</h1><div class="card"><p class="muted">Verify that the device and code match the PowerShell window.</p><h2>${host}</h2><p>Verification code: <b style="font-size:24px">${safeCode}</b></p><p>Fingerprint: <code>${fingerprint}</code></p><p>Policy: <code>${policy}</code></p><p>Status: <b id="status">${status}</b></p>${canApprove ? '<button id="approve">Approve this device</button>' : ''}<p id="message" class="ok"></p></div><script>${canApprove ? `document.getElementById('approve').onclick=async()=>{const b=document.getElementById('approve');b.disabled=true;const r=await fetch('/pair/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:${JSON.stringify(code)}})});const d=await r.json();if(r.ok){document.getElementById('status').textContent='approved';document.getElementById('message').textContent='Device approved. Return to PowerShell.';b.remove()}else{document.getElementById('message').textContent='ERROR: '+(d.error||r.status);b.disabled=false}};` : ''}</script></body></html>`;
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
            'Run Start-LCMRemote.ps1 (or lcm remote) on the managed Windows device.',
            'The device creates its own Ed25519 identity plus a PKCE challenge, requests a short-lived verification code, and opens the browser.',
            'Verify hostname + fingerprint + code in the browser, then approve the device identity.',
            'PowerShell polls until approval; the private key never leaves the device.',
            'The bootstrap installs the Local MCP plugin plus a SYSTEM AtStartup Fleet Agent task. Project access still comes only from canonical .control.',
            'Validate one allowed project and one denied project. Official Remote MCP remains same-project/same-D0 fallback only.',
        ],
        commands: {
            interactiveRemote: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Start-LCMRemote.ps1"',
            existingApprovedDevice: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Register-LocalControlMcpDevice.ps1" -Json -InstallTask -StartNow',
            validateR0: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Validate-R0DesktopProfile.ps1"',
        },
        note: 'No account database is required. Pairing is device identity admission only; it never grants project permissions or bypasses .control.',
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
<title>Local Control MCP</title><style>
:root{font-family:Inter,system-ui,sans-serif;color-scheme:light dark}body{margin:0;background:#101214;color:#eef2f6}.wrap{max-width:1180px;margin:auto;padding:32px 20px}h1{font-size:30px;margin:0}.sub{color:#a9b2bd;margin:8px 0 28px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.card{background:#181c20;border:1px solid #2a3037;border-radius:14px;padding:18px}.big{font-size:28px;font-weight:700}.ok{color:#66d19e}.bad{color:#ff8f8f}.warn{color:#ffd479}table{width:100%;border-collapse:collapse}.panel{margin-top:18px}.panel h2{font-size:18px}th,td{text-align:left;padding:10px;border-bottom:1px solid #2a3037;font-size:13px}code,pre,input{font-family:ui-monospace,Consolas,monospace}pre{white-space:pre-wrap;background:#0d0f11;padding:14px;border-radius:10px;overflow:auto}button{background:#e8edf2;color:#111;border:0;border-radius:9px;padding:9px 14px;font-weight:650;cursor:pointer}input{background:#0d0f11;color:#eef2f6;border:1px solid #38414b;border-radius:9px;padding:9px 11px;min-width:220px}.muted{color:#8e99a6}.pill{padding:3px 8px;border-radius:999px;background:#283039;display:inline-block;font-size:12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}</style></head>
<body><div class="wrap"><h1>Local Control MCP</h1><div class="sub">Self-hosted device authorization and project-scoped control · no hosted RDC account required</div>
<div class="grid"><div class="card"><div class="muted">Gateway</div><div class="big ok" id="gateway">Checking…</div></div><div class="card"><div class="muted">Devices online</div><div class="big" id="online">—</div></div><div class="card"><div class="muted">Projects</div><div class="big" id="projects">—</div></div><div class="card"><div class="muted">Updated</div><div class="big" style="font-size:16px" id="updated">—</div></div></div>
<div class="panel card"><h2>Devices</h2><table><thead><tr><th>Device</th><th>Status</th><th>Project</th><th>Policy</th><th>Last seen</th></tr></thead><tbody id="devices"></tbody></table></div>
<div class="panel card"><h2>Add device</h2><p class="muted">Create a short-lived pairing code. The device generates its own private key; only the fingerprint is approved here. Project permissions are never granted by pairing.</p><div class="row"><input id="pairHost" placeholder="HOSTNAME"><button id="createPair">Create 10-minute pairing</button></div><pre id="pairOutput">No pairing created.</pre><table><thead><tr><th>Host</th><th>Status</th><th>Fingerprint</th><th>Expires</th><th>Action</th></tr></thead><tbody id="pairings"></tbody></table></div>
<div class="panel card"><h2>Recent calls</h2><table><thead><tr><th>Project</th><th>Device</th><th>Tool</th><th>Status</th><th>Code</th></tr></thead><tbody id="calls"></tbody></table></div>
<div class="panel card"><h2>New device bootstrap</h2><p class="muted">The one-time PowerShell bootstrap installs the local plugin and SYSTEM startup Agent. A registered local .control mirror is still required for project authorization.</p><button id="guide">Load bootstrap guide</button><pre id="boot">Not loaded.</pre></div>
</div><script>
const base=${api}; const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function json(url,opts){const r=await fetch(url,{cache:'no-store',...opts});const d=await r.json();if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
async function refresh(){try{const d=await json(base+'/api/status');document.getElementById('gateway').textContent=d.ok?'Online':'Degraded';document.getElementById('gateway').className='big '+(d.ok?'ok':'bad');document.getElementById('online').textContent=d.devices.filter(x=>x.online).length+'/'+d.devices.length;document.getElementById('projects').textContent=d.projects.length;document.getElementById('updated').textContent=new Date(d.generatedAt).toLocaleTimeString();document.getElementById('devices').innerHTML=d.devices.map(x=>'<tr><td>'+esc(x.hostname)+'</td><td><span class="pill '+(x.online?'ok':'bad')+'">'+(x.online?'online':'offline')+'</span></td><td>'+esc(x.projectId??'unassigned')+'</td><td>'+esc(x.policyRevision??'—')+'</td><td>'+esc(x.lastSeenAtMs?new Date(x.lastSeenAtMs).toLocaleString():'—')+'</td></tr>').join('');document.getElementById('calls').innerHTML=d.recentCalls.map(x=>'<tr><td>'+esc(x.projectId)+'</td><td>'+esc(x.hostname)+'</td><td>'+esc(x.toolName)+'</td><td>'+esc(x.status)+'</td><td>'+esc(x.code??'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">No calls recorded.</td></tr>';await refreshPairings()}catch(e){document.getElementById('gateway').textContent='Unavailable';document.getElementById('gateway').className='big bad'}}
async function refreshPairings(){try{const d=await json(base+'/api/pairings');document.getElementById('pairings').innerHTML=d.pairings.map(x=>'<tr><td>'+esc(x.hostname)+'</td><td>'+esc(x.status)+'</td><td>'+esc(x.fingerprint??'—')+'</td><td>'+esc(new Date(x.expiresAtMs).toLocaleTimeString())+'</td><td>'+(x.status==='claimed'?'<button data-approve="'+esc(x.id)+'">Approve</button>':'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">No pairings.</td></tr>';document.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{await json(base+'/api/pairings/'+encodeURIComponent(b.dataset.approve)+'/approve',{method:'POST'});await refresh()})}catch{}}
document.getElementById('createPair').onclick=async()=>{try{const h=document.getElementById('pairHost').value.trim();const d=await json(base+'/api/pairings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostname:h})});document.getElementById('pairOutput').textContent='Pair code (shown once): '+d.code+'\nHost: '+d.hostname+'\nExpires: '+new Date(d.expiresAtMs).toLocaleString()+'\n\nRun the one-time PowerShell 7 bootstrap with this code; this page will then show the claimed fingerprint for approval.';await refreshPairings()}catch(e){document.getElementById('pairOutput').textContent='ERROR: '+e.message}};
document.getElementById('guide').onclick=async()=>{const d=await json(base+'/api/bootstrap');document.getElementById('boot').textContent=d.flow.map((x,i)=>(i+1)+'. '+x).join('\n')+'\n\n'+Object.values(d.commands).join('\n')+'\n\n'+d.note};refresh();setInterval(refresh,5000);
</script></body></html>`;
}
