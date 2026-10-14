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
            'Create a short-lived pairing code in this LAN/VPN-only Web Admin.',
            'On the new managed Windows device, run the PowerShell 7 bootstrap command once.',
            'The device creates its own Ed25519 identity and claims the pairing code; the private key never leaves the device.',
            'Review hostname + fingerprint here, then approve the device identity.',
            'The bootstrap installs the Local MCP plugin plus a SYSTEM AtStartup Fleet Agent task. Project access still comes only from canonical .control.',
            'Validate one allowed project and one denied project. Official Remote MCP remains same-project/same-D0 fallback only.',
        ],
        commands: {
            pairingBootstrap: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Register-LocalRemoteMcpDevice.ps1" -PairingCode "<PAIR_CODE>" -Json -InstallTask -StartNow',
            existingApprovedDevice: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Register-LocalRemoteMcpDevice.ps1" -Json -InstallTask -StartNow',
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
<title>Local Remote MCP</title><style>
:root{font-family:Inter,system-ui,sans-serif;color-scheme:light dark}body{margin:0;background:#101214;color:#eef2f6}.wrap{max-width:1180px;margin:auto;padding:32px 20px}h1{font-size:30px;margin:0}.sub{color:#a9b2bd;margin:8px 0 28px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.card{background:#181c20;border:1px solid #2a3037;border-radius:14px;padding:18px}.big{font-size:28px;font-weight:700}.ok{color:#66d19e}.bad{color:#ff8f8f}.warn{color:#ffd479}table{width:100%;border-collapse:collapse}.panel{margin-top:18px}.panel h2{font-size:18px}th,td{text-align:left;padding:10px;border-bottom:1px solid #2a3037;font-size:13px}code,pre,input{font-family:ui-monospace,Consolas,monospace}pre{white-space:pre-wrap;background:#0d0f11;padding:14px;border-radius:10px;overflow:auto}button{background:#e8edf2;color:#111;border:0;border-radius:9px;padding:9px 14px;font-weight:650;cursor:pointer}input{background:#0d0f11;color:#eef2f6;border:1px solid #38414b;border-radius:9px;padding:9px 11px;min-width:220px}.muted{color:#8e99a6}.pill{padding:3px 8px;border-radius:999px;background:#283039;display:inline-block;font-size:12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}</style></head>
<body><div class="wrap"><h1>Local Remote MCP</h1><div class="sub">Trusted-home-LAN single-tenant control plane · no account database · execution remains behind MCP + .control</div>
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
