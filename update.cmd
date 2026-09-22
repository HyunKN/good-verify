@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.14 or newer from https://nodejs.org/ first.
  pause
  exit /b 1
)
node scripts/launch.mjs --update
pause
