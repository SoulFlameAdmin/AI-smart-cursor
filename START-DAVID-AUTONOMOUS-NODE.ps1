[CmdletBinding()]
param(
  [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$node = Get-Command node -ErrorAction Stop
$patch = Join-Path $root 'core\david-thinker-cdp-stability-v1.cjs'
$keeper = Join-Path $root 'core\david-thinker-node-keeper.cjs'
$soulLauncher = Join-Path $root 'START-DAVID-SOUL-NODE.ps1'
$thinkerProfile = Join-Path $root '.david-instances\david\edge-soul-profile'
$thinkerLogs = Join-Path $root '.david-instances\david\logs'
$thinkerOut = Join-Path $thinkerLogs 'thinker-node-out.log'
$thinkerErr = Join-Path $thinkerLogs 'thinker-node-error.log'

foreach ($required in @($patch, $keeper, $soulLauncher)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing DAVID autonomous runtime file: $required"
  }
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  DAVID AUTONOMOUS NODE MODE' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  SOUL    : 9333' -ForegroundColor DarkCyan
Write-Host '  THINKER : 9444' -ForegroundColor DarkCyan
Write-Host '  Electron host: OFF' -ForegroundColor DarkGray
Write-Host '============================================================' -ForegroundColor Cyan

Write-Host '[1/5] Cleaning stale Thinker worker/keeper processes.' -ForegroundColor Cyan
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
Where-Object {
  ($_.Name -eq 'node.exe' -and (
    $_.CommandLine -like '*david-thinker-node-keeper.cjs*' -or
    $_.CommandLine -like '*david-thinker-worker.cjs*'
  )) -or
  ($_.Name -eq 'msedge.exe' -and (
    $_.CommandLine -like '*--remote-debugging-port=9444*' -or
    $_.CommandLine -like "*$thinkerProfile*"
  ))
} |
ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Write-Host '[OK] Thinker runtime is clean.' -ForegroundColor Green

Write-Host '[2/5] Installing Thinker CDP stability preload.' -ForegroundColor Cyan
$preload = "--require=$patch"
$existingNodeOptions = [string]$env:NODE_OPTIONS
if ($existingNodeOptions -notmatch [Regex]::Escape($patch)) {
  $env:NODE_OPTIONS = ($existingNodeOptions + ' ' + $preload).Trim()
}
Write-Host '[OK] Optional Page.enable/Runtime.enable will not block Thinker rounds.' -ForegroundColor Green

Write-Host '[3/5] Running autonomous runtime contracts.' -ForegroundColor Cyan
if (-not $SkipTests) {
  & $node.Source (Join-Path $root 'tests\thinker-cdp-stability-v1.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Thinker CDP stability contract failed.' }
  & $node.Source (Join-Path $root 'tests\autonomous-thinker-bootstrap-v1.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Thinker bootstrap contract failed.' }
  & $node.Source (Join-Path $root 'tests\autonomous-orchestrator-v1.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Autonomous orchestrator contract failed.' }
  & $node.Source (Join-Path $root 'tests\autonomous-soul-routing-v1.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Autonomous Soul routing contract failed.' }
} else {
  Write-Host '[WARN] Contracts skipped by request.' -ForegroundColor Yellow
}

Write-Host '[4/5] Starting dedicated Thinker Node keeper on 9444.' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $thinkerLogs | Out-Null
$thinker = Start-Process -FilePath $node.Source `
  -ArgumentList @($keeper) `
  -WorkingDirectory $root `
  -RedirectStandardOutput $thinkerOut `
  -RedirectStandardError $thinkerErr `
  -PassThru
Write-Host "[OK] Thinker keeper PID $($thinker.Id) started." -ForegroundColor Green
Write-Host 'If Edge asks for ChatGPT login, finish it once. Do not press Send manually.' -ForegroundColor Yellow

$deadline = (Get-Date).AddSeconds(120)
$portReady = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $portReady = [bool](Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9444 -State Listen -ErrorAction SilentlyContinue)
  if ($portReady) { break }
  if ($thinker.HasExited) { break }
}
if ($portReady) {
  Write-Host '[OK] Thinker debug port 9444 is listening.' -ForegroundColor Green
} else {
  Write-Host '[WARN] Thinker 9444 is not ready yet. Check the Edge login window; autonomous bootstrap will keep checking.' -ForegroundColor Yellow
}

Write-Host '[5/5] Starting SOUL Node on 9333.' -ForegroundColor Cyan
Write-Host 'Keep this PowerShell open. Ctrl+C stops SOUL; Thinker can be restarted automatically.' -ForegroundColor DarkCyan

if ($SkipTests) {
  & $soulLauncher -SkipTests
} else {
  & $soulLauncher
}
