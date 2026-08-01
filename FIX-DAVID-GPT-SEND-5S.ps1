$ErrorActionPreference = "Stop"

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
$Builtins = Join-Path $Project "core\builtin-skills.cjs"

if (-not (Test-Path $Builtins)) {
    throw "Не намирам вградения skill: $Builtins"
}

Set-Location $Project

Write-Host ""
Write-Host "=== DAVID GPT SEND DELAY 5s ===" -ForegroundColor Cyan
Write-Host "Спирам старите DAVID процеси..." -ForegroundColor Yellow

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item `
    $Builtins `
    "$Builtins.backup-send-delay-$Stamp" `
    -Force

$Code = Get-Content $Builtins -Raw

$OldBlock = @'
      {
        action: "wait",
        milliseconds: 300
      },
      {
        action: "browser_press_key",
        key: "ENTER"
      },
'@

$NewBlock = @'
      {
        action: "wait",
        milliseconds: 5000
      },
      {
        action: "browser_wait_selector",
        selector:
          "button[data-testid='send-button']:not([disabled]), " +
          "button[aria-label='Send prompt']:not([disabled]), " +
          "button[aria-label='Изпращане на подкана']:not([disabled]), " +
          "button[aria-label='Send message']:not([disabled])",
        timeout_ms: 15000
      },
      {
        action: "browser_click_selector",
        selector:
          "button[data-testid='send-button']:not([disabled]), " +
          "button[aria-label='Send prompt']:not([disabled]), " +
          "button[aria-label='Изпращане на подкана']:not([disabled]), " +
          "button[aria-label='Send message']:not([disabled])"
      },
'@

if ($Code.Contains($OldBlock)) {
    $Code = $Code.Replace($OldBlock, $NewBlock)
}
elseif (
    $Code -match 'milliseconds:\s*5000' -and
    $Code -match "data-testid='send-button'"
) {
    Write-Host "Поправката вече е приложена." -ForegroundColor Yellow
}
else {
    throw "Не намерих стария Send блок в builtin-skills.cjs."
}

Set-Content $Builtins $Code -Encoding UTF8

Write-Host "Проверявам JavaScript..." -ForegroundColor Cyan

& node.exe --check $Builtins

if ($LASTEXITCODE -ne 0) {
    throw "builtin-skills.cjs има синтактична грешка."
}

& npm.cmd test

if ($LASTEXITCODE -ne 0) {
    throw "DAVID tests се провалиха."
}

Write-Host ""
Write-Host "ГОТОВО: DAVID чака 5 секунди и натиска Send." -ForegroundColor Green
Write-Host ""

Set-ExecutionPolicy -Scope Process Bypass -Force

if (Test-Path ".\START-DAVID-V2.ps1") {
    & ".\START-DAVID-V2.ps1"
}
elseif (Test-Path ".\START-DAVID-STABLE.ps1") {
    & ".\START-DAVID-STABLE.ps1"
}
else {
    & npm.cmd start
}
