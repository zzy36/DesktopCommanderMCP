import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractRdcStatus, rdcControlCommand } from '../dist/remote-device/fleet/gateway-service.js';

const installer = await readFile(new URL('../deploy/windows/Install-RDCAutostart.ps1', import.meta.url), 'utf8');
const controller = await readFile(new URL('../deploy/windows/Control-RDC.ps1', import.meta.url), 'utf8');

// Windows packaging contract: exact-host, pinned RDC, logged-in-user task, restart policy.
assert.match(installer, /Exact hostname mismatch/);
assert.match(installer, /RdcVersion='0\.3\.0'/);
assert.match(installer, /@wonderwhy-er\/desktop-commander@/);
assert.match(installer, /remote 2>&1/);
assert.match(installer, /DesktopCommanderRemote-/);
assert.match(installer, /New-ScheduledTaskTrigger -AtLogOn -User \$user/);
assert.match(installer, /New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited/);
assert.match(installer, /RestartCount 999/);
assert.match(installer, /RestartInterval \(New-TimeSpan -Minutes 1\)/);
assert.match(installer, /MultipleInstances IgnoreNew/);
assert.match(installer, /LocalControlMCP-RDC/);
assert.match(installer, /Control-RDC\.ps1/);
assert.match(installer, /WindowMode -eq 'hidden'/);

// Runtime control contract: all requested operations stay exact-host and return JSON status.
assert.match(controller, /ValidateSet\('status','start','stop','restart','show','hide','enable','disable'\)/);
assert.match(controller, /Exact hostname mismatch/);
assert.match(controller, /DesktopCommanderRemote-/);
assert.match(controller, /Enable-ScheduledTask/);
assert.match(controller, /Disable-ScheduledTask/);
assert.match(controller, /Start-ScheduledTask/);
assert.match(controller, /Stop-ScheduledTask/);
assert.match(controller, /Set-ScheduledTask/);
assert.match(controller, /WindowStyle\\s\+Hidden/);
assert.match(controller, /ConvertTo-Json -Depth 4 -Compress/);

const command = rdcControlCommand('restart');
assert.match(command, /LocalControlMCP-RDC\\Control-RDC\.ps1/);
assert.match(command, /-ExpectedHostname \$env:COMPUTERNAME/);
assert.match(command, /-Action restart/);

// Gateway parser must tolerate wrapped tool output and select the newest exact-host JSON payload.
const oldStatus = JSON.stringify({ hostname: 'YUANS', state: 'Ready', enabled: true, windowMode: 'hidden', rdcVersion: '0.3.0' });
const newStatus = JSON.stringify({ hostname: 'YUANS', state: 'Running', enabled: true, autostart: true, windowMode: 'visible', rdcVersion: '0.3.0', processCount: 3, pids: [11, 22, 33] });
const wrapped = {
  result: {
    content: [{ type: 'text', text: `Process started\n${oldStatus}\nnoise\n${newStatus}\n✅ Process completed` }],
  },
};
const parsed = extractRdcStatus(wrapped, 'yuans');
assert.equal(parsed.hostname, 'YUANS');
assert.equal(parsed.state, 'Running');
assert.equal(parsed.windowMode, 'visible');
assert.equal(parsed.processCount, 3);
assert.deepEqual(parsed.pids, [11, 22, 33]);

assert.throws(
  () => extractRdcStatus({ text: '{"hostname":"OTHER","state":"Running"}' }, 'YUANS'),
  /RDC status payload missing for YUANS/,
);

console.log('RDC supervisor packaging + status parser PASS');
