@echo off
title DAVID Smart Cursor - Build EXE
cd /d "%~dp0.."

call npm install
if errorlevel 1 (
  echo npm install se provali.
  pause
  exit /b 1
)

call npm test
if errorlevel 1 (
  echo Testovete se provaliha.
  pause
  exit /b 1
)

call npm run dist:win
if errorlevel 1 (
  echo Build se provali.
  pause
  exit /b 1
)

echo.
echo Gotovo. Instalatorut e v papka dist.
pause
