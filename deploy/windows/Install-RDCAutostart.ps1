[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ExpectedHostname,
 [ValidatePattern('^\d+\.\d+\.\d+$')][string]$RdcVersion='0.3.0',
 [ValidateSet('hidden','visible')][string]$WindowMode='hidden',
 [switch]$StartNow
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $env:COMPUTERNAME.Equals($ExpectedHostname,[StringComparison]::OrdinalIgnoreCase)){throw 'Exact hostname mismatch'}
$pwsh='C:\Program Files\PowerShell\7\pwsh.exe'
$npx='C:\Program Files\nodejs\npx.cmd'
if(-not(Test-Path -LiteralPath $pwsh)){throw 'System PowerShell 7 not found'}
if(-not(Test-Path -LiteralPath $npx)){throw 'System npx.cmd not found'}
$pwshVersion=(& $pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()').Trim()
$user=[string](Get-CimInstance Win32_ComputerSystem).UserName
if(-not $user -or $user -match '(?i)system$'){throw 'No logged-in interactive user; RDC owner session is required'}
$sid=([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier])
$state=Join-Path $env:ProgramData 'LocalControlMCP-RDC'
New-Item -ItemType Directory -Path $state -Force|Out-Null
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
foreach($identity in @('S-1-5-18','S-1-5-32-544',[string]$sid.Value)){
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
Set-Acl -LiteralPath $state -AclObject $acl
$runner=Join-Path $state 'run-rdc.ps1'
$control=Join-Path $state 'Control-RDC.ps1'
$controlSource=Join-Path $PSScriptRoot 'Control-RDC.ps1'
if(-not(Test-Path -LiteralPath $controlSource)){throw 'Control-RDC.ps1 not found beside installer'}
Copy-Item -LiteralPath $controlSource -Destination $control -Force
$log=Join-Path $state 'rdc.log'
$versionFile=Join-Path $state 'version.txt'
$runnerLines=@(
 '$ErrorActionPreference=''Stop''',
 ('$npx='''+$npx.Replace("'","''")+''''),
 ('$log='''+$log.Replace("'","''")+''''),
 ('$version='''+$RdcVersion.Replace("'","''")+''''),
 '$stamp=(Get-Date).ToString(''o'')',
 '"[$stamp] RDC launcher starting version $version" | Tee-Object -FilePath $log -Append',
 '& $npx --yes (''@wonderwhy-er/desktop-commander@''+$version) remote 2>&1 | Tee-Object -FilePath $log -Append',
 '$code=$LASTEXITCODE',
 '$stamp=(Get-Date).ToString(''o'')',
 '"[$stamp] RDC launcher exited code=$code" | Tee-Object -FilePath $log -Append',
 'exit $code'
)
[IO.File]::WriteAllLines($runner,$runnerLines,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($versionFile,$RdcVersion,[Text.UTF8Encoding]::new($false))
$taskName='DesktopCommanderRemote-'+$ExpectedHostname
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing){
 if(@($existing.Actions).Count -ne 1 -or [string]$existing.Actions[0].Arguments -notmatch 'run-rdc\.ps1'){throw 'Refusing unrelated RDC task replacement'}
 Export-ScheduledTask -TaskName $taskName|Set-Content -LiteralPath (Join-Path $state ('task-backup-'+(Get-Date -Format 'yyyyMMddHHmmss')+'.xml')) -Encoding UTF8
 Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
$args=if($WindowMode -eq 'hidden'){'-WindowStyle Hidden -NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+$runner+'"'}else{'-NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+$runner+'"'}
$action=New-ScheduledTaskAction -Execute $pwsh -Argument $args
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -Hidden -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ('Desktop Commander Remote MCP '+$RdcVersion+' managed by Local Control MCP') -Force|Out-Null
if($StartNow){Start-ScheduledTask -TaskName $taskName}
Start-Sleep -Milliseconds 350
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
[ordered]@{status='PASS';hostname=$ExpectedHostname;task=$taskName;taskState=[string]$task.State;windowMode=$WindowMode;rdcVersion=$RdcVersion;pwshVersion=$pwshVersion;user=$user;autostart=$true;runner=$runner}|ConvertTo-Json -Compress
