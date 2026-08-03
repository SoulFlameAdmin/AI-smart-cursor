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
  throw 'Липсва локалният .env файл.'
}

$envLines = Get-Content -LiteralPath $envFile
$chatLine = $envLines | Where-Object { $_ -match '^\s*DAVID_SOUL_CHAT_URL\s*=' } | Select-Object -Last 1
$tokenLine = $envLines | Where-Object { $_ -match '^\s*DAVID_DEVICE_TOKEN\s*=' } | Select-Object -Last 1
$supabaseLine = $envLines | Where-Object { $_ -match '^\s*SUPABASE_URL\s*=' } | Select-Object -Last 1

$chatUrl = if ($chatLine) { ($chatLine -split '=', 2)[1].Trim() } else { '' }
$deviceToken = if ($tokenLine) { ($tokenLine -split '=', 2)[1].Trim() } else { '' }
$supabaseUrl = if ($supabaseLine) { ($supabaseLine -split '=', 2)[1].Trim() } else { '' }

if (-not $chatUrl -or $chatUrl -match 'PASTE|private-chat-id|<.+>') {
  throw 'В .env липсва реалният DAVID_SOUL_CHAT_URL от вида https://chatgpt.com/c/...'
}

if ($chatUrl -notmatch '^https://chatgpt\.com/c/[A-Za-z0-9-]+') {
  throw 'DAVID_SOUL_CHAT_URL не е валиден частен ChatGPT разговор.'
}

if (-not $supabaseUrl) {
  throw 'В .env липсва SUPABASE_URL.'
}

if (-not $deviceToken -or $deviceToken.Length -lt 32) {
  throw 'В .env липсва валиден DAVID_DEVICE_TOKEN.'
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

if (-not (Test-Path -LiteralPath $electronExe)) {
  Write-Host 'Electron липсва. Стартирам npm install...' -ForegroundColor Yellow
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install завърши с код $LASTEXITCODE"
  }
}

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron не е намерен: $electronExe"
}

# Спира само Electron процеси от тази DAVID инсталация, не всички Electron приложения.
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $electronExe } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Remove-Item -LiteralPath $stdoutLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stderrLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

Write-Host 'Стартирам само DAVID SOUL relay.' -ForegroundColor Green
Write-Host 'Teacher режимът няма да бъде зареден.' -ForegroundColor Green
Write-Host 'Electron ще отвори точния DAVID_SOUL_CHAT_URL и ще чака SOUL.' -ForegroundColor Green
Write-Host ''

$electronArgs = @(
  "--user-data-dir=$userDataDir"
  "--disk-cache-dir=$cacheDir"
  '--disable-gpu'
  '--disable-gpu-shader-disk-cache'
  '--disable-features=NetworkServiceSandbox'
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

Start-Sleep -Seconds 8
$process.Refresh()

if ($process.HasExited) {
  Write-Host 'DAVID SOUL спря при старта.' -ForegroundColor Red
  if (Test-Path -LiteralPath $stdoutLog) {
    Get-Content -LiteralPath $stdoutLog -Tail 80
  }
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 120
  }
  throw "DAVID SOUL Electron завърши с код $($process.ExitCode)."
}

Write-Host "DAVID SOUL RUNNING · PID $($process.Id)" -ForegroundColor Green
Write-Host 'Точната GPT сесия трябва да е отворена и да показва, че чака Soul.' -ForegroundColor Yellow
Write-Host "Log: $stdoutLog" -ForegroundColor DarkGray
Write-Host "Errors: $stderrLog" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Не пиши команда в DAVID. Изпрати съобщение директно от SOUL чата.' -ForegroundColor Cyan

Wait-Process -Id $process.Id
$process.Refresh()

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "DAVID SOUL спря · код $($process.ExitCode)" -ForegroundColor Yellow

if (Test-Path -LiteralPath $stderrLog) {
  Get-Content -LiteralPath $stderrLog -Tail 120
}
