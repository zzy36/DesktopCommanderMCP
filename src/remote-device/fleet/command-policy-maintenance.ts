import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {FleetGateway} from './fleet-gateway.js';

/** Native gateway administration deploys a pinned product package, not arbitrary commands. */
export function commandPolicyMaintenance(gateway: FleetGateway, packagePath: string, release: string) {
    return async (hostname: string) => {
        const status = gateway.machineDeviceStatus(hostname);
        if (!status.online) throw Object.assign(new Error('Exact device offline'), {code:'TARGET_OFFLINE'});
        const data = JSON.parse(await readFile(packagePath, 'utf8'));
        if (!/^[a-f0-9]{40}$/.test(release) || data.release !== release || data.policy !== 'caller-authorized') throw new Error('Pinned maintenance package mismatch');
        if (!/^[A-Za-z0-9-]+$/.test(hostname)) throw new Error('Invalid enrolled hostname');
        if (createHash('sha256').update(data.installer).digest('hex') !== data.installerSha256) throw new Error('Installer integrity mismatch');
        const root = 'C:/ProgramData/LocalControlMCP/updates';
        const manifest = `${root}/policy-${release}.json`;
        const installer = `${root}/policy-${release}.ps1`;
        const call = async (tool: string, args: Record<string,unknown>) => {
            const result = await gateway.dispatchDevice(hostname,tool,{...args,execution_context:'system'},60000) as any;
            if (result?.isError) throw Object.assign(new Error('Device maintenance rejected; no automatic retry'),{code:'MAINTENANCE_REJECTED'});
            return result;
        };
        await call('create_directory',{path:root});
        await call('write_file',{path:manifest,content:JSON.stringify({schemaVersion:1,policy:data.policy,release:data.release,files:data.files})});
        await call('write_file',{path:installer,content:data.installer});
        // A separate scheduled task survives the Agent/Bridge restart. Defer
        // activation until after this tool response; never retry uncertain writes.
        const task = `LCMPolicyUpdate-${hostname}-${release.slice(0,12)}`;
        const command = `$ErrorActionPreference='Stop'; if(Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue){throw 'Update already scheduled; inspect state'}; $exe=(Get-Command pwsh -ErrorAction Stop).Source; $a=New-ScheduledTaskAction -Execute $exe -Argument '-NoProfile -File ${installer} -PackagePath ${manifest} -ExpectedHostname ${hostname}'; $p=New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest; $t=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10); Register-ScheduledTask -TaskName '${task}' -Action $a -Principal $p -Trigger $t | Out-Null; Write-Output 'LCM_POLICY_UPDATE_SCHEDULED'`;
        const result=await call('start_process',{command,shell:'powershell.exe',timeout_ms:3000});
        return {status:'scheduled',hostname,release,task,acceptance:'Read Agent version and fixed diagnostics after reconnect; do not resubmit',result};
    };
}
