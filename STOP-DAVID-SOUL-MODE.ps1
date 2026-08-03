[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$systemRoot = Join-Path $root '.david-system'
$modeFile = Join-Path $systemRoot 'mode.json'
$workerPidFile = Join-Path $systemRoot 'david-soul.pid'
$twinsPidFile = Join-Path $systemRoot 'twins.pid'
$edgeProfile = Join-Path $systemRoot 'edge-soul-profile'

function Stop-Id {
  param([int]$Id)
  if ($Id -gt 0) {
    Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
  }
}

function Close-DavidEdgeGracefully {
  param([int]$DebugPort)

  if ($DebugPort -le 0) { return }

  try {
    $targets = @(Invoke-RestMethod `
      -Uri "http://127.0.0.1:$DebugPort/json/list" `
      -Method Get `
      -TimeoutSec 3)

    foreach ($target in $targets) {
      if (-not $target.id) { continue }
      try {
        Invoke-RestMethod `
          -Uri "http://127.0.0.1:$DebugPort/json/close/$($target.id)" `
          -Method Get `
          -TimeoutSec 3 | Out-Null
      } catch {}
    }

    # Give Edge time to flush the persistent ChatGPT cookies and profile data.
    Start-Sleep -Seconds 3
  } catch {}
}

$debugPort = 0
if (Test-Path -LiteralPath $modeFile) {
  try {
    $mode = Get-Content -LiteralPath $modeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
      $mode.PSObject.Properties.Name -contains 'debug_address' -and
      [string]$mode.debug_address -match ':(\d+)$'
    ) {
      $debugPort = [int]$Matches[1]
    }
  } catch {}
}

# Stop the worker and local Twins server first. The Edge profile stays alive
# long enough to save the current ChatGPT login.
foreach ($pidFile in @($workerPidFile, $twinsPidFile)) {
  if (Test-Path -LiteralPath $pidFile) {
    $processId = 0
    [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue), [ref]$processId) | Out-Null
    Stop-Id -Id $processId
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}

Close-DavidEdgeGracefully -DebugPort $debugPort

# Force-stop only a remaining dedicated DAVID Edge process. Normal Edge
# windows are never matched by this profile/port filter.
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -like "*$edgeProfile*" -or
    $_.CommandLine -like '*edge-soul-profile*' -or
    ($debugPort -gt 0 -and $_.CommandLine -like "*--remote-debugging-port=$debugPort*")
  } |
  ForEach-Object { Stop-Id -Id $_.ProcessId }

if (Test-Path -LiteralPath $modeFile) {
  try {
    $mode = Get-Content -LiteralPath $modeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $mode.state = 'stopped'
    $mode.login_profile = 'preserved'
    $mode.updated_at = (Get-Date).ToUniversalTime().ToString('o')
    $mode | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $modeFile -Encoding UTF8
  } catch {}
}

Write-Host 'DAVID SOUL mode stopped. The saved ChatGPT login profile was preserved.' -ForegroundColor Green
Write-Host 'Normal Edge windows were not touched.' -ForegroundColor Green
