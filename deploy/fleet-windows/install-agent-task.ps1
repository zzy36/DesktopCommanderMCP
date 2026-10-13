param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [string]$TaskName = 'NetworkFleetAgent-YUAN',
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'

function Require-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label not found: $Path"
    }
}

$repo = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$config = (Resolve-Path -LiteralPath $ConfigPath).Path
$agentMain = Join-Path $repo 'dist\remote-device\fleet\agent-main.js'

Require-File $NodePath 'Node executable'
Require-File $agentMain 'Fleet Agent entry point (run npm build first)'
Require-File $config 'Fleet Agent config'

# Provisioning is deliberately executed before task registration. It proves that the
# current host can discover .control and read its policy without changing that policy.
Write-Host 'Checking Fleet Agent provisioning...'
& $NodePath $agentMain --config $config --print-provisioning
if ($LASTEXITCODE -ne 0) {
    throw "Fleet Agent provisioning failed with exit code $LASTEXITCODE"
}

$arguments = '"{0}" --config "{1}"' -f $agentMain, $config
$action = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument $arguments `
    -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

# SYSTEM avoids storing a user's password. Deployment acceptance must confirm that the
# exact host's local project/control volumes are visible in this security context.
$principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    throw "Scheduled task already exists: $TaskName. Uninstall or choose a different TaskName; refusing to overwrite."
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Self-hosted Network Fleet Agent. Independent from official Remote Desktop Commander.' | Out-Null

Write-Host "Registered $TaskName"
Write-Host 'Official Remote Desktop Commander was not changed.'

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
    Get-ScheduledTaskInfo -TaskName $TaskName | Format-List LastRunTime,LastTaskResult,NextRunTime
}
