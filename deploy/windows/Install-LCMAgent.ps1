[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Release,
 [Parameter(Mandatory)][string]$ExpectedHostname,
 [string]$GatewayUrl='wss://172.16.1.253:24443/agent',
 [string]$CaBundle=(Join-Path $PSScriptRoot 'network-fleet-ca.crt'),
 [switch]$StageOnly,[switch]$ProvisionOnly,[switch]$InstallTask,[switch]$StartNow
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $env:COMPUTERNAME.Equals($ExpectedHostname,[StringComparison]::OrdinalIgnoreCase)){throw 'Exact hostname mismatch'}
$root=Join-Path $env:ProgramData 'LocalControlMCP'
$network=Join-Path $env:ProgramData 'NetworkFleet'
$bridge=Join-Path $env:ProgramData 'LocalControlMCP-UserBridge'
$runtime=Join-Path $root ('releases\'+$Release)
$node=(Get-Command node -ErrorAction Stop).Source
$pwsh=(Get-Command pwsh -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $root,(Join-Path $root 'releases')|Out-Null
if(-not(Test-Path -LiteralPath $runtime)){
 $stage=Join-Path $root ('.stage-device-'+[guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $stage|Out-Null
 $archive=Join-Path $stage 'source.zip'
 & curl.exe -fL --silent --show-error --retry 3 --connect-timeout 10 --max-time 600 -o $archive ('https://codeload.github.com/zzy36/DesktopCommanderMCP/zip/'+$Release)
 if($LASTEXITCODE -ne 0){throw 'Pinned source download failed; staging retained'}
 Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $stage 'source')
 $source=@(Get-ChildItem (Join-Path $stage 'source') -Directory)
 if($source.Count -ne 1){throw 'Unexpected source archive'}
 Push-Location $source[0].FullName
 try{
  & npm.cmd ci --include=dev --ignore-scripts --no-audit --no-fund | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Pinned dependency installation failed'}
  & npm.cmd run build | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Runtime build failed'}
  # npm ci deliberately skips lifecycle scripts; restore only the required,
  # pinned Microsoft ripgrep dependency hook, without root telemetry/install hooks.
  & $node node_modules/@vscode/ripgrep/lib/postinstall.js | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Pinned search dependency installation failed'}
  & $node dist/npm-scripts/verify-ripgrep.js | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Search runtime verification failed'}
  [IO.File]::WriteAllText((Join-Path $source[0].FullName 'LCM_RELEASE'),$Release,[Text.UTF8Encoding]::new($false))
 }finally{Pop-Location}
 Move-Item -LiteralPath $source[0].FullName -Destination $runtime
}
if(([IO.File]::ReadAllText((Join-Path $runtime 'LCM_RELEASE'))).Trim() -ne $Release){throw 'Immutable runtime marker mismatch'}
if($StageOnly){[ordered]@{status='STAGED';hostname=$ExpectedHostname;runtime=$runtime;identityCreated=$false;presentationRegistered=$false}|ConvertTo-Json -Compress;exit}
if(Test-Path -LiteralPath (Join-Path $network 'agent.json')){
 $config=Get-Content (Join-Path $network 'agent.json') -Raw|ConvertFrom-Json
 if($config.hostname -ne $ExpectedHostname -or $config.gatewayUrl -ne $GatewayUrl){throw 'Existing configuration differs; refuse implicit replacement'}
}else{
 if(Test-Path -LiteralPath (Join-Path $network 'agent/device-identity.json')){throw 'Existing identity without config requires reviewed recovery'}
 New-Item -ItemType Directory -Force -Path $network,(Join-Path $network 'agent'),$bridge|Out-Null
 foreach($private in @($network,$bridge)){
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
  $sids=@('S-1-5-18','S-1-5-32-544')
  if($private -eq $bridge){$sids+=([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)}
  foreach($sid in $sids){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  Set-Acl -LiteralPath $private -AclObject $acl
 }
 Copy-Item -LiteralPath $CaBundle -Destination (Join-Path $network 'ca.crt')
 $config=[ordered]@{schemaVersion=1;gatewayUrl=$GatewayUrl;hostname=$ExpectedHostname;stateDir=(Join-Path $network 'agent');deviceFirst=$true;interactiveStateDir=$bridge;channel=@{reconnectBaseMs=1000;reconnectMaxMs=30000;heartbeatMs=10000;heartbeatTimeoutMs=90000;callTimeoutMs=55000;maxInFlight=8;completedResultCacheSize=256}}
 [IO.File]::WriteAllText((Join-Path $network 'agent.json'),($config|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
 [IO.File]::WriteAllText((Join-Path $root 'runtime.json'),(@{schemaVersion=1;runtimeRoot=$runtime;runtimeCommit=$Release;version='0.3.5';presentation='private-cloud-only';deviceFirst=$true}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}
$env:NODE_EXTRA_CA_CERTS=Join-Path $network 'ca.crt'
& $node (Join-Path $runtime 'dist/remote-device/fleet/agent-main.js') --config (Join-Path $network 'agent.json') --print-provisioning
if($LASTEXITCODE -ne 0){throw 'Independent identity provisioning failed'}
if($ProvisionOnly){exit}
if($InstallTask){
 $agentTask='NetworkFleetAgent-'+$ExpectedHostname;$bridgeTask='LCMInteractiveUser-'+$ExpectedHostname
 foreach($name in @($agentTask,$bridgeTask)){if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw 'Existing task: use controlled runtime activation instead'}}
 $quote={param($v) "'"+$v.Replace("'","''")+"'"}
 $agentRunner="`$ErrorActionPreference='Stop'`n`$env:NODE_EXTRA_CA_CERTS="+(& $quote $env:NODE_EXTRA_CA_CERTS)+"`n`$env:LCM_RELEASE='"+$Release+"'`n& "+(& $quote $node)+" "+(& $quote (Join-Path $runtime 'dist/remote-device/fleet/agent-main.js'))+" --config "+(& $quote (Join-Path $network 'agent.json'))+"`nexit `$LASTEXITCODE`n"
 $bridgeRunner="`$ErrorActionPreference='Stop'`n`$env:LCM_RELEASE='"+$Release+"'`n& "+(& $quote $node)+" "+(& $quote (Join-Path $runtime 'dist/remote-device/fleet/user-bridge-main.js'))+" --config "+(& $quote (Join-Path $network 'agent.json'))+"`nexit `$LASTEXITCODE`n"
 [IO.File]::WriteAllText((Join-Path $network 'run-agent.ps1'),$agentRunner,[Text.UTF8Encoding]::new($false))
 [IO.File]::WriteAllText((Join-Path $bridge 'run-user-bridge.ps1'),$bridgeRunner,[Text.UTF8Encoding]::new($false))
 $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
 $agentAction=New-ScheduledTaskAction -Execute $pwsh -Argument ('-NoProfile -File "'+(Join-Path $network 'run-agent.ps1')+'"')
 $bridgeAction=New-ScheduledTaskAction -Execute $pwsh -Argument ('-NoProfile -File "'+(Join-Path $bridge 'run-user-bridge.ps1')+'"')
 Register-ScheduledTask -TaskName $agentTask -Action $agentAction -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest)|Out-Null
 try{Register-ScheduledTask -TaskName $bridgeTask -Action $bridgeAction -Trigger (New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)) -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest)|Out-Null}
 catch{Unregister-ScheduledTask -TaskName $agentTask -Confirm:$false;throw}
 if($StartNow){Start-ScheduledTask -TaskName $bridgeTask;Start-ScheduledTask -TaskName $agentTask}
}
[ordered]@{status='PROVISIONED';hostname=$ExpectedHostname;release=$Release;presentationRegistered=$false;identityCloned=$false}|ConvertTo-Json -Compress
