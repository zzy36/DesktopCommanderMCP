import { createServer, Server, ServerResponse } from 'node:http';
import { FleetGateway, FleetGatewayCallRecord, FleetGatewayDeviceStatus } from './fleet-gateway.js';

export interface FleetAdminServerOptions {
    basePath?: string;
    devices: Array<{ hostname: string; publicKeyFingerprint: string }>;
    projects: Array<{ projectId: string; hostname: string; policyRevision: string }>;
}

export function createFleetAdminHttpServer(
    gateway: FleetGateway,
    options: FleetAdminServerOptions,
): Server {
    const basePath = normalizeBasePath(options.basePath ?? '/admin');
    return createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        if (url.pathname === `${basePath}/healthz`) {
            return sendJson(res, 200, { ok: true, service: 'network-fleet-admin' });
        }
        if (url.pathname === `${basePath}/api/status`) {
            return sendJson(res, 200, buildStatus(gateway, options));
        }
        if (url.pathname === `${basePath}/api/calls`) {
            const requested = Number(url.searchParams.get('limit') ?? '20');
            const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.trunc(requested))) : 20;
            return sendJson(res, 200, { calls: redactCalls(gateway.listCallRecords(limit)) });
        }
        if (url.pathname === `${basePath}/api/bootstrap`) {
            return sendJson(res, 200, bootstrapGuide());
        }
        if (url.pathname === basePath || url.pathname === `${basePath}/`) {
            return sendHtml(res, 200, renderAdminHtml(basePath));
        }
        return sendJson(res, 404, { error: 'not found' });
    });
}

function buildStatus(gateway: FleetGateway, options: FleetAdminServerOptions) {
    const projectsByHost = new Map<string, string>();
    for (const project of options.projects) {
        if (!projectsByHost.has(project.hostname)) projectsByHost.set(project.hostname, project.projectId);
    }
    const devices = options.devices.map((device) => {
        const projectId = projectsByHost.get(device.hostname) ?? null;
        let status: FleetGatewayDeviceStatus | null = null;
        if (projectId) {
            try { status = gateway.deviceStatus(projectId, device.hostname); } catch { status = null; }
        }
        return {
            hostname: device.hostname,
            fingerprint: device.publicKeyFingerprint,
            projectId,
            online: status?.online ?? false,
            generation: status?.generation ?? null,
            policyRevision: status?.policyRevision ?? null,
            connectedAtMs: status?.connectedAtMs ?? null,
            lastSeenAtMs: status?.lastSeenAtMs ?? null,
        };
    });
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
            'Register the new D0 device and allowed partitions/projects in canonical .control on YUAN.',
            'On the new Windows device, sync a clean .control mirror and run Register-MachineControl.ps1.',
            'Run Register-LocalRemoteMcp.ps1 to install the shared Local Remote MCP runtime/plugin.',
            'Provision the Fleet Agent identity/config, then approve its hostname + public-key fingerprint in the Gateway before starting the persistent Agent.',
            'Validate R0 and verify Local Remote MCP first; Official Remote MCP remains available as same-project/same-D0 fallback.',
        ],
        commands: {
            localPlugin: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Register-LocalRemoteMcp.ps1" -Json',
            validateR0: 'pwsh -NoProfile -File "<CONTROL_ROOT>\\tools\\Validate-R0DesktopProfile.ps1"',
        },
        note: 'The Web Admin is intentionally non-executing. It never exposes file/shell control and cannot bypass .control.',
    };
}

