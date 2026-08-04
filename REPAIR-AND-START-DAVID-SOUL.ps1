[CmdletBinding()]
param(
  [switch]$SkipTests,
  [switch]$NoOpenTwins,
  [string]$TwinsUrl = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$systemRoot = Join-Path $root '.david-system'
$logsRoot = Join-Path $systemRoot 'logs'
$tempRoot = Join-Path $systemRoot 'temp'
$startScript = Join-Path $root 'START-DAVID-SOUL-MODE.ps1'
$stopScript = Join-Path $root 'STOP-DAVID-SOUL-MODE.ps1'

New-Item -ItemType Directory -Path $systemRoot -Force | Out-Null
New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

Write-Host 'DAVID SOUL repair start' -ForegroundColor Cyan
Write-Host 'The persistent Edge profile and saved ChatGPT login will be preserved.' -ForegroundColor DarkGray

if (Test-Path -LiteralPath $stopScript) {
  try {
    & $stopScript
  } catch {
    Write-Host 'The previous DAVID process was already stopped or incomplete. Continuing safely.' -ForegroundColor Yellow
  }
}

if (-not (Test-Path -LiteralPath $startScript)) {
  throw "START-DAVID-SOUL-MODE.ps1 was not found in $root"
}

$arguments = @{}
if ($SkipTests) { $arguments.SkipTests = $true }
if ($NoOpenTwins) { $arguments.NoOpenTwins = $true }
if ($TwinsUrl) { $arguments.TwinsUrl = $TwinsUrl }

try {
  & $startScript @arguments
} catch {
  $message = [string]$_.Exception.Message
  if ($message -match '^DAVID SOUL stopped with exit code\s*\.$') {
    Write-Host 'DAVID SOUL was stopped normally.' -ForegroundColor Yellow
    return
  }
  throw
}
