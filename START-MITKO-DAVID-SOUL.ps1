[CmdletBinding()]
param(
  [switch]$RunTests,
  [switch]$OpenTwins
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$launcher = Join-Path $root 'START-DAVID-SOUL-INSTANCE.ps1'
$legacyProfile = Join-Path $root '.david-system\edge-soul-profile'
$mitkoRoot = Join-Path $root '.david-instances\mitko'
$mitkoProfile = Join-Path $mitkoRoot 'edge-soul-profile'

if (-not (Test-Path -LiteralPath $launcher)) {
  throw 'Missing START-DAVID-SOUL-INSTANCE.ps1.'
}

$mitkoProfileReady = Test-Path -LiteralPath (Join-Path $mitkoProfile 'Default')
if (-not $mitkoProfileReady -and (Test-Path -LiteralPath $legacyProfile)) {
  New-Item -ItemType Directory -Force -Path $mitkoRoot | Out-Null
  if (Test-Path -LiteralPath $mitkoProfile) {
    Remove-Item -LiteralPath $mitkoProfile -Recurse -Force -ErrorAction SilentlyContinue
  }
  Copy-Item -LiteralPath $legacyProfile -Destination $mitkoProfile -Recurse -Force
  Write-Host 'MITKO saved ChatGPT Edge profile was copied into the isolated MITKO server.' -ForegroundColor Green
}

& $launcher `
  -InstanceName 'mitko' `
  -PreferredDebugPort 9333 `
  -RunTests:$RunTests `
  -OpenTwins:$OpenTwins
