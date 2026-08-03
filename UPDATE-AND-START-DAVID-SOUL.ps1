$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command exited with code $LASTEXITCODE"
  }
}

Write-Host ''
Write-Host '================================================' -ForegroundColor Cyan
Write-Host '  DAVID SOUL - UPDATE AND START' -ForegroundColor Cyan
Write-Host '================================================' -ForegroundColor Cyan
Write-Host ''

$git = Get-Command git -ErrorAction Stop
$npm = Get-Command npm -ErrorAction Stop

if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) {
  throw 'This script must be run from the DAVID Git repository.'
}

$trackedChanges = & $git.Name status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0) {
  throw 'Could not read DAVID Git status.'
}

if ($trackedChanges) {
  Write-Host '[STOP] DAVID has local tracked changes.' -ForegroundColor Yellow
  Write-Host 'Commit or restore them before updating, so nothing is lost.' -ForegroundColor Yellow
  & $git.Name status --short
  throw 'Local tracked changes detected.'
}

Write-Host '[1/5] Fetching the latest DAVID SOUL branch...' -ForegroundColor Cyan
Invoke-Checked $git.Name fetch origin feature/david-soul-relay-v1

Write-Host '[2/5] Switching to feature/david-soul-relay-v1...' -ForegroundColor Cyan
& $git.Name checkout feature/david-soul-relay-v1
if ($LASTEXITCODE -ne 0) {
  Invoke-Checked $git.Name checkout -b feature/david-soul-relay-v1 --track origin/feature/david-soul-relay-v1
}

Write-Host '[3/5] Applying the latest tested version...' -ForegroundColor Cyan
Invoke-Checked $git.Name merge --ff-only origin/feature/david-soul-relay-v1

Write-Host '[4/5] Verifying DAVID SOUL...' -ForegroundColor Cyan
Invoke-Checked $npm.Name test
Invoke-Checked (Get-Command node -ErrorAction Stop).Name --check soul-main.cjs

Write-Host '[5/5] Starting dedicated DAVID SOUL-only Electron...' -ForegroundColor Green
Write-Host 'Teacher режимът няма да бъде стартиран.' -ForegroundColor DarkGray
Write-Host 'Electron ще отвори точния DAVID_SOUL_CHAT_URL и ще чака SOUL.' -ForegroundColor DarkGray

$startScript = Join-Path $root 'START-DAVID-SOUL-ONLY.ps1'
if (-not (Test-Path -LiteralPath $startScript)) {
  throw "Missing launcher: $startScript"
}

& $startScript
if ($LASTEXITCODE -ne 0) {
  throw "DAVID SOUL stopped with exit code $LASTEXITCODE"
}
