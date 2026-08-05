[CmdletBinding()]
param(
  [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$instancesRoot = Join-Path $root '.david-instances'
$pidFile = Join-Path $instancesRoot 'coordinator.pid'
$statusFile = Join-Path $instancesRoot 'coordinator-status.json'

function Stop-ProcessSafe {
  param([int]$Id)
  if ($Id -gt 0) {
    Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
  }
}

if (Test-Path -LiteralPath $pidFile) {
  $coordinatorPid = 0
  [int]::TryParse(
    (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue),
    [ref]$coordinatorPid
  ) | Out-Null
  Stop-ProcessSafe -Id $coordinatorPid
}

Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { ([string]$_.CommandLine) -like '*--david-soul-instance=*' } |
  ForEach-Object { Stop-ProcessSafe -Id $_.ProcessId }

$profiles = New-Object System.Collections.Generic.List[string]
$ports = New-Object System.Collections.Generic.List[int]

if (Test-Path -LiteralPath $instancesRoot) {
  Get-ChildItem -LiteralPath $instancesRoot -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
      $profiles.Add((Join-Path $_.FullName 'edge-soul-profile'))
    }
}

if (Test-Path -LiteralPath $statusFile) {
  try {
    $status = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($item in @($status.instances)) {
      $port = 0
      if ([int]::TryParse([string]$item.port, [ref]$port) -and $port -gt 0) {
        $ports.Add($port)
      }
    }
  } catch {}
}

foreach ($fallbackPort in @(9333, 9444)) {
  if (-not $ports.Contains($fallbackPort)) { $ports.Add($fallbackPort) }
}

Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $command = [string]$_.CommandLine
    $matched = $false
    foreach ($profile in $profiles) {
      if ($profile -and $command.Contains($profile)) { $matched = $true; break }
    }
    if (-not $matched) {
      foreach ($port in $ports) {
        if ($command.Contains("--remote-debugging-port=$port")) { $matched = $true; break }
      }
    }
    $matched
  } |
  ForEach-Object { Stop-ProcessSafe -Id $_.ProcessId }

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

if (-not $Quiet) {
  Write-Host 'DAVID SOUL Light and only its dedicated Edge sessions were stopped.' -ForegroundColor Green
}
