param(
    [string]$TaskName = 'NetworkFleetAgent-YUAN'
)

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Scheduled task not present: $TaskName"
    exit 0
}

try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
} finally {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Host "Removed $TaskName"
Write-Host 'Fleet identity/state files were preserved for audit and stable device identity.'
Write-Host 'Official Remote Desktop Commander was not changed.'
