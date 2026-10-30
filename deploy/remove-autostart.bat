@echo off
setlocal EnableExtensions
rem ==========================================================================
rem  Stops the Game Hub and removes its start-with-Windows task.
rem  The games keep running; stop them on the admin page first if needed.
rem  Right-click this file and choose "Run as administrator".
rem  The work is done by autostart.ps1.
rem ==========================================================================
set "TASK=Game Hub"

net session >nul 2>&1 && goto admin_ok
fltmc >nul 2>&1 && goto admin_ok
goto not_admin

:admin_ok
if not exist "%~dp0autostart.ps1" goto no_script
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" -Remove
set "RESULT=%ERRORLEVEL%"
if "%RESULT%"=="0" goto removed
if "%RESULT%"=="5" goto not_installed
goto failed

:removed
echo Done. The Game Hub is stopped and no longer starts with Windows.
goto end

:not_installed
echo The Game Hub is stopped. It was not set to start with Windows.
goto end

:not_admin
echo [ERROR] Not running as administrator.
echo         Right-click remove-autostart.bat and choose "Run as administrator".
goto end

:no_script
echo [ERROR] autostart.ps1 was not found. Keep it next to this file.
goto end

:failed
echo [ERROR] Could not remove the scheduled task "%TASK%". See the message above.

:end
echo.
pause
endlocal
