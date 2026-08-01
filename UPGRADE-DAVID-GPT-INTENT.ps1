$ErrorActionPreference = "Stop"

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
$Main = Join-Path $Project "main.cjs"
$Preload = Join-Path $Project "preload.cjs"
$Renderer = Join-Path $Project "renderer\renderer.js"

foreach ($File in @($Main, $Preload, $Renderer)) {
    if (-not (Test-Path $File)) {
        throw "Липсва файл: $File"
    }
}

Set-Location $Project

Write-Host ""
Write-Host "=== DAVID GPT INTENT UPGRADE ===" -ForegroundColor Cyan
Write-Host "Спирам старите DAVID процеси..." -ForegroundColor Yellow

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Backup = Join-Path $Project "backup-gpt-intent-$Stamp"
New-Item -ItemType Directory -Path (Join-Path $Backup "renderer") -Force | Out-Null

Copy-Item $Main (Join-Path $Backup "main.cjs") -Force
Copy-Item $Preload (Join-Path $Backup "preload.cjs") -Force
Copy-Item $Renderer (Join-Path $Backup "renderer\renderer.js") -Force

# -------------------------------------------------------------------
# MAIN.CJS
# -------------------------------------------------------------------
$MainCode = Get-Content $Main -Raw

if ($MainCode -notmatch 'let pendingDavidInput = null;') {
    $MainCode = $MainCode.Replace(
        'let commandPanelOpen = false;',
        "let commandPanelOpen = false;`r`nlet pendingDavidInput = null;"
    )
}

if ($MainCode -notmatch 'function isChatGptWriteIntent') {
    $Anchor = 'async function confirmAction(details) {'

    $IntentFunctions = @'
function isChatGptWriteIntent(text) {
  return /^(?:пиши|pishi|напиши|napishi|изпрати|izprati)(?:\s+(?:на|в|до|do))?\s+(?:gpt|chatgpt)\s*[.!?]*$/iu.test(
    String(text || "").trim()
  );
}

function requestChatGptMessage() {
  const state =
    commandPanelState ||
    getOverlayForCursor() ||
    getPrimaryOverlay();

  pendingDavidInput = {
    type: "chatgpt_message",
    createdAt: Date.now()
  };

  safeSend(state, "david:request-input", {
    mode: "chatgpt_message",
    prompt: "Какво да изпратя на GPT?",
    placeholder: "Напиши съобщението за GPT..."
  });

  sendStatus("Какво да изпратя на GPT?", "working");
}

'@

    if (-not $MainCode.Contains($Anchor)) {
        throw "Не намерих confirmAction в main.cjs."
    }

    $MainCode = $MainCode.Replace(
        $Anchor,
        $IntentFunctions + $Anchor
    )
}

$HandlerPattern = '(?s)  ipcMain\.handle\("david:submit-command", async \(_event, command\) => \{.*?\n  \}\);'

$NewHandler = @'
  ipcMain.handle("david:submit-command", async (_event, command) => {
    let text = String(command || "").trim();

    if (!text) {
      return { ok: false, message: "Напиши команда." };
    }

    // Ако DAVID вече е попитал „Какво да изпратя?“,
    // следващият текст автоматично става съобщение към GPT.
    if (
      pendingDavidInput &&
      pendingDavidInput.type === "chatgpt_message"
    ) {
      pendingDavidInput = null;
      text = `пиши на GPT ${text}`;
    } else if (isChatGptWriteIntent(text)) {
      // „Пиши на GPT“ без съдържание не изпраща празно съобщение.
      // DAVID преминава в режим за очакване на следващия текст.
      requestChatGptMessage();

      return {
        ok: true,
        awaitingInput: true,
        inputMode: "chatgpt_message",
        message: "Какво да изпратя на GPT?"
      };
    }

    closeCommandPanel();

    try {
      return await skillEngine.handleCommand(text);
    } catch (error) {
      sendStatus(`Грешка: ${error.message}`, "error");

      return {
        ok: false,
        message: error.message
      };
    }
  });
'@

if ($MainCode -match $HandlerPattern) {
    $MainCode = [regex]::Replace(
        $MainCode,
        $HandlerPattern,
        $NewHandler,
        1
    )
} else {
    throw "Не намерих david:submit-command handler в main.cjs."
}

$OldHide = '  ipcMain.on("david:hide-command-panel", closeCommandPanel);'
$NewHide = @'
  ipcMain.on("david:hide-command-panel", () => {
    pendingDavidInput = null;
    closeCommandPanel();
  });
'@

if ($MainCode.Contains($OldHide)) {
    $MainCode = $MainCode.Replace($OldHide, $NewHide)
}

Set-Content $Main $MainCode -Encoding UTF8

# -------------------------------------------------------------------
# PRELOAD.CJS
# -------------------------------------------------------------------
$PreloadCode = Get-Content $Preload -Raw

