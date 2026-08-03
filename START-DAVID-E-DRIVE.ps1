$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$storageRoot = Join-Path $root '.david-system'
$userDataDir = Join-Path $storageRoot 'electron-user-data'
$cacheDir = Join-Path $storageRoot 'electron-cache'
$tempDir = Join-Path $storageRoot 'temp'
$logsDir = Join-Path $storageRoot 'logs'
$legacyUserData = Join-Path $env:APPDATA 'david-smart-cursor-v1'
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$stdoutLog = Join-Path $logsDir 'david-electron-out.log'
$stderrLog = Join-Path $logsDir 'david-electron-error.log'

Write-Host 'DAVID E-DRIVE START' -ForegroundColor Cyan
Write-Host $storageRoot -ForegroundColor Cyan

Get-Process electron,node -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue

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

$legacyCachePaths = @(
  (Join-Path $legacyUserData 'Cache'),
  (Join-Path $legacyUserData 'Code Cache'),
  (Join-Path $legacyUserData 'GPUCache'),
  (Join-Path $legacyUserData 'DawnCache'),
  (Join-Path $legacyUserData 'GraphiteDawnCache'),
  (Join-Path $legacyUserData 'Network'),
  (Join-Path $legacyUserData 'Partitions\david-soul\Code Cache'),
  (Join-Path $legacyUserData 'Partitions\david-soul\GPUCache'),
  (Join-Path $legacyUserData 'Partitions\david-soul\DawnCache'),
  (Join-Path $legacyUserData 'Partitions\david-soul\Network'),
  (Join-Path $legacyUserData 'Partitions\david-soul\Service Worker\CacheStorage'),
  (Join-Path $legacyUserData 'Partitions\david-soul\Shared Dictionary\cache')
)

foreach ($item in $legacyCachePaths) {
  if (Test-Path -LiteralPath $item) {
    Remove-Item -LiteralPath $item -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (Test-Path -LiteralPath $legacyUserData) {
  Write-Host 'Copying the existing Electron and ChatGPT profile from C: to E: ...' -ForegroundColor Yellow

  try {
    Get-ChildItem -LiteralPath $legacyUserData -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $userDataDir -Recurse -Force
    }

    Remove-Item -LiteralPath $legacyUserData -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Profile moved to E:.' -ForegroundColor Green
  }
  catch {
    Write-Warning 'The old profile could not be copied completely. DAVID will start with the E: profile and ChatGPT may ask you to sign in again.'
  }
}

$cachePaths = @(
  (Join-Path $userDataDir 'Cache'),
  (Join-Path $userDataDir 'Code Cache'),
  (Join-Path $userDataDir 'GPUCache'),
  (Join-Path $userDataDir 'DawnCache'),
  (Join-Path $userDataDir 'GraphiteDawnCache'),
  (Join-Path $userDataDir 'Network'),
  (Join-Path $userDataDir 'Partitions\david-soul\Code Cache'),
  (Join-Path $userDataDir 'Partitions\david-soul\GPUCache'),
  (Join-Path $userDataDir 'Partitions\david-soul\DawnCache'),
  (Join-Path $userDataDir 'Partitions\david-soul\Network'),
  (Join-Path $userDataDir 'Partitions\david-soul\Service Worker\CacheStorage'),
  (Join-Path $userDataDir 'Partitions\david-soul\Shared Dictionary\cache')
)

foreach ($item in $cachePaths) {
  if (Test-Path -LiteralPath $item) {
    Remove-Item -LiteralPath $item -Recurse -Force -ErrorAction SilentlyContinue
  }
}

New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

if (-not (Test-Path -LiteralPath $electronExe)) {
  Write-Host 'Electron is missing. Running npm install ...' -ForegroundColor Yellow
  npm install
}

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron was not found at $electronExe"
}

$driveName = [System.IO.Path]::GetPathRoot($storageRoot).Substring(0, 1)
$drive = Get-PSDrive -Name $driveName

if ($drive.Free -lt 1GB) {
  throw 'E: has less than 1 GB free space.'
}

Remove-Item -LiteralPath $stdoutLog -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stderrLog -Force -ErrorAction SilentlyContinue

Write-Host "User data: $userDataDir" -ForegroundColor Green
Write-Host "Cache:     $cacheDir" -ForegroundColor Green
Write-Host "Temp:      $tempDir" -ForegroundColor Green
Write-Host "Logs:      $logsDir" -ForegroundColor Green
Write-Host 'Starting DAVID. This window will stay open while DAVID is running.' -ForegroundColor Green

$electronArgs = @(
  "--user-data-dir=$userDataDir"
  "--disk-cache-dir=$cacheDir"
  '--disable-gpu'
  '--disable-gpu-shader-disk-cache'
  '--disable-features=NetworkServiceSandbox'
  '.'
)

$process = Start-Process `
  -FilePath $electronExe `
  -ArgumentList $electronArgs `
  -WorkingDirectory $root `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Start-Sleep -Seconds 6
$process.Refresh()

if ($process.HasExited) {
  Write-Host 'DAVID stopped during startup.' -ForegroundColor Red
  if (Test-Path -LiteralPath $stdoutLog) {
    Get-Content -LiteralPath $stdoutLog -Tail 40
  }
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 80
  }
  throw "DAVID Electron exited with code $($process.ExitCode)."
}

Write-Host "DAVID RUNNING · PID $($process.Id)" -ForegroundColor Green
Write-Host 'Open Soul and send a message. Keep this PowerShell window open.' -ForegroundColor Yellow
Write-Host "Error log: $stderrLog" -ForegroundColor DarkGray

Wait-Process -Id $process.Id
$process.Refresh()

Write-Host "DAVID stopped · exit code $($process.ExitCode)" -ForegroundColor Yellow
if (Test-Path -LiteralPath $stderrLog) {
  Get-Content -LiteralPath $stderrLog -Tail 80
}
