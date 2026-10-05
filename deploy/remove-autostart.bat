@echo off
setlocal EnableExtensions
rem ==========================================================================
rem  Stops the Game Hub and removes its start-with-Windows task.
rem  The games keep running; stop them on the admin page first if needed.
rem  Right-click this file and choose "Run as administrator".
rem ==========================================================================
set "TASK=Game Hub"

net session >nul 2>&1 && goto admin_ok
fltmc >nul 2>&1 && goto admin_ok
goto not_admin

:admin_ok
pushd "%~dp0"
schtasks /end /tn "%TASK%" >nul 2>&1
set "HUBPID="
if exist "hub.pid" set /p HUBPID=<hub.pid
if defined HUBPID taskkill /pid %HUBPID% /f >nul 2>&1
schtasks /query /tn "%TASK%" >nul 2>&1 || goto not_installed
schtasks /delete /tn "%TASK%" /f >nul || goto failed
echo Done. The Game Hub is stopped and no longer starts with Windows.
goto end

:not_installed
echo The Game Hub is stopped. It was not set to start with Windows.
goto end

:not_admin
echo [ERROR] Not running as administrator.
echo         Right-click remove-autostart.bat and choose "Run as administrator".
goto end

:failed
echo [ERROR] Could not remove the scheduled task "%TASK%".

:end
popd
echo.
pause
endlocal
