$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$mainPath = Join-Path $PSScriptRoot "main.cjs"

if (-not (Test-Path $mainPath)) {
    throw "main.cjs не е намерен. Постави този файл в главната папка david-cursor-v1."
}

Write-Host "Спирам старите DAVID процеси..." -ForegroundColor Yellow

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $mainPath "$mainPath.backup-$timestamp" -Force

$main = Get-Content $mainPath -Raw

# 1. Добавя rendererReady към глобалните променливи.
if ($main -notmatch 'let rendererReady = false;') {
    $main = $main -replace `
        'let commandPanelOpen = false;', `
        "let commandPanelOpen = false;`r`nlet rendererReady = false;"
}

# 2. Заменя директното изпращане със защитена safeSend функция.
$oldSendStatusPattern = '(?s)function sendStatus\(message, kind = "info"\) \{.*?\n\}'

$newSendStatus = @'
function safeSend(channel, payload) {
  if (
    !rendererReady ||
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    !overlayWindow.webContents ||
    overlayWindow.webContents.isDestroyed()
  ) {
    return false;
  }

  try {
    overlayWindow.webContents.send(channel, payload);
    return true;
  } catch (error) {
    rendererReady = false;

    if (process.env.DAVID_DEV === "1" || process.env.DAVID_DEV === "true") {
      console.warn(`DAVID safeSend skipped: ${error.message}`);
    }

    return false;
  }
}

function sendStatus(message, kind = "info") {
  safeSend("david:status", { message, kind });
}
'@

if ($main -match $oldSendStatusPattern) {
    $main = [regex]::Replace(
        $main,
        $oldSendStatusPattern,
        $newSendStatus,
        1
    )
} else {
    throw "Не намерих sendStatus функцията в main.cjs."
}

# 3. Заменя директния command-panel send.
$main = $main.Replace(
    '  overlayWindow.webContents.send("david:command-panel", { open: commandPanelOpen });',
    '  safeSend("david:command-panel", { open: commandPanelOpen });'
)

# 4. Добавя lifecycle събития след loadFile.
$loadFileLine = '  overlayWindow.loadFile(path.join(__dirname, "renderer", "index.html"));'

$lifecycleBlock = @'
  overlayWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  overlayWindow.webContents.on("did-start-loading", () => {
    rendererReady = false;
  });

  overlayWindow.webContents.on("did-finish-load", () => {
    rendererReady = true;
  });

  overlayWindow.webContents.on("render-process-gone", (_event, details) => {
    rendererReady = false;
    console.error("DAVID renderer stopped:", details.reason);
  });

  overlayWindow.webContents.on("destroyed", () => {
    rendererReady = false;
  });
'@

if ($main -notmatch 'DAVID renderer stopped:') {
    if ($main.Contains($loadFileLine)) {
        $main = $main.Replace($loadFileLine, $lifecycleBlock)
    } else {
        throw "Не намерих overlayWindow.loadFile в main.cjs."
    }
}

# 5. Заменя pointer таймера със защитена версия.
$timerPattern = '(?s)  pointerTimer = setInterval\(\(\) => \{.*?\n  \}, (?:8|16)\);'

$safeTimer = @'
  if (pointerTimer) {
    clearInterval(pointerTimer);
    pointerTimer = null;
  }

  pointerTimer = setInterval(() => {
    if (
      !rendererReady ||
      !overlayWindow ||
      overlayWindow.isDestroyed() ||
      !overlayWindow.webContents ||
      overlayWindow.webContents.isDestroyed()
    ) {
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const bounds = overlayWindow.getBounds();

    safeSend("david:pointer", {
      x: cursor.x - bounds.x,
      y: cursor.y - bounds.y
    });
  }, 8);
'@

if ($main -match $timerPattern) {
    $main = [regex]::Replace(
        $main,
        $timerPattern,
        $safeTimer,
        1
    )
} else {
    throw "Не намерих pointerTimer блока в main.cjs."
}

# 6. Изчиства таймера веднага при затваряне на overlay прозореца.
$oldClosed = @'
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
'@

$newClosed = @'
  overlayWindow.on("closed", () => {
    rendererReady = false;

    if (pointerTimer) {
      clearInterval(pointerTimer);
      pointerTimer = null;
    }

    overlayWindow = null;
  });
'@

if ($main.Contains($oldClosed)) {
    $main = $main.Replace($oldClosed, $newClosed)
}

Set-Content $mainPath $main -Encoding UTF8

# 7. Създава стабилен стартов файл.
$startScript = @'
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path ".\node_modules\electron\dist\electron.exe")) {
    Write-Host "Electron binary липсва." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path ".\node_modules\dotenv\package.json")) {
    Write-Host "dotenv липсва. Изпълни npm install." -ForegroundColor Red
    exit 1
}

$env:NODE_OPTIONS = "--max-old-space-size=2048"

Write-Host "Проверявам DAVID..." -ForegroundColor Cyan
& npm.cmd test

if ($LASTEXITCODE -ne 0) {
    throw "DAVID test се провали."
}

Write-Host "Стартирам DAVID..." -ForegroundColor Green
& npm.cmd start
'@

Set-Content ".\START-DAVID-STABLE.ps1" $startScript -Encoding UTF8

Write-Host ""
Write-Host "PATCH ГОТОВ." -ForegroundColor Green
Write-Host "Стартирай с:" -ForegroundColor Cyan
Write-Host 'Set-ExecutionPolicy -Scope Process Bypass -Force; & .\START-DAVID-STABLE.ps1'
