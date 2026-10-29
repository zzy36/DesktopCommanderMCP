[CmdletBinding()]
param([Parameter(Mandatory)][string]$ControlRoot,[switch]$Json,[switch]$SkipBuild,[string]$SeedRepo,[switch]$RetireLegacyRegistrations,[switch]$RuntimeOnly)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$controlRoot=(Resolve-Path -LiteralPath $ControlRoot).Path
$profile=Get-Content -LiteralPath (Join-Path $controlRoot 'r0.profile.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if(-not($profile.PSObject.Properties.Name -contains 'local_control_mcp')){throw 'r0.profile.json is missing local_control_mcp specification.'}
$spec=$profile.local_control_mcp
$hostname=((& hostname)|Out-String).Trim()
$devices=Get-Content -LiteralPath (Join-Path $controlRoot 'devices.registry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$device=@($devices.devices|Where-Object{([string]$_.device_name).Equals($hostname,[StringComparison]::OrdinalIgnoreCase)-or([string]$_.hostname).Equals($hostname,[StringComparison]::OrdinalIgnoreCase)})
if($device.Count -ne 1){throw "Current device '$hostname' is not uniquely registered in devices.registry.json."}

$runtimeCommit=[string]$spec.runtime_commit
$deviceSpec=$device[0]
if(($deviceSpec.PSObject.Properties.Name -contains 'runtime_overrides') -and $deviceSpec.runtime_overrides -and
   ($deviceSpec.runtime_overrides.PSObject.Properties.Name -contains 'local_control_mcp') -and $deviceSpec.runtime_overrides.local_control_mcp -and
   ($deviceSpec.runtime_overrides.local_control_mcp.PSObject.Properties.Name -contains 'runtime_commit') -and
   [string]$deviceSpec.runtime_overrides.local_control_mcp.runtime_commit){
  $runtimeCommit=[string]$deviceSpec.runtime_overrides.local_control_mcp.runtime_commit
}

$programData=[Environment]::GetFolderPath('CommonApplicationData')
if(-not $programData){$programData=Join-Path ([IO.Path]::GetPathRoot($env:USERPROFILE)) 'ProgramData'}
$sharedRoot=Join-Path $programData 'LocalControlMCP'
$runtimeRoot=Join-Path $sharedRoot 'DesktopCommanderMCP'
$runtimeConfig=Join-Path $sharedRoot 'runtime.json'
$marketRoot=Join-Path $sharedRoot 'marketplace'
$pluginSource=Join-Path $marketRoot 'plugins\local-control-mcp'
$marketManifest=Join-Path $marketRoot '.agents\plugins\marketplace.json'
New-Item -ItemType Directory -Force -Path $sharedRoot,$marketRoot,(Split-Path $marketManifest -Parent),(Split-Path $pluginSource -Parent)|Out-Null

$repo=[string]$spec.runtime_repo
$commit=$runtimeCommit.ToLowerInvariant()
$archiveTemplate=[string]$spec.runtime_archive_url
if($commit -notmatch '^[0-9a-f]{40}$'){throw "Invalid pinned Local Control MCP commit: $commit"}
$runtimeRoot=Join-Path $sharedRoot ('releases\'+$commit)
New-Item -ItemType Directory -Force -Path (Split-Path $runtimeRoot -Parent)|Out-Null
if(-not $archiveTemplate -and -not $SeedRepo){throw 'runtime_archive_url is required when SeedRepo is not supplied.'}

function Invoke-Checked([string]$File,[string[]]$ArgumentList,[string]$Label){
  if($Json){& $File @ArgumentList | Out-Null}else{& $File @ArgumentList}
  if($LASTEXITCODE -ne 0){throw "$Label failed with exit code $LASTEXITCODE"}
}
function Read-RuntimeConfig {
  if(-not(Test-Path -LiteralPath $runtimeConfig)){return $null}
  try{return Get-Content -LiteralPath $runtimeConfig -Raw -Encoding UTF8 | ConvertFrom-Json}catch{return $null}
}
function Test-RuntimeReady {
  $marker=Join-Path $runtimeRoot 'LCM_RELEASE'
  if(-not(Test-Path -LiteralPath $marker)){return $false}
  if(([IO.File]::ReadAllText($marker)).Trim() -ne $commit){return $false}
  return (Test-Path -LiteralPath (Join-Path $runtimeRoot 'dist\remote-device\fleet\local-plugin-main.js')) -and (Test-Path -LiteralPath (Join-Path $runtimeRoot 'deploy\chatgpt-local-plugin\local-control-mcp\plugin.json')) -and (Test-Path -LiteralPath (Join-Path $runtimeRoot 'node_modules\@desktop-commander\telemetry-contract\package.json'))
}

if(-not(Test-RuntimeReady)){
  $stageRoot=Join-Path $sharedRoot ('.stage-'+[Guid]::NewGuid().ToString('N'))
  $stageRuntime=Join-Path $stageRoot 'DesktopCommanderMCP'
  New-Item -ItemType Directory -Force -Path $stageRoot|Out-Null
  try {
    if($SeedRepo){
      $seed=(Resolve-Path -LiteralPath $SeedRepo).Path
      if(-not(Test-Path -LiteralPath (Join-Path $seed '.git'))){throw "SeedRepo is not a Git checkout: $seed"}
      Invoke-Checked 'git' @('clone','--no-hardlinks',$seed,$stageRuntime) 'runtime seed clone'
      Invoke-Checked 'git' @('-C',$stageRuntime,'checkout','--detach',$commit) 'runtime seed checkout'
      Invoke-Checked 'git' @('-C',$stageRuntime,'remote','set-url','origin',$repo) 'runtime origin reset'
    } else {
      $archiveUrl=$archiveTemplate.Replace('{commit}',$commit)
      $archive=Join-Path $stageRoot 'runtime.zip'
      $expanded=Join-Path $stageRoot 'expanded'
      New-Item -ItemType Directory -Force -Path $expanded|Out-Null
      $curl=(Get-Command curl.exe -ErrorAction Stop).Source
      Invoke-Checked $curl @('-fL','--silent','--show-error','--retry','3','--retry-all-errors','--connect-timeout','10','--max-time','900','-o',$archive,$archiveUrl) 'runtime archive download'
      Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
      $roots=@(Get-ChildItem -LiteralPath $expanded -Directory)
      if($roots.Count -ne 1){throw "Runtime archive must contain exactly one top-level directory; found $($roots.Count)."}
      Move-Item -LiteralPath $roots[0].FullName -Destination $stageRuntime
    }

    if(-not $SkipBuild){
      Push-Location $stageRuntime
      try {
        Invoke-Checked 'npm' @('ci','--ignore-scripts','--install-links') 'npm ci --ignore-scripts --install-links'
        Invoke-Checked 'npm' @('run','build') 'npm run build'
      } finally {Pop-Location}
    }
    $stageServer=Join-Path $stageRuntime 'dist\remote-device\fleet\local-plugin-main.js'
    $stageTemplate=Join-Path $stageRuntime 'deploy\chatgpt-local-plugin\local-control-mcp\plugin.json'
    if(-not(Test-Path -LiteralPath $stageServer)){throw "Built Local Control MCP server missing: $stageServer"}
    if(-not(Test-Path -LiteralPath $stageTemplate)){throw "Plugin template missing: $stageTemplate"}

    if(Test-Path -LiteralPath $runtimeRoot){throw "Refusing to overwrite an incomplete immutable release: $runtimeRoot"}
    [IO.File]::WriteAllText((Join-Path $stageRuntime 'LCM_RELEASE'),$commit,[Text.UTF8Encoding]::new($false))
    [IO.Directory]::Move($stageRuntime,$runtimeRoot)

  } finally {
    if(Test-Path -LiteralPath $stageRoot){
      $resolvedStage=[IO.Path]::GetFullPath($stageRoot)
      $allowedPrefix=[IO.Path]::GetFullPath($sharedRoot).TrimEnd('\')+'\.stage-'
      if(-not $resolvedStage.StartsWith($allowedPrefix,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $stageRoot).LinkType){throw 'Stage cleanup path guard failed'}
      Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
  }
}

$server=Join-Path $runtimeRoot 'dist\remote-device\fleet\local-plugin-main.js'
$template=Join-Path $runtimeRoot 'deploy\chatgpt-local-plugin\local-control-mcp'
if(-not(Test-Path -LiteralPath $server)){throw "Local Control MCP runtime is incomplete: $server"}
if(-not(Test-Path -LiteralPath (Join-Path $template 'plugin.json'))){throw "Local Control MCP plugin template is incomplete: $template"}
$config=[ordered]@{schema_version=1;device_name=[string]$device[0].device_name;controlRoot=$controlRoot;runtimeRoot=$runtimeRoot;runtimeCommit=$commit;installedAt=(Get-Date).ToString('o');presentation=[string]$spec.presentation}
if(Test-Path -LiteralPath $runtimeConfig){$saved=Join-Path $sharedRoot ('retired\runtime-config-'+(Get-Date -Format 'yyyyMMddHHmmss')+'.json');New-Item -ItemType Directory -Force -Path (Split-Path $saved -Parent)|Out-Null;Copy-Item -LiteralPath $runtimeConfig -Destination $saved}
[IO.File]::WriteAllText($runtimeConfig,($config|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))

if($RuntimeOnly){
  $runtimePluginId=$null
  if(($spec.PSObject.Properties.Name -contains 'marketplace') -and [string]$spec.marketplace){$runtimePluginId='local-control-mcp@'+[string]$spec.marketplace}
  $runtimeOnlyResult=[ordered]@{
    device_name=[string]$device[0].device_name
    control_root=$controlRoot
    runtime_root=$runtimeRoot
    runtime_commit=$commit
    runtime_config=$runtimeConfig
    plugin_id=$runtimePluginId
    plugin_version=[string]$spec.plugin_version
    plugin_touched=$false
    runtime_only=$true
    status='PASS'
  }
  if($Json){$runtimeOnlyResult|ConvertTo-Json -Depth 8}else{$runtimeOnlyResult.GetEnumerator()|ForEach-Object{Write-Host ("{0}={1}" -f $_.Key,$_.Value)}}
  return
}

if(Test-Path -LiteralPath $pluginSource){$savedPlugin=Join-Path $sharedRoot ('retired\market-plugin-'+(Get-Date -Format 'yyyyMMddHHmmss'));New-Item -ItemType Directory -Force -Path (Split-Path $savedPlugin -Parent)|Out-Null;Move-Item -LiteralPath $pluginSource -Destination $savedPlugin}
Copy-Item -LiteralPath $template -Destination $pluginSource -Recurse -Force
$market=[ordered]@{
  name=[string]$spec.marketplace
  interface=[ordered]@{displayName='Local Control Plane'}
  plugins=@([ordered]@{
    name='local-control-mcp'
    source=[ordered]@{source='local';path='./plugins/local-control-mcp'}
    policy=[ordered]@{installation='INSTALLED_BY_DEFAULT';authentication='ON_INSTALL'}
    category='Developer Tools'
  })
}
[IO.File]::WriteAllText($marketManifest,($market|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))

$codex=(Get-Command codex -ErrorAction Stop).Source
$marketName=[string]$spec.marketplace
$pluginId="local-control-mcp@$marketName"
$wantedVersion=[string]$spec.plugin_version
$codexConfig=Join-Path $env:USERPROFILE '.codex\config.toml'

# One-way compatibility cleanup. Legacy runtime files remain intact for rollback;
# only stale plugin/marketplace registrations and caches are retired here.
if($RetireLegacyRegistrations){
$legacySharedRoot=Join-Path $programData 'LocalRemoteMCP'
$retiredRoot=Join-Path $sharedRoot ('retired\pre-lcm-0.3.0-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
function Move-ToRetired([string]$Path){
  if(-not(Test-Path -LiteralPath $Path)){return}
  New-Item -ItemType Directory -Force -Path $retiredRoot|Out-Null
  $name=Split-Path $Path -Leaf
  $dest=Join-Path $retiredRoot $name
  if(Test-Path -LiteralPath $dest){$dest=Join-Path $retiredRoot ($name+'-'+[Guid]::NewGuid().ToString('N'))}
  Move-Item -LiteralPath $Path -Destination $dest -Force
}

$legacyMarketplace='local-network-fleet'
$legacyMarketManifest=Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
if(Test-Path -LiteralPath $legacyMarketManifest){
  $legacyManifest=$null
  try{$legacyManifest=Get-Content -LiteralPath $legacyMarketManifest -Raw -Encoding UTF8|ConvertFrom-Json}catch{}
  $legacyMatches=if($legacyManifest){@($legacyManifest.plugins|Where-Object{[string]$_.name -eq 'local-remote-mcp'})}else{@()}
  if($legacyManifest -and [string]$legacyManifest.name -eq $legacyMarketplace -and $legacyMatches.Count -eq 1){Move-ToRetired $legacyMarketManifest}
}

$legacyCurrentPlugin='local-remote-mcp@local-control'
$legacyHistoricalPlugin='local-remote-mcp@local-network-fleet'
$legacyConfigFound=$false
if(Test-Path -LiteralPath $codexConfig){
  $configText=[IO.File]::ReadAllText($codexConfig)
  foreach($legacyPlugin in @($legacyCurrentPlugin,$legacyHistoricalPlugin)){
    $legacySectionPattern='(?m)^\[plugins\."'+[regex]::Escape($legacyPlugin)+'"\]\r?\n(?:(?!^\[)[^\r\n]*(?:\r?\n|$))*'
    $cleaned=[regex]::Replace($configText,$legacySectionPattern,'',1)
    if($cleaned -ne $configText){$legacyConfigFound=$true;$configText=$cleaned}
  }
  if($legacyConfigFound){[IO.File]::WriteAllText($codexConfig,$configText,[Text.UTF8Encoding]::new($false))}
}
if($legacyConfigFound){Move-ToRetired (Join-Path $env:USERPROFILE '.codex\plugins\local-remote-mcp')}

$marketList=(& $codex plugin marketplace list --json | Out-String | ConvertFrom-Json)
if(@($marketList.marketplaces|Where-Object{$_.name -eq $legacyMarketplace}).Count -eq 1){& $codex plugin marketplace remove $legacyMarketplace --json 2>$null | Out-Null}
}
$legacySharedRoot=Join-Path $programData 'LocalRemoteMCP'
$marketList=(& $codex plugin marketplace list --json | Out-String | ConvertFrom-Json)
$existingMarket=@($marketList.marketplaces|Where-Object{$_.name -eq $marketName})
if($existingMarket.Count -gt 1){throw "Marketplace '$marketName' is ambiguous."}
if($existingMarket.Count -eq 1){
  $existingRoot=[IO.Path]::GetFullPath([string]$existingMarket[0].root)
  $wantedRoot=[IO.Path]::GetFullPath($marketRoot)
  $legacyRoot=[IO.Path]::GetFullPath((Join-Path $legacySharedRoot 'marketplace'))
  if($existingRoot.Equals($legacyRoot,[StringComparison]::OrdinalIgnoreCase)){
    throw 'Legacy marketplace still active; finish consumer audit before explicit registration retirement'
  } elseif(-not $existingRoot.Equals($wantedRoot,[StringComparison]::OrdinalIgnoreCase)) {
    throw "Marketplace '$marketName' already points elsewhere: $existingRoot"
  }
}
if($existingMarket.Count -eq 0){Invoke-Checked $codex @('plugin','marketplace','add',$marketRoot,'--json') 'marketplace add'}

# Marketplace refresh can already install an enabled plugin. Verify every
# pinned file, including hidden compatibility metadata, before replacement.
$installedPath=Join-Path $env:USERPROFILE ('.codex\plugins\cache\'+$marketName+'\local-control-mcp\'+$wantedVersion)
function Test-PinnedPluginCache {
  if(-not(Test-Path -LiteralPath $installedPath)){return $false}
  foreach($file in Get-ChildItem -LiteralPath $template -Recurse -File -Force){
    $relative=[IO.Path]::GetRelativePath($template,$file.FullName)
    $cached=Join-Path $installedPath $relative
    if(-not(Test-Path -LiteralPath $cached) -or (Get-FileHash -LiteralPath $cached).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash){return $false}
  }
  $enabledPattern='(?ms)^\[plugins\."'+[regex]::Escape($pluginId)+'"\]\s*\r?\n(?:(?!^\[).)*?^enabled\s*=\s*true\s*$'
  return (Test-Path -LiteralPath $codexConfig) -and ([IO.File]::ReadAllText($codexConfig) -match $enabledPattern)
}
if(-not(Test-PinnedPluginCache)){
  $addRaw=(& $codex plugin add $pluginId --json | Out-String)
  $addExit=$LASTEXITCODE
  if(-not(Test-PinnedPluginCache)){throw "plugin installation/cache verification failed (CLI exit $addExit)"}
}
$installedManifest=Get-Content -LiteralPath (Join-Path $installedPath 'plugin.json') -Raw -Encoding UTF8|ConvertFrom-Json
$compatibilityManifest=Get-Content -LiteralPath (Join-Path $installedPath '.codex-plugin\plugin.json') -Raw -Encoding UTF8|ConvertFrom-Json
if([string]$installedManifest.version -ne $wantedVersion -or [string]$compatibilityManifest.version -ne $wantedVersion){throw 'LCM manifest version mismatch'}

# Thin user-facing CLI shim. The implementation stays in canonical .control tools.
$binRoot=Join-Path $sharedRoot 'bin'
New-Item -ItemType Directory -Force -Path $binRoot|Out-Null
$lcmCmd=Join-Path $binRoot 'lcm.cmd'
$startRemote=Join-Path $controlRoot 'tools\Start-LCMRemote.ps1'
$cmdLines=@(
  '@echo off',
  'setlocal',
  'if /I "%~1"=="remote" goto remote',
  'echo Local Control MCP',
  'echo 用法: lcm remote [-Relink] [-Status] [-WaitSeconds N]',
  'exit /b 2',
  ':remote',
  ('pwsh -NoProfile -ExecutionPolicy Bypass -File "{0}" %2 %3 %4 %5 %6 %7 %8 %9' -f $startRemote),
  'exit /b %ERRORLEVEL%'
)
[IO.File]::WriteAllLines($lcmCmd,$cmdLines,[Text.ASCIIEncoding]::new())
$userPath=[Environment]::GetEnvironmentVariable('Path','User')
$parts=@(($userPath -split ';')|Where-Object{$_})
if(-not($parts|Where-Object{[IO.Path]::GetFullPath($_).TrimEnd('\\').Equals([IO.Path]::GetFullPath($binRoot).TrimEnd('\\'),[StringComparison]::OrdinalIgnoreCase)})){
  $newUserPath=(@($parts)+$binRoot)-join ';'
  [Environment]::SetEnvironmentVariable('Path',$newUserPath,'User')
}
if(-not(($env:Path -split ';')|Where-Object{$_ -and [IO.Path]::GetFullPath($_).TrimEnd('\\').Equals([IO.Path]::GetFullPath($binRoot).TrimEnd('\\'),[StringComparison]::OrdinalIgnoreCase)})){$env:Path=$env:Path+';'+$binRoot}

$result=[ordered]@{device_name=[string]$device[0].device_name;control_root=$controlRoot;runtime_root=$runtimeRoot;runtime_commit=$commit;marketplace=$marketName;plugin_id=$pluginId;plugin_version=$wantedVersion;plugin_enabled=$true;runtime_config=$runtimeConfig;cli_path=$lcmCmd;ui_refresh_required=$true;status='PASS'}
if($Json){$result|ConvertTo-Json -Depth 8}else{$result.GetEnumerator()|ForEach-Object{Write-Host ("{0}={1}" -f $_.Key,$_.Value)}}
