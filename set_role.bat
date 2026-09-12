@echo off
REM Local testing helper — change a user's role in the Railway database so you
REM can test role-gated features (Cancel = Manager/Quality/Admin, Re-open =
REM Admin only) without a second login. The app UI won't let you change your
REM OWN role, so this does it at the database level. Just double-click.
REM
REM NOTE: this is a LOCAL DEV TOOL, not part of the app. Safe to leave
REM uncommitted (add to .gitignore if you prefer).

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\set_role.ps1"

echo.
echo ================================================================
echo  Script finished. Window will stay open. Press any key to close.
echo ================================================================
pause >nul
