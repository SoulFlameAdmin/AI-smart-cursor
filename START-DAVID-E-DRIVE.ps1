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

$legacyCachePaths = @(
  (Join-Path $legacyUserData 'Cache'),
  (Join-Path $legacyUserData 'Code Cache'),
  (Join-Path $legacyUserData 'GPUCache'),
  (Join-Path $legacyUserData 'DawnCache'),
  (Join-Path $legacyUserData 'GraphiteDawnCache'),
  (Join-Path $legacyUserData 'Partitions\david-soul\Code Cache'),
  (Join-Path $legacyUserData 'Partitions\david-soul\GPUCache'),
  (Join-Path $legacyUserData 'Partitions\david-soul\DawnCache'),
  (Join-Path $legacyUserData 'Partitions\david-soul\Network\Cache'),
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