@echo off
title DAVID Smart Cursor - Install and Run
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ne e instaliran. Instalirai Node.js LTS i pusni otnovo.
  pause
  exit /b 1
)

if not exist ".env" copy ".env.example" ".env" >nul

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

call npm start
