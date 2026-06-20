@echo off
REM Double-click to promote your current code into the installed app (local only).
cd /d "%~dp0"
call npm run promote
echo.
pause
