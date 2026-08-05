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
$deviceName = 'DAVID-BORKO-01'

function Read-EnvMap {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }

  foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $name = $Matches[1]
      $value = $Matches[2].Trim()
      if (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
      ) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $map[$name] = $value
    }
  }
  return $map
}

function New-DeviceToken {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Value)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha.ComputeHash($bytes)
    return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $sha.Dispose()
  }
}

function Save-InstanceConfig {
  param(
    [Parameter(Mandatory = $true)][string]$FixedChatUrl,
    [Parameter(Mandatory = $true)][string]$DeviceToken
  )

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $lines = @(
    "DAVID_SOUL_USER_ID=$SoulUserId",
    "DAVID_SOUL_CHAT_URL=$FixedChatUrl",
    "DAVID_DEVICE_TOKEN=$DeviceToken"
  )
  [System.IO.File]::WriteAllLines($instanceEnv, $lines, $utf8)
}

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

$baseConfig = Read-EnvMap -Path $baseEnv
$instanceConfig = Read-EnvMap -Path $instanceEnv
$fixedChatUrl = if ($ChatUrl) { $ChatUrl } elseif ($instanceConfig.ContainsKey('DAVID_SOUL_CHAT_URL')) {
  [string]$instanceConfig['DAVID_SOUL_CHAT_URL']
} else { '' }

if ($fixedChatUrl -notmatch '^https://chatgpt\.com/c/[A-Za-z0-9-]+(?:[/?#].*)?$') {
  throw 'Borko is not configured. Run once with -ChatUrl using his fixed ChatGPT conversation URL.'
}

$borkoDeviceToken = if ($instanceConfig.ContainsKey('DAVID_DEVICE_TOKEN')) {
  [string]$instanceConfig['DAVID_DEVICE_TOKEN']
} else { '' }

if (-not $borkoDeviceToken -or $borkoDeviceToken.Length -lt 32) {
  $supabaseUrl = if ($baseConfig.ContainsKey('SUPABASE_URL')) { [string]$baseConfig['SUPABASE_URL'] } else { '' }
  $primaryToken = if ($baseConfig.ContainsKey('DAVID_DEVICE_TOKEN')) { [string]$baseConfig['DAVID_DEVICE_TOKEN'] } else { '' }
  $bridgeFunction = if ($baseConfig.ContainsKey('DAVID_DEVICE_BRIDGE_FUNCTION')) {
    [string]$baseConfig['DAVID_DEVICE_BRIDGE_FUNCTION']
  } else { 'david-soul-bridge' }

  if (-not $supabaseUrl) { throw 'SUPABASE_URL is missing from the base .env.' }
  if (-not $primaryToken -or $primaryToken.Length -lt 32) {
    throw 'The primary DAVID device credential is unavailable for one-time Borko pairing.'
  }

  $newToken = New-DeviceToken
  $newTokenHash = Get-Sha256Hex -Value $newToken
  $bridgeUrl = "$($supabaseUrl.TrimEnd('/'))/functions/v1/$bridgeFunction"
  $requestBody = @{
    op = 'pair_routed_device'
    payload = @{
      user_id = $SoulUserId
      device_name = $deviceName
      token_hash = $newTokenHash
    }
  } | ConvertTo-Json -Depth 6 -Compress

  Write-Host 'Pairing a separate BORKO device credential. Secret values are not printed.' -ForegroundColor Cyan
  $response = Invoke-RestMethod `
    -Method Post `
    -Uri $bridgeUrl `
    -Headers @{ 'x-david-device-token' = $primaryToken } `
    -ContentType 'application/json' `
    -Body $requestBody

  if (-not $response.ok -or -not $response.paired) {
    throw 'The server did not approve the isolated BORKO device pairing.'
  }

  $borkoDeviceToken = $newToken
  Save-InstanceConfig -FixedChatUrl $fixedChatUrl -DeviceToken $borkoDeviceToken
  Write-Host 'BORKO now has a separate device credential. The temporary shared route was disabled.' -ForegroundColor Green
} elseif ($ChatUrl) {
  Save-InstanceConfig -FixedChatUrl $fixedChatUrl -DeviceToken $borkoDeviceToken
  Write-Host 'BORKO fixed GPT chat was updated without changing his device credential.' -ForegroundColor Green
}

if ($ConfigureOnly) { return }

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  BORKO DAVID - ISOLATED SERVER' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  Storage    : .david-instances\borko' -ForegroundColor DarkCyan
Write-Host '  Port       : starts from 9444' -ForegroundColor DarkCyan
Write-Host '  Profile    : separate saved ChatGPT login' -ForegroundColor DarkCyan
Write-Host '  Credential : separate BORKO device token' -ForegroundColor DarkCyan
Write-Host '  Queue      : only Borko SOUL messages' -ForegroundColor DarkCyan
Write-Host '============================================================' -ForegroundColor Cyan

& $launcher `
  -InstanceName 'borko' `
  -InstanceEnvFile $instanceEnv `
  -PreferredDebugPort 9444 `
  -RunTests:$RunTests `
  -OpenTwins:$OpenTwins
