$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$storageRoot = Join-Path $root '.david-system'
$userDataDir = Join-Path $storageRoot 'electron-worker-data'
$cacheDir = Join-Path $storageRoot 'electron-worker-cache'
$tempDir = Join-Path $storageRoot 'temp'
$logsDir = Join-Path $storageRoot 'logs'
$edgeProfileDir = Join-Path $storageRoot 'edge-soul-profile'
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$stdoutLog = Join-Path $logsDir 'david-soul-out.log'
$stderrLog = Join-Path $logsDir 'david-soul-error.log'
$pidFile = Join-Path $storageRoot 'david-soul.pid'
$envFile = Join-Path $root '.env'
$debugPort = 9333

Write-Host ''
Write-Host '================================================' -ForegroundColor Cyan
Write-Host '  DAVID SOUL - MICROSOFT EDGE GPT RELAY' -ForegroundColor Cyan
Write-Host '================================================' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $envFile)) {
  throw 'Local .env file is missing.'
}

$envLines = Get-Content -LiteralPath $envFile
$chatLine = $envLines | Where-Object { $_ -match '^\s*DAVID_SOUL_CHAT_URL\s*=' } | Select-Object -Last 1
$tokenLine = $envLines | Where-Object { $_ -match '^\s*DAVID_DEVICE_TOKEN\s*=' } | Select-Object -Last 1
$supabaseLine = $envLines | Where-Object { $_ -match '^\s*SUPABASE_URL\s*=' } | Select-Object -Last 1

$chatUrl = if ($chatLine) { ($chatLine -split '=', 2)[1].Trim() } else { '' }
$deviceToken = if ($tokenLine) { ($tokenLine -split '=', 2)[1].Trim() } else { '' }
$supabaseUrl = if ($supabaseLine) { ($supabaseLine -split '=', 2)[1].Trim() } else { '' }

if (-not $chatUrl -or $chatUrl -match 'PASTE|private-chat-id|<.+>') {
  throw 'DAVID_SOUL_CHAT_URL is missing from .env. Use a private https://chatgpt.com/c/... URL.'
}

if ($chatUrl -notmatch '^https://chatgpt\.com/c/[A-Za-z0-9-]+') {
  throw 'DAVID_SOUL_CHAT_URL is not a valid private ChatGPT conversation URL.'
}

if (-not $supabaseUrl) {
  throw 'SUPABASE_URL is missing from .env.'
}

if (-not $deviceToken -or $deviceToken.Length -lt 32) {
  throw 'DAVID_DEVICE_TOKEN is missing or invalid in .env.'
}

New-Item -ItemType Directory -Force -Path $storageRoot | Out-Null
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
New-Item -ItemType Directory -Force -Path $edgeProfileDir | Out-Null

$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:ELECTRON_CACHE = $cacheDir
$env:ELECTRON_ENABLE_LOGGING = '1'
$env:ELECTRON_ENABLE_STACK_DUMPING = '1'
$env:DAVID_EDGE_DEBUG_PORT = [string]$debugPort
$env:DAVID_EDGE_PROFILE_DIR = $edgeProfileDir

if (-not (Test-Path -LiteralPath $electronExe)) {
  Write-Host 'Electron is missing. Running npm install...' -ForegroundColor Yellow
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install exited with code $LASTEXITCODE"
  }
}

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron was not found: $electronExe"
}

# Stop only this DAVID Electron worker.
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $electronExe } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

# Stop only the dedicated DAVID Edge instance, never the user's normal Edge windows.
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -like "*--remote-debugging-port=$debugPort*" -or
    $_.CommandLine -like "*edge-soul-profile*"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Milliseconds 700

Remove-Item -LiteralPath $stdoutLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stderrLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

Write-Host 'Starting the DAVID SOUL worker.' -ForegroundColor Green
Write-Host 'ChatGPT will open in real Microsoft Edge, not inside Electron.' -ForegroundColor Green
Write-Host 'The dedicated Edge login will be saved in .david-system\edge-soul-profile.' -ForegroundColor Green
Write-Host 'Teacher mode will not be loaded.' -ForegroundColor Green
Write-Host ''

$electronArgs = @(
  "--user-data-dir=$userDataDir"
  "--disk-cache-dir=$cacheDir"
  'edge-soul-main.cjs'
)

$process = Start-Process `
  -FilePath $electronExe `
  -ArgumentList $electronArgs `
  -WorkingDirectory $root `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

Start-Sleep -Seconds 10
$process.Refresh()

Write-Host ''
Write-Host '--- DAVID SOUL STARTUP LOG ---' -ForegroundColor DarkCyan
if (Test-Path -LiteralPath $stdoutLog) {
  Get-Content -LiteralPath $stdoutLog -Tail 100
}
if (Test-Path -LiteralPath $stderrLog) {
  Get-Content -LiteralPath $stderrLog -Tail 120
}
Write-Host '--- END STARTUP LOG ---' -ForegroundColor DarkCyan
Write-Host ''

if ($process.HasExited) {
  throw "DAVID SOUL Edge worker exited with code $($process.ExitCode)."
}

Write-Host "DAVID SOUL EDGE RUNNING - PID $($process.Id)" -ForegroundColor Green
Write-Host 'Use the Microsoft Edge window that DAVID opened.' -ForegroundColor Yellow
Write-Host 'Log in there once if requested. DAVID will then open the fixed GPT conversation automatically.' -ForegroundColor Yellow
Write-Host "Log: $stdoutLog" -ForegroundColor DarkGray
Write-Host "Errors: $stderrLog" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'After the fixed GPT chat is visible, send a message directly from SOUL.' -ForegroundColor Cyan

Wait-Process -Id $process.Id
$process.Refresh()

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "DAVID SOUL stopped - exit code $($process.ExitCode)" -ForegroundColor Yellow

if (Test-Path -LiteralPath $stderrLog) {
  Get-Content -LiteralPath $stderrLog -Tail 140
}
