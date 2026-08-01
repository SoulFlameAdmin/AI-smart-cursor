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
    Write-Host "Първо изпълни: npx install-electron --no"
    exit 1
}

$env:NODE_OPTIONS = "--max-old-space-size=2048"

Write-Host "Стартирам DAVID..." -ForegroundColor Cyan
& npm.cmd start
