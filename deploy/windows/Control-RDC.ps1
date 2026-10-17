[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ExpectedHostname,
 [Parameter(Mandatory)][ValidateSet('status','start','stop','restart','show','hide','enable','disable')][string]$Action
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $env:COMPUTERNAME.Equals($ExpectedHostname,[StringComparison]::OrdinalIgnoreCase)){throw 'Exact hostname mismatch'}
$state=Join-Path $env:ProgramData 'LocalControlMCP-RDC'
$runner=Join-Path $state 'run-rdc.ps1'
$versionFile=Join-Path $state 'version.txt'
$taskName='DesktopCommanderRemote-'+$ExpectedHostname
if(-not(Test-Path -LiteralPath $runner)){throw 'RDC supervisor runner not installed'}
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if(@($task.Actions).Count -ne 1 -or [string]$task.Actions[0].Arguments -notmatch 'run-rdc\.ps1'){throw 'Unexpected RDC task action'}
function Get-RdcStatus {
 $t=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
 $info=Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
 $args=[string]$t.Actions[0].Arguments
 $mode=if($args -match '(?i)-WindowStyle\s+Hidden'){'hidden'}else{'visible'}
 $version=if(Test-Path -LiteralPath $versionFile){(Get-Content -LiteralPath $versionFile -Raw).Trim()}else{$null}
 $procs=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { [string]$_.CommandLine -match 'run-rdc\.ps1|@wonderwhy-er[\\/]desktop-commander[^\s]*\s+remote' })
 [ordered]@{
  hostname=$ExpectedHostname
  task=$taskName
  state=[string]$t.State
  enabled=[bool]$t.Settings.Enabled
  autostart=[bool]$t.Settings.Enabled
  windowMode=$mode
  rdcVersion=$version
  processCount=$procs.Count
  pids=@($procs|ForEach-Object{[int]$_.ProcessId})
  lastRunTime=if($info){$info.LastRunTime.ToString('o')}else{$null}
  lastTaskResult=if($info){[int]$info.LastTaskResult}else{$null}
 }
}
$wasRunning=([string]$task.State -eq 'Running')
switch($Action){
 'start' { if(-not [bool]$task.Settings.Enabled){Enable-ScheduledTask -TaskName $taskName|Out-Null}; Start-ScheduledTask -TaskName $taskName }
 'stop' { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
 'restart' { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300; if(-not [bool](Get-ScheduledTask -TaskName $taskName).Settings.Enabled){Enable-ScheduledTask -TaskName $taskName|Out-Null}; Start-ScheduledTask -TaskName $taskName }
 'enable' { Enable-ScheduledTask -TaskName $taskName|Out-Null }
 'disable' { Disable-ScheduledTask -TaskName $taskName|Out-Null }
 'show' {
  $execute=[string]$task.Actions[0].Execute
  $newArgs=([string]$task.Actions[0].Arguments) -replace '(?i)-WindowStyle\s+Hidden\s*',''
  Set-ScheduledTask -TaskName $taskName -Action (New-ScheduledTaskAction -Execute $execute -Argument $newArgs.Trim())|Out-Null
  if($wasRunning){Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;Start-Sleep -Milliseconds 300;Start-ScheduledTask -TaskName $taskName}
 }
 'hide' {
  $execute=[string]$task.Actions[0].Execute
  $base=([string]$task.Actions[0].Arguments) -replace '(?i)-WindowStyle\s+Hidden\s*',''
  Set-ScheduledTask -TaskName $taskName -Action (New-ScheduledTaskAction -Execute $execute -Argument ('-WindowStyle Hidden '+$base.Trim()))|Out-Null
  if($wasRunning){Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;Start-Sleep -Milliseconds 300;Start-ScheduledTask -TaskName $taskName}
 }
 'status' { }
}
Start-Sleep -Milliseconds 250
Get-RdcStatus|ConvertTo-Json -Depth 4 -Compress
