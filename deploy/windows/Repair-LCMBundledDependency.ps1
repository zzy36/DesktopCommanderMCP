[CmdletBinding()]
param([Parameter(Mandatory)][string]$RuntimeRoot,[Parameter(Mandatory)][string]$ExpectedHostname,[switch]$RestartAgent)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if(-not $env:COMPUTERNAME.Equals($ExpectedHostname,[StringComparison]::OrdinalIgnoreCase)){throw 'Exact device mismatch'}
$root=[IO.Path]::GetFullPath($RuntimeRoot)
$allowed=[IO.Path]::GetFullPath((Join-Path $env:ProgramData 'LocalControlMCP'))+'\'
if(-not $root.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'LCM runtime path required'}
$source=Join-Path $root 'vendor/telemetry-contract';$target=Join-Path $root 'node_modules/@desktop-commander/telemetry-contract'
if(-not(Test-Path (Join-Path $source 'package.json'))){throw 'Canonical bundled dependency missing'}
$entry=Get-Item -LiteralPath $target -Force
if($entry.LinkType -ne 'Junction'){if(Test-Path (Join-Path $target 'package.json')){@{status='ALREADY_PORTABLE';hostname=$ExpectedHostname}|ConvertTo-Json -Compress;exit};throw 'Unexpected dependency state'}
$identity=Join-Path $env:ProgramData 'NetworkFleet/agent/device-identity.json';$identityHash=if(Test-Path $identity){(Get-FileHash $identity).Hash}else{$null}
$tasks=@(('NetworkFleetAgent-'+$ExpectedHostname),('LCMInteractiveUser-'+$ExpectedHostname))
if($RestartAgent){foreach($task in $tasks){Stop-ScheduledTask -TaskName $task}}
$temp=$target+'.stage-portable-'+[guid]::NewGuid().ToString('N');$backupName='telemetry-contract.before-portable-'+(Get-Date -Format yyyyMMddTHHmmss)
# These are exact owned directory entries under the checked LCM root. Rename the
# junction itself; never recurse through its old target or remove retained backups.
Copy-Item -LiteralPath $source -Destination $temp -Recurse
Rename-Item -LiteralPath $target -NewName $backupName
try{Move-Item -LiteralPath $temp -Destination $target}catch{Rename-Item -LiteralPath (Join-Path (Split-Path $target -Parent) $backupName) -NewName 'telemetry-contract';throw}
foreach($file in Get-ChildItem -LiteralPath $source -File -Recurse){$relative=[IO.Path]::GetRelativePath($source,$file.FullName);if((Get-FileHash $file.FullName).Hash -ne (Get-FileHash (Join-Path $target $relative)).Hash){throw 'Bundled file integrity mismatch'}}
if($identityHash -and (Get-FileHash $identity).Hash -ne $identityHash){throw 'Identity unexpectedly changed'}
if($RestartAgent){foreach($task in $tasks){Start-ScheduledTask -TaskName $task}}
@{status='PORTABLE_DEPENDENCY_REPAIRED';hostname=$ExpectedHostname;junction_backup=(Join-Path (Split-Path $target -Parent) $backupName);identity_preserved=$true}|ConvertTo-Json -Compress
