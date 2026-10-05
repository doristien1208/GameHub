@echo off
setlocal EnableExtensions
rem ==========================================================================
rem  Makes the Game Hub start with Windows, and starts it now.
rem  It becomes the scheduled task "Game Hub": runs as the account that runs
rem  this file (no password stored, no window, nobody needs to log on), no
rem  time limit, tried again every minute if it fails. Not SYSTEM: SYSTEM may
rem  not be allowed into the game folders (the task then ends with result 1).
rem  Close the Game Hub window first if start-hub.bat is open.
rem  Right-click this file and choose "Run as administrator" (only once).
rem  Undo with remove-autostart.bat.
rem ==========================================================================
set "TASK=Game Hub"
set "HUB_DIR=%~dp0"

net session >nul 2>&1 && goto admin_ok
fltmc >nul 2>&1 && goto admin_ok
goto not_admin

:admin_ok
if not exist "%HUB_DIR%dist\hub.js" goto no_dist
if "%HUB_DIR:~0,2%"=="\\" goto network_path
rem Exit codes: 3 = the folder is on a network drive, 4 = the task was made but is not running.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $d = $env:HUB_DIR; if ([System.IO.DriveInfo]::new($d.Substring(0,1)).DriveType -eq 'Network') { exit 3 }; $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $a = New-ScheduledTaskAction -Execute ($d + 'start-hub.bat') -Argument 'service' -WorkingDirectory $d; $t = New-ScheduledTaskTrigger -AtStartup; $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; $p = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Highest; Register-ScheduledTask -TaskName $env:TASK -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null; Start-ScheduledTask -TaskName $env:TASK; Start-Sleep -Seconds 8; $state = (Get-ScheduledTask -TaskName $env:TASK).State; $last = (Get-ScheduledTaskInfo -TaskName $env:TASK).LastTaskResult; Write-Host ('Task runs as ' + $me + ', state ' + $state + ', last result ' + $last); if ($state -ne 'Running') { exit 4 }"
set "RESULT=%ERRORLEVEL%"
if "%RESULT%"=="0" goto started
if "%RESULT%"=="3" goto network_path
if "%RESULT%"=="4" goto not_started
goto failed

:started
echo Done. The Game Hub is running now and starts with Windows.
echo Open http://localhost:4300 in a browser (the port is in hub.config.json).
goto end

:not_started
echo [ERROR] The task "%TASK%" was created, but the Game Hub did not keep running.
echo         See logs\launcher.log and logs\hub.log in this folder, or double-click
echo         start-hub.bat to see the error on screen.
goto end

:not_admin
echo [ERROR] Not running as administrator.
echo         Right-click install-autostart.bat and choose "Run as administrator".
goto end

:no_dist
echo [ERROR] dist\hub.js was not found. Keep this file next to the "dist" folder.
goto end

:network_path
echo [ERROR] This folder is on a network drive: %HUB_DIR%
echo         Run this file from the folder on this PC's own disk, for example D:\...\GameHub
goto end

:failed
echo [ERROR] Could not create the scheduled task "%TASK%". See the message above.

:end
echo.
pause
endlocal
