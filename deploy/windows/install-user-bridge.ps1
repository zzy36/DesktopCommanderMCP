[CmdletBinding()]
param([Parameter(Mandatory)][string]$RuntimeRoot,[Parameter(Mandatory)][string]$ControlRoot,[Parameter(Mandatory)][string]$ExpectedHostname)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $env:COMPUTERNAME.Equals($ExpectedHostname,[StringComparison]::OrdinalIgnoreCase)){throw 'Exact D0 mismatch'}
$runtime=(Resolve-Path -LiteralPath $RuntimeRoot).Path
$control=(Resolve-Path -LiteralPath $ControlRoot).Path
$main=Join-Path $runtime 'dist\remote-device\fleet\user-bridge-main.js'
if(-not(Test-Path -LiteralPath $main)){throw 'Built user bridge missing'}
$user=[string](Get-CimInstance Win32_ComputerSystem).UserName
if(-not $user -or $user -match '(?i)system$'){throw 'No logged-in interactive user; SYSTEM substitution denied'}
$sid=([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier])
$state=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'LocalControlMCP-UserBridge'
New-Item -ItemType Directory -Path $state -Force|Out-Null
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach($identity in @('S-1-5-18','S-1-5-32-544',[string]$sid.Value)){
 $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $state -AclObject $acl
$run=Join-Path $state 'run-user-bridge.ps1'
$node=(Get-Command node -ErrorAction Stop).Source
$lines=@('$ErrorActionPreference=''Stop''',('& ''{0}'' ''{1}'' --control-root ''{2}'' --state-dir ''{3}''' -f $node.Replace("'","''"),$main.Replace("'","''"),$control.Replace("'","''"),$state.Replace("'","''")),'exit $LASTEXITCODE')
[IO.File]::WriteAllLines($run,$lines,[Text.UTF8Encoding]::new($false))
$name='LCMInteractiveUser-'+$ExpectedHostname
$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if($existing){
 if(@($existing.Actions).Count -ne 1 -or [string]$existing.Actions[0].Arguments -notmatch 'run-user-bridge\.ps1'){throw 'Refusing unrelated task replacement'}
 $backup=Join-Path $state ('task-backup-'+(Get-Date -Format 'yyyyMMddHHmmss')+'.xml')
 Export-ScheduledTask -TaskName $name|Set-Content -LiteralPath $backup -Encoding UTF8
 Stop-ScheduledTask -TaskName $name
}
$pwsh=(Get-Command pwsh -ErrorAction Stop).Source
$action=New-ScheduledTaskAction -Execute $pwsh -Argument ('-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $run)
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -Hidden -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'LCM project-authorized exact-device interactive user executor' -Force|Out-Null
Start-ScheduledTask -TaskName $name
$manifest=Join-Path $state 'bridge.json'
$ready=$false
for($i=0;$i -lt 60;$i++){
 if(Test-Path -LiteralPath $manifest){
  try{$m=Get-Content -LiteralPath $manifest -Raw|ConvertFrom-Json;$age=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-[long]$m.updatedAt
   if([string]$m.hostname -eq $ExpectedHostname -and [int]$m.sessionId -gt 0 -and $age -ge 0 -and $age -lt 10000){$ready=$true;break}
  }catch{}
 }
 Start-Sleep -Milliseconds 500
}
if(-not $ready){throw 'Interactive bridge did not become ready'}
[ordered]@{status='PASS';hostname=$ExpectedHostname;user=$user;session_id=[int]$m.sessionId;state_dir=$state;task=$name}|ConvertTo-Json -Compress
