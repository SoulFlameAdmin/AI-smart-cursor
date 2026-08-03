$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$storageRoot = Join-Path $root '.david-system'
$userDataDir = Join-Path $storageRoot 'electron-user-data'
$cacheDir = Join-Path $storageRoot 'electron-cache'
$tempDir = Join-Path $storageRoot 'temp'
$legacyUserData = Join-Path $env:APPDATA 'david-smart-cursor-v1'
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'

Write-Host 'DAVID E-DRIVE START' -ForegroundColor Cyan
Write-Host $storageRoot -ForegroundColor Cyan

Get-Process electron -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $storageRoot | Out-Null
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:ELECTRON_CACHE = $cacheDir

if (Test-Path -LiteralPath $legacyUserData) {
  Write-Host 'Copying the existing Electron and ChatGPT profile from C: to E: ...' -ForegroundColor Yellow

  & robocopy.exe $legacyUserData $userDataDir /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NP
  $copyCode = $LASTEXITCODE

  if ($copyCode -gt 7) {
    throw "Robocopy failed with exit code $copyCode"
  }

  Remove-Item -LiteralPath $legacyUserData -Recurse -Force -ErrorAction SilentlyContinue
}

$cachePaths = @(
  (Join-Path $userDataDir 'Cache'),
  (Join-Path $userDataDir 'Code Cache'),
  (Join-Path $userDataDir 'GPUCache'),
  (Join-Path $userDataDir 'DawnCache'),
  (Join-Path $userDataDir 'GraphiteDawnCache'),
  (Join-Path $userDataDir 'Partitions\david-soul\Code Cache'),
  (Join-Path $userDataDir 'Partitions\david-soul\GPUCache'),
  (Join-Path $userDataDir 'Partitions\david-soul\DawnCache'),
  (Join-Path $userDataDir 'Partitions\david-soul\Network\Cache'),
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

Write-Host "User data: $userDataDir" -ForegroundColor Green
Write-Host "Cache:     $cacheDir" -ForegroundColor Green
Write-Host "Temp:      $tempDir" -ForegroundColor Green
Write-Host 'Starting DAVID. Keep this PowerShell window open.' -ForegroundColor Green

$electronArgs = @(
  "--user-data-dir=$userDataDir"
  "--disk-cache-dir=$cacheDir"
  '--disable-gpu-shader-disk-cache'
  '.'
)

& $electronExe $electronArgs

exit $LASTEXITCODE