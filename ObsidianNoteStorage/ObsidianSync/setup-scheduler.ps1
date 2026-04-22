# ObsidianSync — Task Scheduler setup
# Run once as current user (no admin needed for current-user tasks).
# Usage: .\setup-scheduler.ps1 -ExePath "C:\path\to\obsync.exe"

param(
    [Parameter(Mandatory)]
    [string]$ExePath,

    [string]$TaskName = "ObsidianSync_Midnight",

    # Time to run daily (24h format)
    [string]$TriggerTime = "00:00"
)

$ExePath = Resolve-Path $ExePath -ErrorAction Stop | Select-Object -ExpandProperty Path

$action  = New-ScheduledTaskAction -Execute $ExePath -Argument "sync"
$trigger = New-ScheduledTaskTrigger -Daily -At $TriggerTime
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Only run if something changed — we handle this inside obsync itself
Register-ScheduledTask `
    -TaskName   $TaskName `
    -Action     $action `
    -Trigger    $trigger `
    -Settings   $settings `
    -RunLevel   Limited `
    -Force | Out-Null

Write-Host "Task '$TaskName' registered. Runs daily at $TriggerTime."
Write-Host "Manual run: obsync sync"
Write-Host "View task : Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove    : Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
