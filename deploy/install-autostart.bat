@echo off
setlocal EnableExtensions
rem ==========================================================================
rem  Makes the Game Hub start with Windows, and starts it now.
rem  It becomes the scheduled task "Game Hub": runs "node dist\service.js" as
rem  the account that runs this file (no password stored, no window, nobody
rem  needs to log on), no time limit. The service keeps the hub running and
rem  starts it again within seconds when it stops (also after a Node.js
rem  update); the task is also started every 5 minutes in case the service
rem  itself was stopped. Not SYSTEM: SYSTEM may not be allowed into the game
rem  folders (the task then ends with result 1).
rem  Running it again replaces the task; the games keep running.
rem  Right-click this file and choose "Run as administrator".
rem  Undo with remove-autostart.bat. The work is done by autostart.ps1.
rem ==========================================================================
set "TASK=Game Hub"
set "HUB_DIR=%~dp0"

net session >nul 2>&1 && goto admin_ok
fltmc >nul 2>&1 && goto admin_ok
goto not_admin

:admin_ok
if not exist "%HUB_DIR%dist\service.js" goto no_dist
if not exist "%HUB_DIR%autostart.ps1" goto no_script
if "%HUB_DIR:~0,2%"=="\\" goto network_path
powershell -NoProfile -ExecutionPolicy Bypass -File "%HUB_DIR%autostart.ps1"
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
echo [ERROR] The task "%TASK%" was created, but the Game Hub is not answering.
echo         See logs\launcher.log and logs\hub.log in this folder, or double-click
echo         start-hub.bat to see the error on screen.
goto end

:not_admin
echo [ERROR] Not running as administrator.
echo         Right-click install-autostart.bat and choose "Run as administrator".
goto end

:no_dist
echo [ERROR] dist\service.js was not found. Keep this file next to the "dist" folder.
goto end

:no_script
echo [ERROR] autostart.ps1 was not found. Keep it next to this file.
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