if ($PreloadCode -notmatch 'onRequestInput') {
    $OldEnd = @'
  onCommandPanel: (callback) =>
    subscribe("david:command-panel", callback)
});
'@

    $NewEnd = @'
  onCommandPanel: (callback) =>
    subscribe("david:command-panel", callback),

  onRequestInput: (callback) =>
    subscribe("david:request-input", callback)
});
'@

    if (-not $PreloadCode.Contains($OldEnd)) {
        throw "Не намерих края на contextBridge в preload.cjs."
    }

    $PreloadCode = $PreloadCode.Replace($OldEnd, $NewEnd)
}

Set-Content $Preload $PreloadCode -Encoding UTF8

# -------------------------------------------------------------------
# RENDERER.JS
# -------------------------------------------------------------------
$RendererCode = Get-Content $Renderer -Raw

if ($RendererCode -notmatch 'const defaultCommandPlaceholder') {
    $Anchor = 'let statusTimer = null;'

    $StateBlock = @'
const defaultCommandPlaceholder =
  "Кажи какво да направя...";

let activeInputMode = null;
'@

    if (-not $RendererCode.Contains($Anchor)) {
        throw "Не намерих statusTimer в renderer.js."
    }

    $RendererCode = $RendererCode.Replace(
        $Anchor,
        $StateBlock + "`r`n" + $Anchor
    )
}

if ($RendererCode -notmatch 'window\.david\.onRequestInput') {
    $Anchor = 'window.david.onCommandPanel(({ open }) => {'

    $InputListener = @'
window.david.onRequestInput(({
  mode,
  prompt,
  placeholder
}) => {
  activeInputMode = mode || null;

  commandInput.value = "";
  commandInput.placeholder =
    placeholder || defaultCommandPlaceholder;

  showStatus(
    prompt || "Какво да изпратя?",
    "working"
  );

  commandPanel.classList.remove(
    "command-panel--hidden"
  );

  setTimeout(() => {
    commandInput.focus();
  }, 40);
});

'@

    if (-not $RendererCode.Contains($Anchor)) {
        throw "Не намерих onCommandPanel listener в renderer.js."
    }

    $RendererCode = $RendererCode.Replace(
        $Anchor,
        $InputListener + $Anchor
    )
}

$SubmitPattern = '(?s)commandForm\.addEventListener\("submit", async \(event\) => \{.*?\n\}\);'

$NewSubmit = @'
commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const command = commandInput.value.trim();
  if (!command) return;

  commandInput.value = "";

  showStatus(
    activeInputMode === "chatgpt_message"
      ? "Изпращам към GPT..."
      : "DAVID обработва командата...",
    "working"
  );

  const result =
    await window.david.submitCommand(command);

  if (result.awaitingInput) {
    // Панелът остава отворен и чака съдържанието.
    activeInputMode =
      result.inputMode || "chatgpt_message";

    return;
  }

  activeInputMode = null;
  commandInput.placeholder =
    defaultCommandPlaceholder;

  if (!result.ok) {
    showStatus(
      result.message ||
      "Командата не беше изпълнена.",
      "error"
    );
  }
});
'@

if ($RendererCode -match $SubmitPattern) {
    $RendererCode = [regex]::Replace(
        $RendererCode,
        $SubmitPattern,
        $NewSubmit,
        1
    )
} else {
    throw "Не намерих commandForm submit handler в renderer.js."
}

$OldPanelClose = @'
  } else {
    commandInput.blur();
  }
});
'@

$NewPanelClose = @'
  } else {
    activeInputMode = null;
    commandInput.placeholder =
      defaultCommandPlaceholder;
    commandInput.blur();
  }
});
'@

if ($RendererCode.Contains($OldPanelClose)) {
    $RendererCode = $RendererCode.Replace(
        $OldPanelClose,
        $NewPanelClose
    )
}

Set-Content $Renderer $RendererCode -Encoding UTF8

# -------------------------------------------------------------------
# VALIDATION
# -------------------------------------------------------------------
Write-Host ""
Write-Host "Проверявам синтаксиса..." -ForegroundColor Cyan

& node.exe --check $Main
if ($LASTEXITCODE -ne 0) {
    throw "main.cjs има синтактична грешка."
}

& node.exe --check $Preload
if ($LASTEXITCODE -ne 0) {
    throw "preload.cjs има синтактична грешка."
}

& node.exe --check $Renderer
if ($LASTEXITCODE -ne 0) {
    throw "renderer.js има синтактична грешка."
}

& npm.cmd test
if ($LASTEXITCODE -ne 0) {
    throw "DAVID tests се провалиха."
}

Write-Host ""
Write-Host "GPT INTENT UPGRADE: ГОТОВ" -ForegroundColor Green
Write-Host ""
Write-Host 'Работи така:' -ForegroundColor Cyan
Write-Host '1. "Пиши на GPT zdr2" -> изпраща веднага.'
Write-Host '2. "Пиши на GPT" -> пита "Какво да изпратя?"'
Write-Host '3. Следващият текст -> изпраща се към GPT.'
Write-Host ""

Set-ExecutionPolicy -Scope Process Bypass -Force

if (Test-Path ".\START-DAVID-V2.ps1") {
    & ".\START-DAVID-V2.ps1"
} elseif (Test-Path ".\START-DAVID-STABLE.ps1") {
    & ".\START-DAVID-STABLE.ps1"
} else {
    & npm.cmd start
}
