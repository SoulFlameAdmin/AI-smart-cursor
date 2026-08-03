[CmdletBinding()]
param(
  [switch]$Update,
  [switch]$SkipTests,
  [switch]$ResetEdgeProfile,
  [switch]$NoOpenTwins,
  [string]$TwinsUrl = '',
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

$branch = 'feature/david-soul-relay-v1'
$systemRoot = Join-Path $root '.david-system'
$logsRoot = Join-Path $systemRoot 'logs'
$tempRoot = Join-Path $systemRoot 'temp'
$workerData = Join-Path $systemRoot 'electron-worker-data'
$workerCache = Join-Path $systemRoot 'electron-worker-cache'
$edgeProfile = Join-Path $systemRoot 'edge-soul-profile'
$modeFile = Join-Path $systemRoot 'mode.json'
$statusFile = Join-Path $systemRoot 'soul-status.json'
$workerPidFile = Join-Path $systemRoot 'david-soul.pid'
$twinsPidFile = Join-Path $systemRoot 'twins.pid'
$stdoutLog = Join-Path $logsRoot 'david-soul-out.log'
$stderrLog = Join-Path $logsRoot 'david-soul-error.log'
$twinsOutLog = Join-Path $logsRoot 'twins-out.log'
$twinsErrorLog = Join-Path $logsRoot 'twins-error.log'
$envFile = Join-Path $root '.env'
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$entryFile = Join-Path $root 'edge-soul-main.cjs'

function Write-Header {
  Clear-Host
  Write-Host '============================================================' -ForegroundColor Cyan
  Write-Host '  DAVID SOUL MODE - TWINS SITE RELAY' -ForegroundColor Cyan
  Write-Host '============================================================' -ForegroundColor Cyan
  Write-Host '  Twins -> DAVID Edge -> fixed GPT chat -> Twins' -ForegroundColor DarkCyan
  Write-Host '  SOUL text is never executed as PowerShell.' -ForegroundColor DarkGray
  Write-Host '============================================================' -ForegroundColor Cyan
  Write-Host ''
}

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

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )

  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$File exited with code $LASTEXITCODE"
  }
}

function Get-EnvValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Test-Path -LiteralPath $envFile)) { return '' }
  $match = Get-Content -LiteralPath $envFile -Encoding UTF8 |
    Where-Object { $_ -match "^\s*(?:export\s+)?$([Regex]::Escape($Name))\s*=" } |
    Select-Object -Last 1

  if (-not $match) { return '' }
  $value = ($match -split '=', 2)[1].Trim()
  if (
    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
    ($value.StartsWith("'") -and $value.EndsWith("'"))
  ) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value.Trim()
}

function Test-SafeChatUrl {
  param([string]$Value)
  return [bool]($Value -match '^https://chatgpt\.com/c/[A-Za-z0-9-]+(?:[/?#].*)?$')
}

function Test-SafeTwinsUrl {
  param([string]$Value)
  if (-not $Value) { return $false }
  try {
    $uri = [Uri]$Value
    if ($uri.Scheme -eq 'https') { return $true }
    if ($uri.Scheme -eq 'http' -and $uri.Host -in @('localhost', '127.0.0.1', '::1')) {
      return $true
    }
  } catch {}
  return $false
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
  param([int]$Preferred = 9333)
  foreach ($candidate in $Preferred..9399) {
    if (Test-PortAvailable -Port $candidate) { return $candidate }
  }
  throw 'No free local Edge debugging port was found between 9333 and 9399.'
}

function Stop-ProcessSafe {
  param([int]$Id)
  if ($Id -le 0) { return }
  Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
}

