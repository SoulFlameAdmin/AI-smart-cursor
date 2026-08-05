[CmdletBinding()]
param(
  [ValidatePattern('^https://chatgpt\.com/c/[A-Za-z0-9-]+(?:[/?#].*)?$')]
  [string]$ChatUrl = '',

  [string]$SoulUserId = '1208679e-4466-475b-8a33-3d3f7e9184f3',

  [switch]$ConfigureOnly,
  [switch]$RunTests,
  [switch]$OpenTwins
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$baseEnv = Join-Path $root '.env'
$instanceRoot = Join-Path $root '.david-instances\borko'
$instanceEnv = Join-Path $instanceRoot 'instance.env'
$launcher = Join-Path $root 'START-DAVID-SOUL-INSTANCE.ps1'

if (-not (Test-Path -LiteralPath $baseEnv)) {
  throw 'Missing base .env file.'
}
if (-not (Test-Path -LiteralPath $launcher)) {
  throw 'Missing START-DAVID-SOUL-INSTANCE.ps1.'
}
if ($SoulUserId -notmatch '^[0-9a-fA-F-]{36}$') {
  throw 'SoulUserId must be a UUID.'
}

New-Item -ItemType Directory -Force -Path $instanceRoot | Out-Null

if ($ChatUrl) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $lines = @(
    "DAVID_SOUL_USER_ID=$SoulUserId",
    "DAVID_SOUL_CHAT_URL=$ChatUrl"
  )
  [System.IO.File]::WriteAllLines($instanceEnv, $lines, $utf8)
  Write-Host 'BORKO DAVID was locked locally to his own SOUL identity and fixed GPT chat.' -ForegroundColor Green
}

if (-not (Test-Path -LiteralPath $instanceEnv)) {
  throw 'Borko is not configured yet. Run once with -ChatUrl using his fixed ChatGPT conversation URL.'
}

if ($ConfigureOnly) { return }

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  BORKO DAVID - ISOLATED SERVER' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  Storage : .david-instances\borko' -ForegroundColor DarkCyan
Write-Host '  Port    : starts from 9444' -ForegroundColor DarkCyan
Write-Host '  Profile : separate saved ChatGPT login' -ForegroundColor DarkCyan
Write-Host '  Queue   : only Borko SOUL messages' -ForegroundColor DarkCyan
Write-Host '============================================================' -ForegroundColor Cyan

& $launcher `
  -InstanceName 'borko' `
  -InstanceEnvFile $instanceEnv `
  -PreferredDebugPort 9444 `
  -RunTests:$RunTests `
  -OpenTwins:$OpenTwins
