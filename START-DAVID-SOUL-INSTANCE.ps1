[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9_-]+$')]
  [string]$InstanceName,

  [string]$InstanceEnvFile = '',

  [ValidateRange(1024, 65535)]
  [int]$PreferredDebugPort = 9333,

  [switch]$RunTests,
  [switch]$OpenTwins,
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

$instance = $InstanceName.ToLowerInvariant()
$baseEnvFile = Join-Path $root '.env'
if (-not $InstanceEnvFile) {
  $InstanceEnvFile = Join-Path $root ".david-instances\$instance\instance.env"
} elseif (-not [System.IO.Path]::IsPathRooted($InstanceEnvFile)) {
  $InstanceEnvFile = Join-Path $root $InstanceEnvFile
}

$systemRoot = Join-Path $root ".david-instances\$instance"
$logsRoot = Join-Path $systemRoot 'logs'
$tempRoot = Join-Path $systemRoot 'temp'
$workerData = Join-Path $systemRoot 'electron-worker-data'
$workerCache = Join-Path $systemRoot 'electron-worker-cache'
$edgeProfile = Join-Path $systemRoot 'edge-soul-profile'
$statusFile = Join-Path $systemRoot 'soul-status.json'
$workerPidFile = Join-Path $systemRoot 'david-soul.pid'
$modeFile = Join-Path $systemRoot 'mode.json'
$stdoutLog = Join-Path $logsRoot 'david-soul-out.log'
$stderrLog = Join-Path $logsRoot 'david-soul-error.log'
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$entryFile = Join-Path $root 'edge-soul-main.cjs'

function Read-EnvMap {
  param([string]$Path)
  $map = @{}
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $map }

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

$baseConfig = Read-EnvMap -Path $baseEnvFile
$instanceConfig = Read-EnvMap -Path $InstanceEnvFile

function Get-ConfigValue {
  param([Parameter(Mandatory = $true)][string]$Name)
  if ($instanceConfig.ContainsKey($Name)) { return [string]$instanceConfig[$Name] }
  if ($baseConfig.ContainsKey($Name)) { return [string]$baseConfig[$Name] }
  return ''
}

