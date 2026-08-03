$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$storageRoot = Join-Path $root '.david-system'
$userDataDir = Join-Path $storageRoot 'electron-user-data'
$cacheDir = Join-Path $storageRoot 'electron-cache'
$tempDir = Join-Path $storageRoot 'temp'
$logsDir = Join-Path $storageRoot 'logs'
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$stdoutLog = Join-Path $logsDir 'david-soul-out.log'
$stderrLog = Join-Path $logsDir 'david-soul-error.log'
$pidFile = Join-Path $storageRoot 'david-soul.pid'
$envFile = Join-Path $root '.env'

Write-Host ''
Write-Host '================================================' -ForegroundColor Cyan
Write-Host '  DAVID SOUL ONLY - FIXED GPT CHAT RELAY' -ForegroundColor Cyan
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

$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:ELECTRON_CACHE = $cacheDir
$env:ELECTRON_ENABLE_LOGGING = '1'
$env:ELECTRON_ENABLE_STACK_DUMPING = '1'
$env:DAVID_SOUL_PARTITION = 'persist:david-soul-v2'

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

Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $electronExe } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Remove-Item -LiteralPath $stdoutLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stderrLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

Write-Host 'Starting DAVID SOUL relay only.' -ForegroundColor Green
Write-Host 'Teacher mode will not be loaded.' -ForegroundColor Green
Write-Host 'A fresh Electron SOUL profile will open DAVID_SOUL_CHAT_URL.' -ForegroundColor Green
Write-Host 'Live Chromium load diagnostics are enabled.' -ForegroundColor Green
Write-Host ''

$electronArgs = @(
  "--user-data-dir=$userDataDir"
  "--disk-cache-dir=$cacheDir"
  '--ignore-gpu-blocklist'
  'soul-main.cjs'
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
  Get-Content -LiteralPath $stdoutLog -Tail 60
}
if (Test-Path -LiteralPath $stderrLog) {
  Get-Content -LiteralPath $stderrLog -Tail 100
}
Write-Host '--- END STARTUP LOG ---' -ForegroundColor DarkCyan
Write-Host ''

if ($process.HasExited) {
  throw "DAVID SOUL Electron exited with code $($process.ExitCode)."
}

Write-Host "DAVID SOUL RUNNING - PID $($process.Id)" -ForegroundColor Green
Write-Host 'The window must show a loading card, ChatGPT, or a readable load error - never a silent black screen.' -ForegroundColor Yellow
Write-Host "Log: $stdoutLog" -ForegroundColor DarkGray
Write-Host "Errors: $stderrLog" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Do not enter a DAVID command. Send a message directly from the SOUL chat after ChatGPT is visible.' -ForegroundColor Cyan

Wait-Process -Id $process.Id
$process.Refresh()

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "DAVID SOUL stopped - exit code $($process.ExitCode)" -ForegroundColor Yellow

if (Test-Path -LiteralPath $stderrLog) {
  Get-Content -LiteralPath $stderrLog -Tail 120
}
