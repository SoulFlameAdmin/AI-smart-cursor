@echo off
setlocal EnableExtensions
chcp 65001 >nul

cd /d "%~dp0"

echo.
echo ================================================
echo   DAVID SOUL - UPDATE AND START
echo ================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is not installed or is not in PATH.
  goto :fail
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell is not available.
  goto :fail
)

if not exist ".git" (
  echo [ERROR] This file must be run from the DAVID Git repository.
  goto :fail
)

for /f "delims=" %%I in ('git status --porcelain --untracked-files=no') do (
  echo [STOP] DAVID has local tracked changes.
  echo Commit or restore them before updating, so nothing is lost.
  git status --short
  goto :fail
)

echo [1/5] Fetching the latest DAVID SOUL branch...
git fetch origin feature/david-soul-relay-v1
if errorlevel 1 goto :gitfail

echo [2/5] Switching to feature/david-soul-relay-v1...
git checkout feature/david-soul-relay-v1
if errorlevel 1 (
  git checkout -b feature/david-soul-relay-v1 --track origin/feature/david-soul-relay-v1
  if errorlevel 1 goto :gitfail
)

echo [3/5] Applying the latest tested version...
git merge --ff-only origin/feature/david-soul-relay-v1
if errorlevel 1 goto :gitfail

echo [4/5] Verifying DAVID...
call npm test
if errorlevel 1 (
  echo [ERROR] DAVID tests failed. The server was not started.
  goto :fail
)

echo [5/5] Starting DAVID Electron SOUL relay...
echo Soul itself does not use PowerShell. This launcher only updates and starts Electron.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0START-DAVID-E-DRIVE.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [ERROR] DAVID stopped with exit code %EXIT_CODE%.
  goto :fail
)

echo.
echo DAVID SOUL finished normally.
exit /b 0

:gitfail
echo.
echo [ERROR] Git update failed. No files were force-overwritten.
goto :fail

:fail
echo.
echo Press any key to close...
pause >nul
exit /b 1
