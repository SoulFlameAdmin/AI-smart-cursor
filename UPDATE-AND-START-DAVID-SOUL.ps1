$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'START-DAVID-SOUL-MODE.ps1'
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing launcher: $launcher"
}
& $launcher -Update @args
