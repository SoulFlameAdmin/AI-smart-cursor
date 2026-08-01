$ErrorActionPreference = "Stop"

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
Set-Location $Project

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500

if (-not (Test-Path ".\node_modules\electron\dist\electron.exe")) {
    throw "Electron binary липсва."
}

if (-not (Test-Path ".\node_modules\dotenv\package.json")) {
    throw "dotenv липсва. Изпълни npm install."
}

$env:NODE_OPTIONS = "--max-old-space-size=2048"

& node.exe --check ".\main.cjs"
if ($LASTEXITCODE -ne 0) {
    throw "main.cjs има синтактична грешка."
}

& node.exe --check ".\preload.cjs"
if ($LASTEXITCODE -ne 0) {
    throw "preload.cjs има синтактична грешка."
}

& node.exe --check ".\renderer\renderer.js"
if ($LASTEXITCODE -ne 0) {
    throw "renderer.js има синтактична грешка."
}

& npm.cmd test
if ($LASTEXITCODE -ne 0) {
    throw "DAVID tests се провалиха."
}

Write-Host ""
Write-Host "DAVID Overlay v2 стартира..." -ForegroundColor Green
Write-Host "Ctrl+Shift+D за команда." -ForegroundColor Cyan
Write-Host ""

& npm.cmd start
