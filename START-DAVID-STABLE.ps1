$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path ".\node_modules\electron\dist\electron.exe")) {
    Write-Host "Electron binary липсва." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path ".\node_modules\dotenv\package.json")) {
    Write-Host "dotenv липсва. Изпълни npm install." -ForegroundColor Red
    exit 1
}

$env:NODE_OPTIONS = "--max-old-space-size=2048"

Write-Host "Проверявам DAVID..." -ForegroundColor Cyan
& npm.cmd test

if ($LASTEXITCODE -ne 0) {
    throw "DAVID test се провали."
}

Write-Host "Стартирам DAVID..." -ForegroundColor Green
& npm.cmd start
