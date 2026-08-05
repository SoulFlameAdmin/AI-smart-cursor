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
if (-not (Test-Path -LiteralPath $launcher)) {
  throw 'Missing START-DAVID-SOUL-INSTANCE.ps1.'
}

& $launcher `
  -InstanceName 'mitko' `
  -PreferredDebugPort 9333 `
  -RunTests:$RunTests `
  -OpenTwins:$OpenTwins
