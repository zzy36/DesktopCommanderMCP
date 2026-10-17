[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ExpectedHostname,
 [Parameter(Mandatory)][ValidateSet('hidden','visible')][string]$Mode
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $env:COMPUTERNAME.Equals($ExpectedHostname,[StringComparison]::OrdinalIgnoreCase)){throw 'Exact hostname mismatch'}
$network=Join-Path $env:ProgramData 'NetworkFleet'
$bridge=Join-Path $env:ProgramData 'LocalControlMCP-UserBridge'
$configPath=Join-Path $network 'agent.json'
$runner=Join-Path $bridge 'run-user-bridge.ps1'
$taskName='LCMInteractiveUser-'+$ExpectedHostname
if(-not(Test-Path -LiteralPath $configPath)){throw 'Agent configuration not found'}
if(-not(Test-Path -LiteralPath $runner)){throw 'Interactive bridge runner not found'}
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if(@($task.Actions).Count -ne 1){throw 'Unexpected interactive bridge task action count'}
$execute=[string]$task.Actions[0].Execute
if([string]::IsNullOrWhiteSpace($execute)){throw 'Interactive bridge PowerShell executable missing'}
$args=if($Mode -eq 'hidden'){'-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "'+$runner+'"'}else{'-NoProfile -ExecutionPolicy Bypass -File "'+$runner+'"'}
$action=New-ScheduledTaskAction -Execute $execute -Argument $args
Set-ScheduledTask -TaskName $taskName -Action $action | Out-Null
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Milliseconds 350
$after=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$actualArgs=[string]$after.Actions[0].Arguments
if($Mode -eq 'hidden' -and $actualArgs -notmatch '(?i)-WindowStyle\s+Hidden'){throw 'Hidden mode did not persist'}
if($Mode -eq 'visible' -and $actualArgs -match '(?i)-WindowStyle\s+Hidden'){throw 'Visible mode did not persist'}
[ordered]@{hostname=$ExpectedHostname;mode=$Mode;task=$taskName;state=[string]$after.State}|ConvertTo-Json -Compress