function normalizeBasePath(value: string): string {
    let result = value.trim();
    if (!result.startsWith('/')) result = `/${result}`;
    result = result.replace(/\/+$/, '');
    if (!result || result === '/') throw new Error('admin basePath must be a non-root path');
    return result;
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
:root{font-family:Inter,system-ui,sans-serif;color-scheme:light dark}body{margin:0;background:#101214;color:#eef2f6}.wrap{max-width:1180px;margin:auto;padding:32px 20px}h1{font-size:30px;margin:0}.sub{color:#a9b2bd;margin:8px 0 28px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.card{background:#181c20;border:1px solid #2a3037;border-radius:14px;padding:18px}.big{font-size:28px;font-weight:700}.ok{color:#66d19e}.bad{color:#ff8f8f}table{width:100%;border-collapse:collapse}.panel{margin-top:18px}.panel h2{font-size:18px}th,td{text-align:left;padding:10px;border-bottom:1px solid #2a3037;font-size:13px}code,pre{font-family:ui-monospace,Consolas,monospace}pre{white-space:pre-wrap;background:#0d0f11;padding:14px;border-radius:10px;overflow:auto}button{background:#e8edf2;color:#111;border:0;border-radius:9px;padding:9px 14px;font-weight:650;cursor:pointer}.muted{color:#8e99a6}.pill{padding:3px 8px;border-radius:999px;background:#283039;display:inline-block;font-size:12px}</style></head>
<body><div class="wrap"><h1>Local Remote MCP</h1><div class="sub">LAN administration & diagnostics · execution remains behind MCP + .control</div>
<div class="grid"><div class="card"><div class="muted">Gateway</div><div class="big ok" id="gateway">Checking…</div></div><div class="card"><div class="muted">Devices online</div><div class="big" id="online">—</div></div><div class="card"><div class="muted">Projects</div><div class="big" id="projects">—</div></div><div class="card"><div class="muted">Updated</div><div class="big" style="font-size:16px" id="updated">—</div></div></div>
<div class="panel card"><h2>Devices</h2><table><thead><tr><th>Device</th><th>Status</th><th>Project</th><th>Policy</th><th>Last seen</th></tr></thead><tbody id="devices"></tbody></table></div>
<div class="panel card"><h2>Recent calls</h2><table><thead><tr><th>Project</th><th>Device</th><th>Tool</th><th>Status</th><th>Code</th></tr></thead><tbody id="calls"></tbody></table></div>
<div class="panel card"><h2>New device bootstrap</h2><p class="muted">D0/project registration stays authoritative in canonical .control on YUAN. This page does not bypass that boundary.</p><button id="guide">Load bootstrap guide</button><pre id="boot">Not loaded.</pre></div>
</div><script>
const base=${api}; const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function refresh(){try{const r=await fetch(base+'/api/status',{cache:'no-store'});const d=await r.json();document.getElementById('gateway').textContent=d.ok?'Online':'Degraded';document.getElementById('gateway').className='big '+(d.ok?'ok':'bad');document.getElementById('online').textContent=d.devices.filter(x=>x.online).length+'/'+d.devices.length;document.getElementById('projects').textContent=d.projects.length;document.getElementById('updated').textContent=new Date(d.generatedAt).toLocaleTimeString();document.getElementById('devices').innerHTML=d.devices.map(x=>'<tr><td>'+esc(x.hostname)+'</td><td><span class="pill '+(x.online?'ok':'bad')+'">'+(x.online?'online':'offline')+'</span></td><td>'+esc(x.projectId??'—')+'</td><td>'+esc(x.policyRevision??'—')+'</td><td>'+esc(x.lastSeenAtMs?new Date(x.lastSeenAtMs).toLocaleString():'—')+'</td></tr>').join('');document.getElementById('calls').innerHTML=d.recentCalls.map(x=>'<tr><td>'+esc(x.projectId)+'</td><td>'+esc(x.hostname)+'</td><td>'+esc(x.toolName)+'</td><td>'+esc(x.status)+'</td><td>'+esc(x.code??'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">No calls recorded.</td></tr>';}catch(e){document.getElementById('gateway').textContent='Unavailable';document.getElementById('gateway').className='big bad';}}
document.getElementById('guide').onclick=async()=>{const r=await fetch(base+'/api/bootstrap',{cache:'no-store'});const d=await r.json();document.getElementById('boot').textContent=d.flow.map((x,i)=>(i+1)+'. '+x).join('\n')+'\n\n'+Object.values(d.commands).join('\n')+'\n\n'+d.note};refresh();setInterval(refresh,5000);
</script></body></html>`;
}
