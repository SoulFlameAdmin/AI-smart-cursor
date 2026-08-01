$ErrorActionPreference = "Stop"

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
$Renderer = Join-Path $Project "renderer\renderer.js"

if (-not (Test-Path $Renderer)) {
    throw "Не намирам renderer.js в: $Renderer"
}

Set-Location $Project

Write-Host "Спирам старите DAVID процеси..." -ForegroundColor Yellow

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $Renderer "$Renderer.backup-$Stamp" -Force

$Code = Get-Content $Renderer -Raw

# Премахва предишна версия на exact-mouse блока, ако скриптът се пусне повторно.
$ExistingPatchPattern = '(?s)// DAVID_EXACT_LOCAL_MOUSE_START.*?// DAVID_EXACT_LOCAL_MOUSE_END\s*'
$Code = [regex]::Replace($Code, $ExistingPatchPattern, "")

# Заменя стария IPC pointer handler.
$OldPointerPattern = '(?s)window\.david\.onPointer\(\(position\)\s*=>\s*\{\s*pointer\.x\s*=\s*position\.x;\s*pointer\.y\s*=\s*position\.y;\s*\}\);'

$ExactPointer = @'
// DAVID_EXACT_LOCAL_MOUSE_START
let davidLocalMouseActive = false;

// Тези координати са директно в координатната система на canvas.
// Така центърът на DAVID съвпада 1:1 с реалната мишка.
window.addEventListener(
  "mousemove",
  (event) => {
    davidLocalMouseActive = true;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  },
  { passive: true, capture: true }
);

// IPC остава само като fallback, докато Windows изпрати първия mousemove.
window.david.onPointer((position) => {
  if (davidLocalMouseActive) return;

  pointer.x = position.x;
  pointer.y = position.y;
});
// DAVID_EXACT_LOCAL_MOUSE_END
'@

if ($Code -match $OldPointerPattern) {
    $Code = [regex]::Replace($Code, $OldPointerPattern, $ExactPointer, 1)
}
elseif ($Code -notmatch 'DAVID_EXACT_LOCAL_MOUSE_START') {
    # Ако старият блок вече е променян, добавя точния handler преди status handler.
    $Anchor = 'window.david.onStatus'
    $Index = $Code.IndexOf($Anchor)

    if ($Index -lt 0) {
        throw "Не намерих подходящо място за exact-mouse patch."
    }

    $Code = $Code.Insert($Index, $ExactPointer + "`r`n")
}

# Заключва главата на следата точно върху pointer.
if ($Code -notmatch 'DAVID_EXACT_HEAD_START') {
    $OriginalPhysicsPattern = '(?s)  trail\.forEach\(\(point, index\)\s*=>\s*\{.*?\n  \}\);'

    $ExactHead = @'
  // DAVID_EXACT_HEAD_START
  // Главата е точно върху мишката. Само опашката има spring движение.
  trail[0].x = pointer.x;
  trail[0].y = pointer.y;
  trail[0].dx = 0;
  trail[0].dy = 0;

  for (let index = 1; index < trail.length; index += 1) {
    const point = trail[index];
    const previous = trail[index - 1];

    point.dx += (previous.x - point.x) * parameters.spring;
    point.dy += (previous.y - point.y) * parameters.spring;
    point.dx *= parameters.friction;
    point.dy *= parameters.friction;
    point.x += point.dx;
    point.y += point.dy;
  }
  // DAVID_EXACT_HEAD_END
'@

    if ($Code -match $OriginalPhysicsPattern) {
        $Code = [regex]::Replace(
            $Code,
            $OriginalPhysicsPattern,
            $ExactHead,
            1
        )
    }
    elseif ($Code -notmatch 'trail\[0\]\.x\s*=\s*pointer\.x') {
        throw "Не намерих physics блока за заключване на главата."
    }
}

Set-Content $Renderer $Code -Encoding UTF8

Write-Host "Exact mouse patch: ГОТОВ." -ForegroundColor Green
Write-Host "Стартирам DAVID..." -ForegroundColor Cyan

if (Test-Path ".\START-DAVID-STABLE.ps1") {
    Set-ExecutionPolicy -Scope Process Bypass -Force
    & ".\START-DAVID-STABLE.ps1"
}
else {
    & npm.cmd test

    if ($LASTEXITCODE -ne 0) {
        throw "DAVID test се провали."
    }

    & npm.cmd start
}