function Stop-PreviousMode {
  param([int]$PreviousPort)

  if (Test-Path -LiteralPath $twinsPidFile) {
    $oldTwinsPid = 0
    [int]::TryParse((Get-Content -LiteralPath $twinsPidFile -Raw -ErrorAction SilentlyContinue), [ref]$oldTwinsPid) | Out-Null
    Stop-ProcessSafe -Id $oldTwinsPid
    Remove-Item -LiteralPath $twinsPidFile -Force -ErrorAction SilentlyContinue
  }

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -eq 'electron.exe' -and (
        $_.ExecutablePath -eq $electronExe -or
        $_.CommandLine -like "*$root*"
      )
    } |
    ForEach-Object { Stop-ProcessSafe -Id $_.ProcessId }

  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -like '*edge-soul-profile*' -or
      ($PreviousPort -gt 0 -and $_.CommandLine -like "*--remote-debugging-port=$PreviousPort*")
    } |
    ForEach-Object { Stop-ProcessSafe -Id $_.ProcessId }

  Start-Sleep -Milliseconds 900
}

function Read-ModeFile {
  if (-not (Test-Path -LiteralPath $modeFile)) { return $null }
  try {
    return Get-Content -LiteralPath $modeFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-ModeFile {
  param([int]$DebugPort, [string]$State)

  $payload = [ordered]@{
    mode = 'soul'
    transport = 'twins-supabase-edge'
    state = $State
    debug_address = "127.0.0.1:$DebugPort"
    edge_profile = $edgeProfile
    root = $root
    updated_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  $temporary = "$modeFile.tmp"
  $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $modeFile -Force
}

function Read-SoulStatus {
  if (-not (Test-Path -LiteralPath $statusFile)) { return $null }
  try {
    return Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-NewLogLines {
  param([string]$Path, [ref]$Offset)

  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue)
  if ($lines.Count -le $Offset.Value) { return @() }
  $start = $Offset.Value
  $Offset.Value = $lines.Count
  return @($lines[$start..($lines.Count - 1)])
}

function Write-LiveLine {
  param([string]$Line)
  if ($Line -match '\[ERROR\]|failed|exception|fatal') {
    Write-Host $Line -ForegroundColor Red
  } elseif ($Line -match '\[READY\]|mode is active|waiting for SOUL') {
    Write-Host $Line -ForegroundColor Green
  } elseif ($Line -match 'login_required|Log in to ChatGPT|login page') {
    Write-Host $Line -ForegroundColor Yellow
  } elseif ($Line -match '\[WORKING\]') {
    Write-Host $Line -ForegroundColor Cyan
  } else {
    Write-Host $Line
  }
}

function Start-TwinsSite {
  param([string]$Url)

  $twinsRoot = Get-EnvValue -Name 'DAVID_TWINS_ROOT'
  $twinsProcess = $null

  if ($twinsRoot -and (Test-Path -LiteralPath $twinsRoot)) {
    $packageFile = Join-Path $twinsRoot 'package.json'
    if (Test-Path -LiteralPath $packageFile) {
      $package = Get-Content -LiteralPath $packageFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $scriptName = ''
      $scriptProperties = @()
      if ($package.PSObject.Properties.Name -contains 'scripts' -and $package.scripts) {
        $scriptProperties = @($package.scripts.PSObject.Properties.Name)
      }
      if ($scriptProperties -contains 'dev') { $scriptName = 'dev' }
      elseif ($scriptProperties -contains 'start') { $scriptName = 'start' }

      if ($scriptName) {
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
        Remove-Item -LiteralPath $twinsOutLog -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $twinsErrorLog -Force -ErrorAction SilentlyContinue
        $arguments = if ($scriptName -eq 'dev') { @('run', 'dev') } else { @('start') }
        $twinsProcess = Start-Process `
          -FilePath $npm.Source `
          -ArgumentList $arguments `
          -WorkingDirectory $twinsRoot `
          -RedirectStandardOutput $twinsOutLog `
          -RedirectStandardError $twinsErrorLog `
          -PassThru
        Set-Content -LiteralPath $twinsPidFile -Value $twinsProcess.Id -Encoding ASCII
        Start-Sleep -Seconds 2
        $twinsProcess.Refresh()
        if ($twinsProcess.HasExited) {
          Write-Warn 'The local Twins server exited. DAVID will continue with the deployed Twins/Supabase bridge.'
          if (Test-Path -LiteralPath $twinsErrorLog) {
            Get-Content -LiteralPath $twinsErrorLog -Tail 30 -Encoding UTF8
          }
          $twinsProcess = $null
        } else {
          Write-Ok "Local Twins server started with npm $scriptName (PID $($twinsProcess.Id))."
        }
      }
    }
  }

  if ($Url -and -not $NoOpenTwins) {
    Start-Process $Url
    Write-Ok 'The Twins SOUL page was opened.'
  }

  return $twinsProcess
}

Write-Header

$totalSteps = 8
Write-Step 1 $totalSteps 'Validating the DAVID SOUL environment.'

if (-not (Test-Path -LiteralPath $envFile)) {
  throw 'Missing .env file in the DAVID repository.'
}
if (-not (Test-Path -LiteralPath $entryFile)) {
  throw 'Missing edge-soul-main.cjs. Pull the latest SOUL branch once.'
}

$chatUrl = Get-EnvValue -Name 'DAVID_SOUL_CHAT_URL'
$supabaseUrl = Get-EnvValue -Name 'SUPABASE_URL'
$deviceToken = Get-EnvValue -Name 'DAVID_DEVICE_TOKEN'

if (-not (Test-SafeChatUrl -Value $chatUrl)) {
  throw 'DAVID_SOUL_CHAT_URL must be a private https://chatgpt.com/c/... conversation URL.'
}
if (-not $supabaseUrl) { throw 'SUPABASE_URL is missing from .env.' }
if (-not $deviceToken -or $deviceToken.Length -lt 32) {
  throw 'DAVID_DEVICE_TOKEN is missing or shorter than 32 characters.'
}

if (-not $TwinsUrl) { $TwinsUrl = Get-EnvValue -Name 'DAVID_TWINS_SOUL_URL' }
if ($TwinsUrl -and -not (Test-SafeTwinsUrl -Value $TwinsUrl)) {
  throw 'DAVID_TWINS_SOUL_URL must use HTTPS, or HTTP only on localhost.'
}

Write-Ok 'Required configuration is present. Secret values were not printed.'

Write-Step 2 $totalSteps 'Preparing isolated storage, logs and persistent Edge login.'
foreach ($directory in @($systemRoot, $logsRoot, $tempRoot, $workerData, $workerCache, $edgeProfile)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
if ($ResetEdgeProfile) {
  Remove-Item -LiteralPath $edgeProfile -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $edgeProfile | Out-Null
  Write-Warn 'The dedicated Edge login profile was reset. ChatGPT login will be required again.'
}

$previousMode = Read-ModeFile
$previousPort = 0
if (
  $previousMode -and
  $previousMode.PSObject.Properties.Name -contains 'debug_address' -and
  [string]$previousMode.debug_address -match ':(\d+)$'
) {
  $previousPort = [int]$Matches[1]
}
Stop-PreviousMode -PreviousPort $previousPort
Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $workerPidFile -Force -ErrorAction SilentlyContinue
Write-Ok 'Teacher/closed-loop processes and stale SOUL workers were stopped safely.'

Write-Step 3 $totalSteps 'Selecting a localhost-only Edge control port.'
$preferredPort = 9333
$envPort = Get-EnvValue -Name 'DAVID_EDGE_DEBUG_PORT'
if ($envPort -match '^\d+$') { $preferredPort = [int]$envPort }
$debugPort = Get-FreeDebugPort -Preferred $preferredPort
Write-ModeFile -DebugPort $debugPort -State 'preparing'
Write-Ok "Edge DevTools is restricted to 127.0.0.1:$debugPort."

Write-Step 4 $totalSteps 'Optionally updating the tested SOUL branch.'
if ($Update) {
  $git = Get-Command git -ErrorAction Stop
  $tracked = & $git.Source status --porcelain --untracked-files=no
  if ($LASTEXITCODE -ne 0) { throw 'Could not read Git status.' }
  if ($tracked) {
    Write-Warn 'Tracked local changes exist. Update was skipped so no work is overwritten.'
  } else {
    $oldPrompt = $env:GIT_TERMINAL_PROMPT
    $oldInteractive = $env:GCM_INTERACTIVE
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'Never'
    try {
      & $git.Source fetch origin $branch
      if ($LASTEXITCODE -eq 0) {
        & $git.Source checkout $branch
        if ($LASTEXITCODE -ne 0) { throw 'Could not switch to the SOUL branch.' }
        & $git.Source merge --ff-only "origin/$branch"
        if ($LASTEXITCODE -ne 0) { throw 'The SOUL branch could not be fast-forwarded.' }
        Write-Ok 'The local SOUL branch is up to date.'
      } else {
        Write-Warn 'Git update was unavailable. Continuing with the already installed tested version.'
      }
    } finally {
      $env:GIT_TERMINAL_PROMPT = $oldPrompt
      $env:GCM_INTERACTIVE = $oldInteractive
    }
  }
} else {
  Write-Ok 'No Git update requested. Startup cannot ask for a GitHub username or password.'
}

Write-Step 5 $totalSteps 'Checking Node, Electron and the DAVID tests.'
$node = Get-Command node -ErrorAction Stop
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }

if (-not (Test-Path -LiteralPath $electronExe)) {
  Write-Warn 'Electron is missing. Installing project dependencies.'
  Invoke-Checked $npm.Source install
}
if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron was not found after npm install: $electronExe"
}

if (-not $SkipTests) {
  Invoke-Checked $npm.Source test
  Write-Ok 'DAVID and SOUL relay tests passed.'
} else {
  Write-Warn 'Tests were skipped by request.'
}

Write-Step 6 $totalSteps 'Starting the real Edge GPT controller before the Twins queue.'
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:ELECTRON_CACHE = $workerCache
$env:ELECTRON_ENABLE_LOGGING = '1'
$env:ELECTRON_ENABLE_STACK_DUMPING = '1'
$env:DAVID_EDGE_DEBUG_PORT = [string]$debugPort
$env:DAVID_EDGE_PROFILE_DIR = $edgeProfile
$env:DAVID_SOUL_STATUS_FILE = $statusFile
$env:DAVID_SOUL_MODE = 'twins'
$env:DAVID_SOUL_AUTO_START = 'false'
$env:DAVID_SOUL_SHOW_ERROR_DIALOG = '0'

Remove-Item -LiteralPath $stdoutLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stderrLog -Force -ErrorAction SilentlyContinue

$electronArguments = @(
  "--user-data-dir=$workerData",
  "--disk-cache-dir=$workerCache",
  'edge-soul-main.cjs'
)

$worker = Start-Process `
  -FilePath $electronExe `
  -ArgumentList $electronArguments `
  -WorkingDirectory $root `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Set-Content -LiteralPath $workerPidFile -Value $worker.Id -Encoding ASCII
Write-ModeFile -DebugPort $debugPort -State 'starting'
Write-Ok "DAVID SOUL worker started (PID $($worker.Id))."

Write-Step 7 $totalSteps 'Waiting for GPT readiness, login, or a clear error report.'
$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$startupState = 'starting'
$startupMessage = 'DAVID is starting.'

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $worker.Refresh()
  if ($worker.HasExited) {
    $startupState = 'error'
    $startupMessage = "DAVID SOUL worker exited with code $($worker.ExitCode)."
    break
  }

  $status = Read-SoulStatus
  if ($status) {
    if ($status.PSObject.Properties.Name -contains 'state') {
      $startupState = [string]$status.state
    }
    if ($status.PSObject.Properties.Name -contains 'message') {
      $startupMessage = [string]$status.message
    }
    if ($startupState -in @('ready', 'login_required', 'error')) { break }
  }
}

if ($startupState -in @('starting', 'working', 'opening_gpt', 'gpt_ready')) {
  $startupState = 'working'
  $startupMessage = 'DAVID is still loading Edge/ChatGPT. The live report will continue.'
}

Write-Step 8 $totalSteps 'Starting or opening the Twins SOUL interface and printing the report.'
$twinsProcess = Start-TwinsSite -Url $TwinsUrl

Write-Host ''
Write-Host '==================== STARTUP REPORT ====================' -ForegroundColor Cyan
Write-Host 'Mode             : SOUL for Twins'
Write-Host ("Worker           : PID {0} - {1}" -f $worker.Id, $(if ($worker.HasExited) { 'STOPPED' } else { 'RUNNING' }))
Write-Host ("GPT state        : {0}" -f $startupState)
Write-Host ("GPT message      : {0}" -f $startupMessage)
Write-Host ("Twins interface  : {0}" -f $(if ($TwinsUrl) { $TwinsUrl } elseif ($twinsProcess) { 'local server started' } else { 'deployed Supabase/Twins bridge' }))
Write-Host ("Edge control     : 127.0.0.1:{0}" -f $debugPort)
Write-Host ("Edge profile     : {0}" -f $edgeProfile)
Write-Host ("Status file      : {0}" -f $statusFile)
Write-Host ("Output log       : {0}" -f $stdoutLog)
Write-Host ("Error log        : {0}" -f $stderrLog)
Write-Host 'Security         : SOUL text is inserted into GPT only; it is not executed as shell code.'
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host ''

if ($startupState -eq 'login_required') {
  Write-Warn 'Complete ChatGPT login in the dedicated DAVID Edge window. The relay will activate automatically afterward.'
} elseif ($startupState -eq 'ready') {
  Write-Ok 'DAVID is ready. Send a message from the SOUL chat in Twins.'
} elseif ($startupState -eq 'error') {
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 100 -Encoding UTF8
  }
  throw $startupMessage
}

Write-Host 'LIVE DAVID SOUL REPORT - press Ctrl+C to stop this SOUL mode.' -ForegroundColor DarkCyan
Write-Host ''

$outOffset = 0
$errOffset = 0
$lastState = $startupState

try {
  while ($true) {
    $worker.Refresh()
    $outRef = [ref]$outOffset
    $errRef = [ref]$errOffset
    foreach ($line in (Get-NewLogLines -Path $stdoutLog -Offset $outRef)) {
      Write-LiveLine -Line $line
    }
    foreach ($line in (Get-NewLogLines -Path $stderrLog -Offset $errRef)) {
      Write-LiveLine -Line $line
    }

    $status = Read-SoulStatus
    if (
      $status -and
      $status.PSObject.Properties.Name -contains 'state' -and
      [string]$status.state -ne $lastState
    ) {
      $lastState = [string]$status.state
      $message = if ($status.PSObject.Properties.Name -contains 'message') { [string]$status.message } else { '' }
      Write-Host ''
      Write-Host ("[STATE] {0} - {1}" -f $lastState, $message) -ForegroundColor Magenta
      Write-Host ''
      Write-ModeFile -DebugPort $debugPort -State $lastState
    }

    if ($worker.HasExited) { break }
    Start-Sleep -Milliseconds 600
  }
} finally {
  Write-Warn 'Stopping DAVID SOUL mode and only its dedicated processes.'
  Stop-ProcessSafe -Id $worker.Id
  if ($twinsProcess) { Stop-ProcessSafe -Id $twinsProcess.Id }
  Stop-PreviousMode -PreviousPort $debugPort
  Write-ModeFile -DebugPort $debugPort -State 'stopped'
}

$worker.Refresh()
if ($worker.HasExited -and $worker.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 120 -Encoding UTF8
  }
  throw "DAVID SOUL stopped with exit code $($worker.ExitCode)."
}
