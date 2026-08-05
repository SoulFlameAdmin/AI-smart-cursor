[CmdletBinding()]
param(
  [switch]$RunTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$coordinator = Join-Path $root 'david-soul-node-coordinator.cjs'
$stopScript = Join-Path $root 'STOP-DAVID-SOUL-LIGHT.ps1'
$legacyProfile = Join-Path $root '.david-system\edge-soul-profile'
$mitkoRoot = Join-Path $root '.david-instances\mitko'
$mitkoProfile = Join-Path $mitkoRoot 'edge-soul-profile'

function Find-NodeExecutable {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) {
    $resolved = [string]$command.Definition
    if ($resolved -and (Test-Path -LiteralPath $resolved)) { return $resolved }
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }

  throw 'Node.js was not found. Install Node.js 22 or newer.'
}

if (-not (Test-Path -LiteralPath $coordinator)) {
  throw 'Missing david-soul-node-coordinator.cjs.'
}
if (-not (Test-Path -LiteralPath (Join-Path $root '.env'))) {
  throw 'Missing base .env file.'
}

$node = Find-NodeExecutable
$versionText = (& $node --version).Trim()
if ($versionText -notmatch '^v([0-9]+)\.') {
  throw "Could not read the Node.js version: $versionText"
}
if ([int]$Matches[1] -lt 22) {
  throw "DAVID SOUL Light requires Node.js 22 or newer. Found: $versionText"
}

if (Test-Path -LiteralPath $stopScript) {
  & $stopScript -Quiet
}

$mitkoReady = Test-Path -LiteralPath (Join-Path $mitkoProfile 'Default')
if (-not $mitkoReady -and (Test-Path -LiteralPath $legacyProfile)) {
  New-Item -ItemType Directory -Force -Path $mitkoRoot | Out-Null
  if (-not (Test-Path -LiteralPath $mitkoProfile)) {
    Copy-Item -LiteralPath $legacyProfile -Destination $mitkoProfile -Recurse -Force
    Write-Host 'MITKO saved Edge login profile was copied into the light coordinator.' -ForegroundColor Green
  }
}

if ($RunTests) {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction Stop }
  & ([string]$npmCommand.Definition) test
  if ($LASTEXITCODE -ne 0) { throw 'DAVID tests failed.' }
}

Write-Host '============================================================' -ForegroundColor Green
Write-Host '  DAVID SOUL LIGHT - ONE NODE COORDINATOR' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host "  Node       : $versionText"
Write-Host '  Electron   : not used'
Write-Host '  MITKO      : separate owner, Edge profile and fixed chat'
Write-Host '  BORKO      : separate owner, Edge profile and fixed chat'
Write-Host '  New users  : auto-loaded from .david-instances\<name>\instance.env'
Write-Host '  Stop       : Ctrl+C'
Write-Host '============================================================' -ForegroundColor Green

& $node $coordinator
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
  throw "DAVID SOUL Light stopped with exit code $exitCode."
}
