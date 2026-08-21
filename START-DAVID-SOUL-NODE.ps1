[CmdletBinding()]
param(
  [switch]$SkipTests,
  [ValidateRange(30, 600)][int]$StartupTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$systemRoot = Join-Path $root '.david-system'
$tempRoot = Join-Path $systemRoot 'temp'
$edgeProfile = Join-Path $systemRoot 'edge-soul-profile'
$statusFile = Join-Path $systemRoot 'soul-status.json'
$envFile = Join-Path $root '.env'
$entryFile = Join-Path $root 'edge-soul-node-main.cjs'
$nodeRuntimeContract = Join-Path $root 'tests\soul-node-runtime-v1.cjs'

function Write-Step {
  param([int]$Number, [int]$Total, [string]$Text)
  Write-Host ("[{0}/{1}] {2}" -f $Number, $Total, $Text) -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Text)
  Write-Host ("[OK] {0}" -f $Text) -ForegroundColor Green
}

function Write-Warn {
  param([string]$Text)
  Write-Host ("[WARN] {0}" -f $Text) -ForegroundColor Yellow
}

function Get-EnvValue {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Test-Path -LiteralPath $envFile)) { return '' }
  $match = Get-Content -LiteralPath $envFile -Encoding UTF8 |
    Where-Object { $_ -match "^\s*(?:export\s+)?$([Regex]::Escape($Name))\s*=" } |
    Select-Object -Last 1
  if (-not $match) { return '' }
  $value = ($match -split '=', 2)[1].Trim()
  if ((($value.StartsWith('"')) -and ($value.EndsWith('"'))) -or (($value.StartsWith("'")) -and ($value.EndsWith("'")))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value.Trim()
}

function Test-SafeChatUrl {
  param([string]$Value)
  return [bool]($Value -match '^https://chatgpt\.com/c/[A-Za-z0-9-]+(?:[/?#].*)?$')
}

function Stop-DedicatedSoulProcesses {
  $targets = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -eq 'node.exe' -and $_.CommandLine -like "*$root*edge-soul-node-main.cjs*") -or
    ($_.Name -eq 'msedge.exe' -and $_.CommandLine -like "*edge-soul-profile*")
  })
  foreach ($process in $targets) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($targets.Count -gt 0) { Start-Sleep -Seconds 2 }
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  DAVID SOUL NODE MODE - ELECTRON FREE' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  Soul -> Edge CDP -> GPT -> Worker -> Soul' -ForegroundColor DarkCyan
Write-Host '  Electron host is not used.' -ForegroundColor DarkGray
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

$totalSteps = 6
Write-Step 1 $totalSteps 'Validating configuration and Node runtime.'
if (-not (Test-Path -LiteralPath $envFile)) { throw 'Missing .env file.' }
if (-not (Test-Path -LiteralPath $entryFile)) { throw 'Missing edge-soul-node-main.cjs.' }
$chatUrl = Get-EnvValue -Name 'DAVID_SOUL_CHAT_URL'
$supabaseUrl = Get-EnvValue -Name 'SUPABASE_URL'
$deviceToken = Get-EnvValue -Name 'DAVID_DEVICE_TOKEN'
if (-not (Test-SafeChatUrl -Value $chatUrl)) { throw 'DAVID_SOUL_CHAT_URL is invalid.' }
if (-not $supabaseUrl) { throw 'SUPABASE_URL is missing from .env.' }
if (-not $deviceToken -or $deviceToken.Length -lt 32) { throw 'DAVID_DEVICE_TOKEN is missing or invalid.' }
$node = Get-Command node -ErrorAction Stop
Write-Ok 'Configuration is present. Secret values were not printed.'

Write-Step 2 $totalSteps 'Preparing persistent Edge profile and D-local temporary files.'
foreach ($directory in @($systemRoot, $tempRoot, $edgeProfile)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:DAVID_EDGE_DEBUG_PORT = '9333'
$env:DAVID_EDGE_PROFILE_DIR = $edgeProfile
$env:DAVID_SOUL_STATUS_FILE = $statusFile
$env:DAVID_SOUL_INSTANCE_ID = 'default'
$env:DAVID_SOUL_AUTO_START = 'false'
Write-Ok 'Persistent login profile is preserved.'

Write-Step 3 $totalSteps 'Stopping only the dedicated DAVID Node/Edge Soul processes.'
Stop-DedicatedSoulProcesses
Write-Ok 'Dedicated Soul runtime is clean.'

Write-Step 4 $totalSteps 'Running electron-free runtime contract.'
if (-not $SkipTests) {
  & $node.Source $nodeRuntimeContract
  if ($LASTEXITCODE -ne 0) { throw "Node runtime contract failed with exit code $LASTEXITCODE." }
  Write-Ok 'DAVID SOUL Node runtime contract passed.'
} else {
  Write-Warn 'Runtime contract skipped by request.'
}

Write-Step 5 $totalSteps 'Starting DAVID SOUL Node runtime in the foreground.'
Write-Host 'Keep this PowerShell window open. Press Ctrl+C to stop DAVID SOUL Node mode.' -ForegroundColor DarkCyan
Write-Host ''

Write-Step 6 $totalSteps 'Live runtime output follows.'
& $node.Source $entryFile
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
if ($code -ne 0) { throw "DAVID SOUL Node runtime stopped with exit code $code." }
