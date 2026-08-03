$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$storageRoot = Join-Path $root ".david-system"
$userDataDir = Join-Path $storageRoot "electron-user-data"
$cacheDir = Join-Path $storageRoot "electron-cache"
$legacyUserData = Join-Path $env:APPDATA "david-smart-cursor-v1"
$electronExe = Join-Path $root "node_modules\electron\dist\electron.exe"

Write-Host "DAVID E-DRIVE STORAGE: $storageRoot" -ForegroundColor Cyan

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -in @("electron.exe", "node.exe") -and
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

New-Item -ItemType Directory -Force -Path $storageRoot, $userDataDir, $cacheDir | Out-Null

if (Test-Path $legacyUserData) {
  $legacyFull = [System.IO.Path]::GetFullPath($legacyUserData).TrimEnd("\")
  $targetFull = [System.IO.Path]::GetFullPath($userDataDir).TrimEnd("\")

  if ($legacyFull -ne $targetFull) {
    Write-Host "Премествам Electron профила от C: към E: без да трия входа в ChatGPT..." -ForegroundColor Yellow

    & robocopy $legacyUserData $userDataDir /E /MOVE /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NP
    $robocopyCode = $LASTEXITCODE

    if ($robocopyCode -gt 7) {
      throw "Преместването на Electron профила се провали. Robocopy exit code: $robocopyCode"
    }

    if (Test-Path $legacyUserData) {
      Remove-Item $legacyUserData -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

$cachePaths = @(
  (Join-Path $userDataDir "Cache"),
  (Join-Path $userDataDir "Code Cache"),
  (Join-Path $userDataDir "GPUCache"),
  (Join-Path $userDataDir "DawnCache"),
  (Join-Path $userDataDir "GraphiteDawnCache"),
  (Join-Path $userDataDir "Partitions\david-soul\Code Cache"),
  (Join-Path $userDataDir "Partitions\david-soul\GPUCache"),
  (Join-Path $userDataDir "Partitions\david-soul\DawnCache"),
  (Join-Path $userDataDir "Partitions\david-soul\Network\Cache"),
  (Join-Path $userDataDir "Partitions\david-soul\Service Worker\CacheStorage"),
  (Join-Path $userDataDir "Partitions\david-soul\Shared Dictionary\cache"),
  $cacheDir
)

foreach ($path in $cachePaths) {
  if (Test-Path $path) {
    Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

New-Item -ItemType Directory -Force -Path $userDataDir, $cacheDir | Out-Null

if (!(Test-Path $electronExe)) {
  Write-Host "Electron липсва. Изпълнявам npm install..." -ForegroundColor Yellow
  npm install
}

if (!(Test-Path $electronExe)) {
  throw "Electron не е намерен: $electronExe"
}

$drive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($storageRoot).Substring(0, 1))
if ($drive.Free -lt 500MB) {
  throw "На E: има под 500 MB свободно място. Освободи място преди стартиране."
}

Write-Host "User data: $userDataDir" -ForegroundColor Green
Write-Host "Cache:     $cacheDir" -ForegroundColor Green
Write-Host "Стартирам DAVID. Остави този PowerShell отворен." -ForegroundColor Green

& $electronExe `
  "--user-data-dir=$userDataDir" `
  "--disk-cache-dir=$cacheDir" `
  "--disable-gpu-shader-disk-cache" `
  $root

exit $LASTEXITCODE
