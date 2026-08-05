[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://chatgpt\.com/c/[A-Za-z0-9-]+(?:[/?#].*)?$')]
  [string]$ChatUrl,

  [string]$SoulUserId = '1208679e-4466-475b-8a33-3d3f7e9184f3'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$envPath = Join-Path $root '.env'
$systemRoot = Join-Path $root '.david-system'
$backupRoot = Join-Path $systemRoot 'config-backups'
$repairLauncher = Join-Path $root 'REPAIR-AND-START-DAVID-SOUL.ps1'

if (-not (Test-Path -LiteralPath $envPath)) {
  throw 'Missing local .env file. Nothing was changed.'
}
if (-not (Test-Path -LiteralPath $repairLauncher)) {
  throw 'Missing REPAIR-AND-START-DAVID-SOUL.ps1. Update the DAVID hotfix branch first.'
}
if ($SoulUserId -notmatch '^[0-9a-fA-F-]{36}$') {
  throw 'SoulUserId must be a UUID.'
}

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $backupRoot ".env.before-borko-$timestamp"
Copy-Item -LiteralPath $envPath -Destination $backupPath -Force

function Set-LocalEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $lines = @(Get-Content -LiteralPath $envPath -Encoding UTF8)
  $pattern = "^\s*(?:export\s+)?$([Regex]::Escape($Name))\s*="
  $replacement = "$Name=$Value"
  $found = $false

  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match $pattern) {
      $lines[$index] = $replacement
      $found = $true
    }
  }

  if (-not $found) {
    $lines += $replacement
  }

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($envPath, $lines, $utf8)
}

try {
  Set-LocalEnvValue -Name 'DAVID_SOUL_CHAT_URL' -Value $ChatUrl
  Set-LocalEnvValue -Name 'DAVID_SOUL_USER_ID' -Value $SoulUserId

  Write-Host '============================================================' -ForegroundColor Cyan
  Write-Host '  DAVID SOUL - BORKO FIXED CHAT' -ForegroundColor Cyan
  Write-Host '============================================================' -ForegroundColor Cyan
  Write-Host '  User route : Borko SOUL identity' -ForegroundColor DarkCyan
  Write-Host '  GPT route  : private URL supplied only to this local run' -ForegroundColor DarkCyan
  Write-Host '  Progress   : received -> opening -> sending -> thinking -> returned' -ForegroundColor DarkCyan
  Write-Host '============================================================' -ForegroundColor Cyan
  Write-Host ''

  & $repairLauncher
}
finally {
  if (Test-Path -LiteralPath $backupPath) {
    Copy-Item -LiteralPath $backupPath -Destination $envPath -Force
    Write-Host 'Previous DAVID local configuration was restored.' -ForegroundColor Green
  }
}
