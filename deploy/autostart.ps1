# Sets up (or with -Remove takes away) the scheduled task "Game Hub". install-autostart.bat and
# remove-autostart.bat run this as administrator. Plain ASCII on purpose, like the .bat files.
#
# The task runs node.exe dist\service.js directly, with no batch file in between: the service keeps the hub
# running and ignores the Ctrl+C a Node.js update sends, so nothing can be left waiting at "Terminate batch
# job (Y/N)?". A second trigger starts the task every 5 minutes; while it runs that start is ignored, so it
# only brings the service back if it was ever stopped some other way.
#
# Exit codes: 3 = this folder is on a network drive, 4 = the task was made but the hub is not answering,
# 5 = -Remove found no task.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$task = 'Game Hub'
$dir = $PSScriptRoot.TrimEnd('\') + '\'

# Ends the process a pid file names, but only while it is still the node.exe running that script.
function Stop-FromPidFile([string]$name, [string]$script) {
  $file = $dir + $name
  if (-not (Test-Path $file)) { return }
  $id = 0
  if (-not [int]::TryParse((Get-Content $file -Raw).Trim(), [ref]$id)) { return }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -like "*$script*") {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped the running $script (pid $id)."
  }
}

if ([System.IO.DriveInfo]::new($dir.Substring(0, 1)).DriveType -eq 'Network') { exit 3 }

# The task that runs now and what it started: the service first, or it would start the hub again.
# The games keep running; the next hub takes them back.
$old = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if ($old) { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue }
Stop-FromPidFile 'service.pid' 'service.js'
Stop-FromPidFile 'hub.pid' 'hub.js'

if ($Remove) {
  if (-not $old) { exit 5 }
  Unregister-ScheduledTask -TaskName $task -Confirm:$false
  exit 0
}

$node = (Get-Command node.exe).Source
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $dir + 'dist\service.js"') -WorkingDirectory $dir
$boot = New-ScheduledTaskTrigger -AtStartup
$check = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName $task -Action $action -Trigger @($boot, $check) -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $task

# When everything works the hub answers on its port within a few seconds.
$port = 4300
$cfg = $dir + 'hub.config.json'
if (Test-Path $cfg) {
  try { $p = (Get-Content $cfg -Raw | ConvertFrom-Json).port; if ($p) { $port = [int]$p } } catch { }
}
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ('http://localhost:' + $port + '/api/status') | Out-Null
    $ok = $true
  } catch { }
}
$state = (Get-ScheduledTask -TaskName $task).State
Write-Host ('Task runs ' + $node + ' as ' + $me + ', state ' + $state + ', hub answers on port ' + $port + ': ' + $ok)
if ($state -ne 'Running' -or -not $ok) { exit 4 }
exit 0