function Set-ProcessConfig {
  param([Parameter(Mandatory = $true)][string]$Name, [string]$Value)
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Test-PortAvailable {
  param([int]$Port)
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

function Get-FreeDebugPort {
  param([int]$Preferred)
  foreach ($candidate in $Preferred..([Math]::Min($Preferred + 49, 65535))) {
    if (Test-PortAvailable -Port $candidate) { return $candidate }
  }
  throw "No free local Edge debugging port was found near $Preferred."
}

function Stop-ProcessSafe {
  param([int]$Id)
  if ($Id -gt 0) { Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue }
}

function Stop-OnlyThisInstance {
  param([int]$DebugPort)

  if (Test-Path -LiteralPath $workerPidFile) {
    $oldPid = 0
    [int]::TryParse((Get-Content -LiteralPath $workerPidFile -Raw -ErrorAction SilentlyContinue), [ref]$oldPid) | Out-Null
    Stop-ProcessSafe -Id $oldPid
    Remove-Item -LiteralPath $workerPidFile -Force -ErrorAction SilentlyContinue
  }

  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*--david-soul-instance=$instance*" } |
    ForEach-Object { Stop-ProcessSafe -Id $_.ProcessId }

  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -like "*$edgeProfile*" -or
      ($DebugPort -gt 0 -and $_.CommandLine -like "*--remote-debugging-port=$DebugPort*")
    } |
    ForEach-Object { Stop-ProcessSafe -Id $_.ProcessId }

  Start-Sleep -Milliseconds 700
}

function Read-Status {
  if (-not (Test-Path -LiteralPath $statusFile)) { return $null }
  try {
    return Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-Mode {
  param([int]$Port, [string]$State)
  $payload = [ordered]@{
    instance = $instance
    state = $State
    debug_address = "127.0.0.1:$Port"
    edge_profile = $edgeProfile
    worker_pid_file = $workerPidFile
    updated_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $modeFile -Encoding UTF8
}

function Write-LiveLine {
  param([string]$Line)
  if ($Line -match '\[ERROR\]|failed|exception|fatal|Owner mismatch') {
    Write-Host "[$($instance.ToUpperInvariant())] $Line" -ForegroundColor Red
  } elseif ($Line -match '\[READY\]|mode is active|waiting for SOUL|чакам въпроси') {
    Write-Host "[$($instance.ToUpperInvariant())] $Line" -ForegroundColor Green
  } elseif ($Line -match '\[WORKING\]') {
    Write-Host "[$($instance.ToUpperInvariant())] $Line" -ForegroundColor Cyan
  } else {
    Write-Host "[$($instance.ToUpperInvariant())] $Line"
  }
}

if (-not (Test-Path -LiteralPath $baseEnvFile)) {
  throw 'Missing base .env file.'
}
if (-not (Test-Path -LiteralPath $entryFile)) {
  throw 'Missing edge-soul-main.cjs.'
}

$chatUrl = Get-ConfigValue -Name 'DAVID_SOUL_CHAT_URL'
$userId = Get-ConfigValue -Name 'DAVID_SOUL_USER_ID'
$supabaseUrl = Get-ConfigValue -Name 'SUPABASE_URL'
$deviceToken = Get-ConfigValue -Name 'DAVID_DEVICE_TOKEN'
$bridgeFunction = Get-ConfigValue -Name 'DAVID_DEVICE_BRIDGE_FUNCTION'
$twinsUrl = Get-ConfigValue -Name 'DAVID_TWINS_SOUL_URL'

if ($chatUrl -notmatch '^https://chatgpt\.com/c/[A-Za-z0-9-]+(?:[/?#].*)?$') {
  throw "Instance '$instance' has no valid fixed ChatGPT conversation URL."
}
if ($userId -notmatch '^[0-9a-fA-F-]{36}$') {
  throw "Instance '$instance' has no valid SOUL user id."
}
if (-not $supabaseUrl) { throw 'SUPABASE_URL is missing.' }
if (-not $deviceToken -or $deviceToken.Length -lt 32) {
  throw 'DAVID_DEVICE_TOKEN is missing or invalid.'
}
if (-not $bridgeFunction) { $bridgeFunction = 'david-soul-bridge' }

foreach ($directory in @($systemRoot, $logsRoot, $tempRoot, $workerData, $workerCache, $edgeProfile)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

$previousPort = 0
if (Test-Path -LiteralPath $modeFile) {
  try {
    $oldMode = Get-Content -LiteralPath $modeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$oldMode.debug_address -match ':(\d+)$') { $previousPort = [int]$Matches[1] }
  } catch {}
}
Stop-OnlyThisInstance -DebugPort $previousPort

$debugPort = Get-FreeDebugPort -Preferred $PreferredDebugPort
Remove-Item -LiteralPath $statusFile, $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron is missing: $electronExe"
}
if ($RunTests) {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
  & $npm.Source test
  if ($LASTEXITCODE -ne 0) { throw 'DAVID tests failed.' }
}

Set-ProcessConfig -Name 'SUPABASE_URL' -Value $supabaseUrl
Set-ProcessConfig -Name 'DAVID_DEVICE_TOKEN' -Value $deviceToken
Set-ProcessConfig -Name 'DAVID_DEVICE_BRIDGE_FUNCTION' -Value $bridgeFunction
Set-ProcessConfig -Name 'DAVID_SOUL_CHAT_URL' -Value $chatUrl
Set-ProcessConfig -Name 'DAVID_SOUL_USER_ID' -Value $userId
Set-ProcessConfig -Name 'DAVID_SOUL_INSTANCE_ID' -Value $instance
Set-ProcessConfig -Name 'DAVID_SOUL_MULTI_INSTANCE' -Value '1'
Set-ProcessConfig -Name 'DAVID_EDGE_DEBUG_PORT' -Value ([string]$debugPort)
Set-ProcessConfig -Name 'DAVID_EDGE_PROFILE_DIR' -Value $edgeProfile
Set-ProcessConfig -Name 'DAVID_SOUL_STATUS_FILE' -Value $statusFile
Set-ProcessConfig -Name 'DAVID_SOUL_AUTO_START' -Value 'false'
Set-ProcessConfig -Name 'DAVID_SOUL_SHOW_ERROR_DIALOG' -Value '0'
Set-ProcessConfig -Name 'TEMP' -Value $tempRoot
Set-ProcessConfig -Name 'TMP' -Value $tempRoot
Set-ProcessConfig -Name 'ELECTRON_CACHE' -Value $workerCache
Set-ProcessConfig -Name 'ELECTRON_ENABLE_LOGGING' -Value '1'
Set-ProcessConfig -Name 'ELECTRON_ENABLE_STACK_DUMPING' -Value '1'

$browserVisible = Get-ConfigValue -Name 'DAVID_SOUL_BROWSER_VISIBLE'
if ($browserVisible) { Set-ProcessConfig -Name 'DAVID_SOUL_BROWSER_VISIBLE' -Value $browserVisible }

$electronArguments = @(
  '--disable-gpu',
  '--disable-gpu-compositing',
  "--user-data-dir=$workerData",
  "--disk-cache-dir=$workerCache",
  "--david-soul-instance=$instance",
  'edge-soul-main.cjs'
)

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "  DAVID SOUL INSTANCE: $($instance.ToUpperInvariant())" -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "  Port       : 127.0.0.1:$debugPort"
Write-Host "  Edge data  : $edgeProfile"
Write-Host "  SOUL route : isolated user + fixed chat"
Write-Host '  Renderer   : stable software mode (Electron GPU disabled)'
Write-Host '  Secrets    : loaded locally and not printed'
Write-Host '============================================================' -ForegroundColor Cyan

$worker = Start-Process `
  -FilePath $electronExe `
  -ArgumentList $electronArguments `
  -WorkingDirectory $root `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Set-Content -LiteralPath $workerPidFile -Value $worker.Id -Encoding ASCII
Write-Mode -Port $debugPort -State 'starting'

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$startupState = 'starting'
$startupMessage = 'DAVID is starting.'
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $worker.Refresh()
  if ($worker.HasExited) {
    $startupState = 'error'
    $startupMessage = "Worker exited with code $($worker.ExitCode)."
    break
  }
  $status = Read-Status
  if ($status) {
    $startupState = [string]$status.state
    $startupMessage = [string]$status.message
    if ($startupState -in @('ready', 'login_required', 'error')) { break }
  }
}

Write-Host "[$($instance.ToUpperInvariant())] Worker PID $($worker.Id) - $startupState" -ForegroundColor Magenta
Write-Host "[$($instance.ToUpperInvariant())] $startupMessage"
Write-Host "[$($instance.ToUpperInvariant())] LIVE REPORT - Ctrl+C stops only this instance." -ForegroundColor DarkCyan

if ($OpenTwins -and $twinsUrl) { Start-Process $twinsUrl }

$outOffset = 0
$errOffset = 0
try {
  while ($true) {
    $worker.Refresh()

    if (Test-Path -LiteralPath $stdoutLog) {
      $lines = @(Get-Content -LiteralPath $stdoutLog -Encoding UTF8 -ErrorAction SilentlyContinue)
      if ($lines.Count -gt $outOffset) {
        foreach ($line in $lines[$outOffset..($lines.Count - 1)]) { Write-LiveLine -Line $line }
        $outOffset = $lines.Count
      }
    }

    if (Test-Path -LiteralPath $stderrLog) {
      $lines = @(Get-Content -LiteralPath $stderrLog -Encoding UTF8 -ErrorAction SilentlyContinue)
      if ($lines.Count -gt $errOffset) {
        foreach ($line in $lines[$errOffset..($lines.Count - 1)]) { Write-LiveLine -Line $line }
        $errOffset = $lines.Count
      }
    }

    $status = Read-Status
    if ($status) { Write-Mode -Port $debugPort -State ([string]$status.state) }
    if ($worker.HasExited) { break }
    Start-Sleep -Milliseconds 700
  }
} finally {
  Write-Host "[$($instance.ToUpperInvariant())] Stopping only this DAVID instance." -ForegroundColor Yellow
  Stop-ProcessSafe -Id $worker.Id
  Stop-OnlyThisInstance -DebugPort $debugPort
  Write-Mode -Port $debugPort -State 'stopped'
}

$worker.Refresh()
if ($worker.HasExited -and $worker.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 100 -Encoding UTF8
  }
  throw "DAVID instance '$instance' stopped with exit code $($worker.ExitCode)."
}