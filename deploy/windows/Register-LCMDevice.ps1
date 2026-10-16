[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ControlRoot,
  [switch]$Json,
  [string]$SeedRepo,
  [string]$PairingCode,
  [switch]$DeviceFlow,
  [int]$PairingTimeoutSeconds = 600,
  [switch]$InstallTask,
  [switch]$StartNow,
  [switch]$RuntimeOnly
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$controlRoot=(Resolve-Path -LiteralPath $ControlRoot).Path
$profile=Get-Content -LiteralPath (Join-Path $controlRoot 'r0.profile.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$spec=$profile.local_control_mcp
if(-not $spec){throw 'r0.profile.json is missing local_control_mcp specification.'}
$hostname=((& hostname)|Out-String).Trim()
$devices=Get-Content -LiteralPath (Join-Path $controlRoot 'devices.registry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$device=@($devices.devices|Where-Object{([string]$_.device_name).Equals($hostname,[StringComparison]::OrdinalIgnoreCase)-or([string]$_.hostname).Equals($hostname,[StringComparison]::OrdinalIgnoreCase)})
if($device.Count -ne 1){throw "Current device '$hostname' is not uniquely registered as D0."}
$deviceName=[string]$device[0].device_name

$registerLocal=Join-Path $controlRoot 'tools\Register-LocalControlMcp.ps1'
$registerArgs=@('-NoProfile','-File',$registerLocal,'-Json')
if($SeedRepo){$registerArgs+=@('-SeedRepo',$SeedRepo)}
if($RuntimeOnly){$registerArgs+=@('-RuntimeOnly')}
$localJson=& pwsh @registerArgs | Out-String
if($LASTEXITCODE -ne 0){throw "Register-LocalControlMcp.ps1 failed with exit code $LASTEXITCODE"}
$local=$localJson|ConvertFrom-Json
if([string]$local.status -ne 'PASS'){throw 'Local Control MCP 运行时/插件引导未通过。'}

$programData=[Environment]::GetFolderPath('CommonApplicationData')
if(-not $programData){$programData=Join-Path ([IO.Path]::GetPathRoot($env:USERPROFILE)) 'ProgramData'}
$networkRoot=Join-Path $programData 'NetworkFleet'
$stateDir=Join-Path $networkRoot 'agent'
New-Item -ItemType Directory -Force -Path $networkRoot,$stateDir|Out-Null
$runtimeRoot=[string]$local.runtime_root
$agentMain=Join-Path $runtimeRoot 'dist\remote-device\fleet\agent-main.js'
if(-not(Test-Path -LiteralPath $agentMain)){throw "Fleet Agent runtime missing: $agentMain"}
$gatewayUrl=[string]$spec.agent_gateway_url
if(-not $gatewayUrl){throw 'local_control_mcp.agent_gateway_url is missing.'}
$caSource=Join-Path $controlRoot ([string]$spec.agent_ca_bundle)
if(-not(Test-Path -LiteralPath $caSource)){throw "Fleet CA bundle missing: $caSource"}
$caTarget=Join-Path $networkRoot 'ca.crt'
Copy-Item -LiteralPath $caSource -Destination $caTarget -Force
$caCert=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($caTarget)
$caThumbprint=[string]$caCert.Thumbprint
$alreadyTrusted=!!(Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue | Where-Object Thumbprint -eq $caThumbprint)
if(-not $alreadyTrusted){
  & certutil.exe -addstore -f Root $caTarget | Out-Null
  if($LASTEXITCODE -ne 0){throw "无法将 LCM 私有 CA 加入本机受信任根证书，certutil 退出码：$LASTEXITCODE"}
}
$caTrusted=!!(Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue | Where-Object Thumbprint -eq $caThumbprint)
if(-not $caTrusted){throw "LCM 私有 CA 未进入本机受信任根证书：$caThumbprint"}

$agentConfig=Join-Path $networkRoot 'agent.json'
$provisionBackup=Join-Path $networkRoot ('backups\provision-'+(Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force -Path $provisionBackup|Out-Null
foreach($file in @($agentConfig,(Join-Path $networkRoot 'run-agent.ps1'))){if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination $provisionBackup}}
$config=[ordered]@{
  schemaVersion=1
  gatewayUrl=$gatewayUrl
  controlRoot=$controlRoot
  stateDir=$stateDir
  hostname=$deviceName
  probeFileName='.network-fleet-plugin-probe.txt'
  policyWatchMs=5000
  channel=[ordered]@{
    reconnectBaseMs=1000
    reconnectMaxMs=30000
    heartbeatMs=10000
    heartbeatTimeoutMs=45000
    callTimeoutMs=15000
    maxInFlight=8
    completedResultCacheSize=256
  }
}
$config.interactiveStateDir=Join-Path $programData 'LocalControlMCP-UserBridge'
[IO.File]::WriteAllText($agentConfig,($config|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))

$node=(Get-Command node -ErrorAction Stop).Source
$oldCa=$env:NODE_EXTRA_CA_CERTS
try {
  $env:NODE_EXTRA_CA_CERTS=$caTarget
  $provisioningJson=& $node $agentMain --config $agentConfig --print-provisioning | Out-String
  if($LASTEXITCODE -ne 0){throw "Fleet Agent provisioning failed with exit code $LASTEXITCODE"}
} finally {
  $env:NODE_EXTRA_CA_CERTS=$oldCa
}
$provisioning=$provisioningJson|ConvertFrom-Json
if(-not $provisioning.publicKeyFingerprint){throw 'Fleet Agent 引导没有返回设备公钥指纹。'}
$pairingStatus=$null
$deviceFlowStatus=$null
if($DeviceFlow -and $PairingCode){throw '-DeviceFlow 与 -PairingCode 不能同时使用。'}
if($DeviceFlow){
  $authClient=Join-Path $runtimeRoot 'dist\remote-device\fleet\device-auth-client.js'
  if(-not(Test-Path -LiteralPath $authClient)){throw "缺少 LCM 设备验证客户端：$authClient"}
  $adminUrl=[string]$spec.admin_url
  if(-not $adminUrl){throw 'local_control_mcp.admin_url is missing.'}
  $oldCa=$env:NODE_EXTRA_CA_CERTS
  try {
    $env:NODE_EXTRA_CA_CERTS=$caTarget
    & $node $authClient --admin-url $adminUrl --hostname $deviceName --fingerprint ([string]$provisioning.publicKeyFingerprint) --policy-revision ([string]$provisioning.policyRevision)
    if($LASTEXITCODE -ne 0){throw "LCM 设备验证失败，退出码：$LASTEXITCODE"}
    $deviceFlowStatus='approved'
    $pairingStatus='approved'
  } finally {
    $env:NODE_EXTRA_CA_CERTS=$oldCa
  }
}
if($PairingCode){
  if($PairingTimeoutSeconds -lt 10 -or $PairingTimeoutSeconds -gt 3600){throw 'PairingTimeoutSeconds must be between 10 and 3600.'}
  $oldCa=$env:NODE_EXTRA_CA_CERTS
  $oldPairingCode=$env:FLEET_PAIRING_CODE
  try {
    $env:NODE_EXTRA_CA_CERTS=$caTarget
    $env:FLEET_PAIRING_CODE=$PairingCode
    $pairingJson=& $node $agentMain --config $agentConfig --claim-pairing --pairing-timeout-ms ([string]($PairingTimeoutSeconds * 1000)) | Out-String
    if($LASTEXITCODE -ne 0){throw "Fleet Agent pairing failed with exit code $LASTEXITCODE"}
    $pairing=$pairingJson|ConvertFrom-Json
    if([string]$pairing.status -ne 'approved'){throw "Fleet pairing did not reach approved state: $($pairing.status)"}
    $pairingStatus='approved'
  } finally {
    $env:NODE_EXTRA_CA_CERTS=$oldCa
    $env:FLEET_PAIRING_CODE=$oldPairingCode
  }
}
$runAgent=Join-Path $networkRoot 'run-agent.ps1'
$runLines=@(
  '$ErrorActionPreference = ''Stop''',
  ('$env:NODE_EXTRA_CA_CERTS = ''{0}''' -f $caTarget.Replace("'","''")),
  ('$env:LCM_RELEASE = ''{0}''' -f ([string]$spec.runtime_commit)),
  ('& ''{0}'' ''{1}'' --config ''{2}''' -f $node.Replace("'","''"),$agentMain.Replace("'","''"),$agentConfig.Replace("'","''")),
  'exit $LASTEXITCODE'
)
[IO.File]::WriteAllLines($runAgent,$runLines,[Text.UTF8Encoding]::new($false))

$taskName="NetworkFleetAgent-$deviceName"
$taskInstalled=$false
if($InstallTask){
  $bridgeRaw=& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'install-user-bridge.ps1') -RuntimeRoot $runtimeRoot -ControlRoot $controlRoot -ExpectedHostname $deviceName|Out-String
  if($LASTEXITCODE -ne 0){throw 'Interactive user executor installation failed'}
  $pwsh=(Get-Command pwsh -ErrorAction Stop).Source
  $existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if($existing){
    $actions=@($existing.Actions)
    $ours=$actions.Count -eq 1 -and (([string]$actions[0].Arguments) -match 'NetworkFleet|agent-main\.js|run-agent\.ps1')
    if(-not $ours){throw "Refusing to replace unrelated scheduled task: $taskName"}
    Export-ScheduledTask -TaskName $taskName|Set-Content -LiteralPath (Join-Path $provisionBackup 'agent-task.xml') -Encoding UTF8
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  $action=New-ScheduledTaskAction -Execute $pwsh -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $runAgent)
  $trigger=New-ScheduledTaskTrigger -AtStartup
  $settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
  $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Self-hosted Local Control MCP Fleet Agent. Official Remote MCP remains independent.'|Out-Null
  $taskInstalled=$true
  if($StartNow){Start-ScheduledTask -TaskName $taskName}
}
if($InstallTask){& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'harden-windows-state.ps1') -ExpectedHostname $deviceName|Out-Null;if($LASTEXITCODE -ne 0){throw 'Windows LCM state ACL validation failed'}}
$result=[ordered]@{
  status='PASS'
  device_name=$deviceName
  control_root=$controlRoot
  local_plugin_id=[string]$local.plugin_id
  local_runtime_root=$runtimeRoot
  gateway_url=$gatewayUrl
  admin_url=[string]$spec.admin_url
  agent_config=$agentConfig
  agent_state_dir=$stateDir
  ca_bundle=$caTarget
  ca_thumbprint=$caThumbprint
  ca_trusted_local_machine=$caTrusted
  public_key_fingerprint=[string]$provisioning.publicKeyFingerprint
  policy_revision=[string]$provisioning.policyRevision
  pairing_status=$pairingStatus
  device_flow_status=$deviceFlowStatus
  task_name=$taskName
  task_installed=$taskInstalled
  task_started=($InstallTask -and $StartNow)
  next_step=if($DeviceFlow -and $deviceFlowStatus -eq 'approved' -and $InstallTask){'设备验证完成；请确认 Gateway 中该 Agent 已在线。'}elseif($DeviceFlow -and $deviceFlowStatus -eq 'approved'){'设备验证完成；请使用 -InstallTask -StartNow 安装并启动 SYSTEM Agent。'}elseif($PairingCode -and $pairingStatus -eq 'approved' -and $InstallTask){'兼容配对已批准；请确认 Gateway 中该 Agent 已在线。'}elseif($PairingCode -and $pairingStatus -eq 'approved'){'兼容配对已批准；请使用 -InstallTask -StartNow 安装并启动 SYSTEM Agent。'}elseif($InstallTask){'请确认 Gateway 中的设备名/指纹一致，并确认 Agent 已认证上线。'}else{'请运行 lcm remote 完成浏览器设备验证；兼容旧流程也可手工批准设备指纹后再启用 SYSTEM Agent。'}
}
if($Json){$result|ConvertTo-Json -Depth 8}else{$result.GetEnumerator()|ForEach-Object{Write-Host ("{0}={1}" -f $_.Key,$_.Value)}}
