[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ExpectedHostname,
 [ValidatePattern('^[0-9a-f]{40}$')][string]$Release,
 [uri]$AdminUrl='https://172.16.1.253:24443/admin',
 [ValidateSet('hidden','visible')][string]$BridgeWindowMode='hidden',
 [switch]$ValidateOnly,[switch]$NoBrowser
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:COMPUTERNAME -ne $ExpectedHostname){throw 'Exact hostname mismatch'}
$manifestFile=Join-Path $PSScriptRoot 'kit.json'
if(Test-Path -LiteralPath $manifestFile){
 $manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json
 if(-not $Release){$Release=$manifest.runtime_commit}
 if($Release -ne $manifest.runtime_commit){throw 'Installer release differs from the pinned kit'}
 foreach($file in $manifest.files.PSObject.Properties){
  if($file.Name -notmatch '^[a-zA-Z0-9.-]+$'){throw 'Unsafe kit filename'}
  if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.Value){throw 'Installer kit hash mismatch'}
 }
}
if(-not $Release -or $Release -notmatch '^[0-9a-f]{40}$'){throw 'A pinned release or kit.json is required'}
foreach($name in @('Install-LCMAgent.ps1','Repair-LCMBundledDependency.ps1','network-fleet-ca.crt')){if(-not(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name))){throw "Installer kit missing $name"}}
if($AdminUrl.AbsoluteUri -ne 'https://172.16.1.253:24443/admin'){throw 'Use the registered private Owner gateway'}
if($ValidateOnly){[ordered]@{status='VALIDATED';hostname=$ExpectedHostname;release=$Release;entrypoint='Start-LCMRemote.ps1';changesMade=$false}|ConvertTo-Json -Compress;exit}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this installer as administrator in the intended logged-in user session'}
foreach($task in @(('NetworkFleetAgent-'+$ExpectedHostname),('LCMInteractiveUser-'+$ExpectedHostname))){if(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue){throw 'LCM is already installed; use gateway maintenance rather than enrollment'}}
$installer=Join-Path $PSScriptRoot 'Install-LCMAgent.ps1'
& $installer -Release $Release -ExpectedHostname $ExpectedHostname -BridgeWindowMode $BridgeWindowMode -ProvisionOnly
$runtime=Join-Path $env:ProgramData ('LocalControlMCP/releases/'+$Release)
$config=Join-Path $env:ProgramData 'NetworkFleet/agent.json'
$node=(Get-Command node -ErrorAction Stop).Source
$env:NODE_EXTRA_CA_CERTS=Join-Path $env:ProgramData 'NetworkFleet/ca.crt'
$info=(& $node (Join-Path $runtime 'dist/remote-device/fleet/agent-main.js') --config $config --print-provisioning)|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or $info.hostname -ne $ExpectedHostname){throw 'Independent device identity was not provisioned'}
$authArgs=@((Join-Path $runtime 'dist/remote-device/fleet/device-auth-client.js'),'--admin-url',$AdminUrl.AbsoluteUri,'--hostname',$ExpectedHostname,'--fingerprint',$info.publicKeyFingerprint,'--policy-revision',$info.policyRevision)
if($NoBrowser){$authArgs+='--no-open'}
& $node @authArgs
if($LASTEXITCODE -ne 0){throw 'Owner device enrollment was not approved; tasks were not installed'}
& $installer -Release $Release -ExpectedHostname $ExpectedHostname -BridgeWindowMode $BridgeWindowMode -InstallTask -StartNow
