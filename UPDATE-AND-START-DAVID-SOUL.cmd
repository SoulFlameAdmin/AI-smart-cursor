@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "DAVID_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%DAVID_POWERSHELL%" set "DAVID_POWERSHELL=powershell.exe"

"%DAVID_POWERSHELL%" -ExecutionPolicy Bypass -File "%~dp0UPDATE-AND-START-DAVID-SOUL.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo DAVID SOUL launcher stopped with exit code %EXIT_CODE%.
  echo Press any key to close...
  pause >nul
)

exit /b %EXIT_CODE%
