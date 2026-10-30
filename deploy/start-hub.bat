@echo off
setlocal EnableExtensions
rem ==========================================================================
rem  Game Hub launcher for Windows
rem
rem  Double-click to run it in a window. The scheduled task made by
rem  install-autostart.bat runs "node dist\service.js" instead (no window);
rem  an older task that still runs "start-hub.bat service" gets the same.
rem  Needs Node.js 24. Settings: hub.config.json (made on first start).
rem  Colleagues open  http://<this PC's IP>:4300  (the port is in the config).
rem
rem  Plain ASCII on purpose: it runs the same whatever encoding an editor
rem  saves it in. Every step is written to logs\launcher.log.
rem ==========================================================================

set "MODE=%~1"
if /i "%MODE%"=="service" goto main
rem Re-run inside "cmd /k" so this window stays open even after an error.
if "%HUB_INNER%"=="1" goto main
set "HUB_INNER=1"
cmd /k ""%~f0" %*"
exit /b

:main
pushd "%~dp0" || goto no_folder
if not exist "logs" mkdir "logs"
set "LOG=%CD%\logs\launcher.log"
call :log "=== launcher started in %CD% (mode %MODE%)"
title Game Hub

where node >>"%LOG%" 2>&1 || goto no_node
set "NODE_VERSION="
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
call :log "node version %NODE_VERSION%"
if not exist "dist\hub.js" goto no_dist
if /i "%MODE%"=="service" goto service

:run
echo.
echo Starting the Game Hub ... Close this window or press Ctrl+C to stop it.
echo The games keep running when the hub stops; the next start takes them back.
call :log "starting hub"
call node dist\hub.js
set "CODE=%ERRORLEVEL%"
call :log "hub exited with code %CODE%"
if "%CODE%"=="2" goto port_busy
if "%CODE%"=="3" goto bad_config
echo.
echo [Game Hub] Restarting in 5 seconds ...
ping -n 6 127.0.0.1 >nul
goto run

:port_busy
echo [ERROR] The hub port is already in use. Is the hub already running? See logs\hub.log
goto done

:bad_config
echo [ERROR] hub.config.json has a mistake. See logs\hub.log, fix the file, and start again.
goto done

:service
rem No restart loop here: after a Ctrl+C (a Node.js update sends one) a batch loop waits at
rem "Terminate batch job (Y/N)?" with nobody to answer. dist\service.js restarts the hub itself
rem and ignores Ctrl+C. Re-run install-autostart.bat to drop this batch from the task altogether.
if not exist "dist\service.js" goto no_dist
call :log "starting service"
call node dist\service.js
call :log "service exited with code %ERRORLEVEL%"
goto done

:log
>>"%LOG%" echo [%date% %time%] %~1
exit /b 0

:no_folder
echo [ERROR] Cannot open the folder of this file: "%~dp0"
goto done

:no_node
call :log "error: node not found"
echo [ERROR] Node.js was not found. Install Node.js 24 from https://nodejs.org/
echo         then close this window and run this file again.
goto done

:no_dist
call :log "error: dist\hub.js missing"
echo [ERROR] dist\hub.js was not found. Keep this file next to the "dist" folder.
goto done

:done
popd
endlocal
exit /b 1
