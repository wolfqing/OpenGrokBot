# Registers a Task Scheduler task that starts the OpenGrokBot gateway when you sign in, and restarts it
# if it stops. It runs as you, in your session, so a local teammate's sign-in window can appear on your
# desktop. No administrator rights needed.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
#   Start-ScheduledTask -TaskName 'OpenGrokBot gateway'          # start it now
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$name = 'OpenGrokBot gateway'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  "Removed the task '$name'."
  return
}

$me = "$env:USERDOMAIN\$env:USERNAME"
$script = Join-Path $PSScriptRoot 'start-gateway.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
"Registered '$name': it starts the gateway when you sign in. Start it now with: Start-ScheduledTask -TaskName '$name'"
"Log: $(Join-Path $env:LOCALAPPDATA 'OpenGrokBot\gateway.log')"
