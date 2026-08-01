$ErrorActionPreference = "Stop"

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
$Core = Join-Path $Project "core"
$Main = Join-Path $Project "main.cjs"
$Preload = Join-Path $Project "preload.cjs"
$Renderer = Join-Path $Project "renderer\renderer.js"
$SkillEngine = Join-Path $Core "skill-engine.cjs"
$Builtins = Join-Path $Core "builtin-skills.cjs"
$BrowserAgent = Join-Path $Core "browser-agent.cjs"

foreach ($File in @(
    $Project,
    $Core,
    $Main,
    $Preload,
    $Renderer,
    $SkillEngine,
    $BrowserAgent
)) {
    if (-not (Test-Path $File)) {
        throw "Липсва: $File"
    }
}

Set-Location $Project

Write-Host ""
Write-Host "=== DAVID BUILT-IN GPT SKILL ===" -ForegroundColor Cyan
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
$Backup = Join-Path $Project "backup-builtin-gpt-$Stamp"

New-Item -ItemType Directory -Path (Join-Path $Backup "core") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Backup "renderer") -Force | Out-Null

Copy-Item $Main (Join-Path $Backup "main.cjs") -Force
Copy-Item $Preload (Join-Path $Backup "preload.cjs") -Force
Copy-Item $Renderer (Join-Path $Backup "renderer\renderer.js") -Force
Copy-Item $SkillEngine (Join-Path $Backup "core\skill-engine.cjs") -Force
Copy-Item $BrowserAgent (Join-Path $Backup "core\browser-agent.cjs") -Force

if (Test-Path $Builtins) {
    Copy-Item $Builtins (Join-Path $Backup "core\builtin-skills.cjs") -Force
}

Write-Host "Backup: $Backup" -ForegroundColor DarkGray

$BuiltinsCode = @'
"use strict";

const DAVID_TEACHER_CHAT_URL =
  "https://chatgpt.com/c/6a6d7e46-3534-83eb-a42b-c981bad99c84";

function createChatGptTeacherSkill() {
  return {
    skill_key: "builtin_chatgpt_teacher_send",
    title: "Пиши в DAVID Teacher GPT разговора",
    description:
      "Вграден локален skill. Отваря постоянния DAVID Teacher разговор и изпраща зададеното съобщение.",
    version: 1,
    status: "approved",
    source: "builtin",
    risk_level: "low",
    matcher: {
      type: "regex",
      pattern:
        "^(?:пиши|pishi|напиши|napishi|прати|prati|изпрати|izprati)" +
        "(?:\\s+(?:на|в|до|do))?\\s+" +
        "(?:gpt|chatgpt)\\s+(.+)$",
      flags: "iu",
      variables: ["message"]
    },
    steps: [
      {
        action: "browser_open",
        url: DAVID_TEACHER_CHAT_URL
      },
      {
        action: "wait",
        milliseconds: 1600
      },
      {
        action: "browser_wait_selector",
        selector:
          "#prompt-textarea, " +
          "[contenteditable='true'][data-virtualkeyboard], " +
          "[contenteditable='true'].ProseMirror, " +
          "textarea[data-id='root'], textarea",
        timeout_ms: 30000
      },
      {
        action: "browser_type_selector",
        selector:
          "#prompt-textarea, " +
          "[contenteditable='true'][data-virtualkeyboard], " +
          "[contenteditable='true'].ProseMirror, " +
          "textarea[data-id='root'], textarea",
        text: "{{message}}"
      },
      {
        action: "wait",
        milliseconds: 300
      },
      {
        action: "browser_press_key",
        key: "ENTER"
      },
      {
        action: "wait",
        milliseconds: 900
      },
      {
        action: "verify_url_contains",
        value: "6a6d7e46-3534-83eb-a42b-c981bad99c84"
      },
      {
        action: "notify",
        title: "DAVID",
        text: "Съобщението е изпратено към GPT."
      }
    ]
  };
}

function getBuiltInSkills() {
  return [createChatGptTeacherSkill()];
}

module.exports = {
  DAVID_TEACHER_CHAT_URL,
  createChatGptTeacherSkill,
  getBuiltInSkills
};
'@

Set-Content $Builtins $BuiltinsCode -Encoding UTF8

$EngineCode = Get-Content $SkillEngine -Raw

$OldConstructorSignature = @'
  constructor({
    store,
    teacher,
    executor,
    maxAttempts,
    sendStatus,
    contextProvider
  }) {
'@

$NewConstructorSignature = @'
  constructor({
    store,
    teacher,
    executor,
    maxAttempts,
    sendStatus,
    contextProvider,
    builtInSkills = []
  }) {
'@

if ($EngineCode.Contains($OldConstructorSignature)) {
    $EngineCode = $EngineCode.Replace(
        $OldConstructorSignature,
        $NewConstructorSignature
    )
}
elseif ($EngineCode -notmatch 'builtInSkills\s*=\s*\[\]') {
    throw "Не намерих constructor-а в skill-engine.cjs."
}

if ($EngineCode -notmatch 'this\.builtInSkills') {
    $Anchor = '    this.contextProvider = contextProvider;'

    if (-not $EngineCode.Contains($Anchor)) {
        throw "Не намерих contextProvider в skill-engine.cjs."
    }

    $EngineCode = $EngineCode.Replace(
        $Anchor,
        $Anchor + "`r`n" +
        "    this.builtInSkills = Array.isArray(builtInSkills)`r`n" +
        "      ? builtInSkills`r`n" +
        "      : [];"
    )
}

$EngineCode = $EngineCode.Replace(
    'const existing = matchSkill(command, this.store.getSkills());',
@'
const existing = matchSkill(command, [
      ...this.builtInSkills,
      ...this.store.getSkills()
    ]);
'@
)

Set-Content $SkillEngine $EngineCode -Encoding UTF8

$MainCode = Get-Content $Main -Raw

if ($MainCode -notmatch 'getBuiltInSkills') {
    $ImportAnchor =
      'const { SkillEngine } = require("./core/skill-engine.cjs");'

    $ImportLine =
      'const { getBuiltInSkills } = require("./core/builtin-skills.cjs");'

    if (-not $MainCode.Contains($ImportAnchor)) {
        throw "Не намерих SkillEngine import в main.cjs."
    }

    $MainCode = $MainCode.Replace(
        $ImportAnchor,
        $ImportAnchor + "`r`n" + $ImportLine
    )
}

if ($MainCode -notmatch 'let pendingDavidInput = null;') {
    $VariableAnchor = 'let commandPanelOpen = false;'

    if (-not $MainCode.Contains($VariableAnchor)) {
        throw "Не намерих commandPanelOpen в main.cjs."
    }

    $MainCode = $MainCode.Replace(
        $VariableAnchor,
        $VariableAnchor + "`r`nlet pendingDavidInput = null;"
    )
}

if ($MainCode -notmatch 'function isBareChatGptIntent') {
    $FunctionAnchor = 'async function confirmAction(details) {'

    $IntentFunctions = @'
function isBareChatGptIntent(text) {
  return /^(?:пиши|pishi|напиши|napishi|прати|prati|изпрати|izprati)(?:\s+(?:на|в|до|do))?\s+(?:gpt|chatgpt)\s*[.!?]*$/iu.test(
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

    if (-not $MainCode.Contains($FunctionAnchor)) {
        throw "Не намерих confirmAction в main.cjs."
    }

    $MainCode = $MainCode.Replace(
        $FunctionAnchor,
        $IntentFunctions + $FunctionAnchor
    )
}

$SkillEngineAnchor = @'
    contextProvider: () => getRuntimeContext(config)
  });
'@

$SkillEngineReplacement = @'
    contextProvider: () => getRuntimeContext(config),
    builtInSkills: getBuiltInSkills()
  });
'@

if ($MainCode.Contains($SkillEngineAnchor)) {
    $MainCode = $MainCode.Replace(
        $SkillEngineAnchor,
        $SkillEngineReplacement
    )
}
elseif ($MainCode -notmatch 'builtInSkills:\s*getBuiltInSkills\(\)') {
    throw "Не намерих SkillEngine създаването в main.cjs."
}

$SubmitHandlerPattern =
  '(?s)  ipcMain\.handle\("david:submit-command", async \(_event, command\) => \{.*?\n  \}\);'

$SubmitHandler = @'
  ipcMain.handle("david:submit-command", async (_event, command) => {
    let text = String(command || "").trim();

    if (!text) {
      return {
        ok: false,
        message: "Напиши команда."
      };
    }

    if (
      pendingDavidInput &&
      pendingDavidInput.type === "chatgpt_message"
    ) {
      pendingDavidInput = null;
      text = `пиши на GPT ${text}`;
    } else if (isBareChatGptIntent(text)) {
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

if ($MainCode -match $SubmitHandlerPattern) {
    $MainCode = [regex]::Replace(
        $MainCode,
        $SubmitHandlerPattern,
        $SubmitHandler,
        1
    )
} else {
    throw "Не намерих submit-command handler в main.cjs."
}

$OldHide =
  '  ipcMain.on("david:hide-command-panel", closeCommandPanel);'

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

$PreloadCode = Get-Content $Preload -Raw

if ($PreloadCode -notmatch 'onRequestInput') {
    $PreloadPattern =
      'onCommandPanel:\s*\(callback\)\s*=>\s*subscribe\("david:command-panel", callback\)'

    if ($PreloadCode -match $PreloadPattern) {
        $PreloadCode = [regex]::Replace(
            $PreloadCode,
            $PreloadPattern,
@'
onCommandPanel: (callback) =>
    subscribe("david:command-panel", callback),

  onRequestInput: (callback) =>
    subscribe("david:request-input", callback)
'@,
            1
        )
    } else {
        throw "Не намерих onCommandPanel в preload.cjs."
    }
}

Set-Content $Preload $PreloadCode -Encoding UTF8

$RendererCode = Get-Content $Renderer -Raw

if ($RendererCode -notmatch 'const defaultCommandPlaceholder') {
    $RendererAnchor = 'let statusTimer = null;'

    $RendererState = @'
const defaultCommandPlaceholder =
  "Кажи какво да направя...";

let activeInputMode = null;
'@

    if (-not $RendererCode.Contains($RendererAnchor)) {
        throw "Не намерих statusTimer в renderer.js."
    }

    $RendererCode = $RendererCode.Replace(
        $RendererAnchor,
        $RendererState + "`r`n" + $RendererAnchor
    )
}

if ($RendererCode -notmatch 'window\.david\.onRequestInput') {
    $ListenerAnchor =
      'window.david.onCommandPanel(({ open }) => {'

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

    if (-not $RendererCode.Contains($ListenerAnchor)) {
        throw "Не намерих onCommandPanel в renderer.js."
    }

    $RendererCode = $RendererCode.Replace(
        $ListenerAnchor,
        $InputListener + $ListenerAnchor
    )
}

$SubmitPattern =
  '(?s)commandForm\.addEventListener\("submit", async \(event\) => \{.*?\n\}\);'

$RendererSubmit = @'
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
        $RendererSubmit,
        1
    )
} else {
    throw "Не намерих submit handler в renderer.js."
}

Set-Content $Renderer $RendererCode -Encoding UTF8

$BrowserCode = Get-Content $BrowserAgent -Raw

$TypeSelectorPattern =
  '(?s)  async typeSelector\(selector, text\) \{.*?\n  \}\n\n  async pressKey'

$TypeSelectorReplacement = @'
  async typeSelector(selector, text) {
    const window = this.ensureWindow();

    const result =
      await window.webContents.executeJavaScript(
        `(() => {
          const element =
            document.querySelector(
              ${JSON.stringify(selector)}
            );

          if (!element) {
            return {
              ok: false,
              reason: "not_found"
            };
          }

          const value =
            ${JSON.stringify(String(text))};

          element.scrollIntoView({
            block: "center",
            inline: "center"
          });

          element.focus();

          if (element.isContentEditable) {
            const selection =
              window.getSelection();

            const range =
              document.createRange();

            range.selectNodeContents(element);
            selection.removeAllRanges();
            selection.addRange(range);

            document.execCommand(
              "insertText",
              false,
              value
            );

            element.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                composed: true,
                inputType: "insertText",
                data: value
              })
            );
          } else {
            const prototype =
              element instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;

            const descriptor =
              Object.getOwnPropertyDescriptor(
                prototype,
                "value"
              );

            if (descriptor?.set) {
              descriptor.set.call(element, value);
            } else {
              element.value = value;
            }

            element.dispatchEvent(
              new Event("input", {
                bubbles: true,
                composed: true
              })
            );

            element.dispatchEvent(
              new Event("change", {
                bubbles: true,
                composed: true
              })
            );
          }

          return { ok: true };
        })()`,
        true
      );

    if (!result || !result.ok) {
      throw new Error(
        `Не намерих поле: ${selector}`
      );
    }
  }

  async pressKey
'@

if ($BrowserCode -match $TypeSelectorPattern) {
    $BrowserCode = [regex]::Replace(
        $BrowserCode,
        $TypeSelectorPattern,
        $TypeSelectorReplacement,
        1
    )
} else {
    throw "Не намерих typeSelector в browser-agent.cjs."
}

Set-Content $BrowserAgent $BrowserCode -Encoding UTF8

Write-Host ""
Write-Host "Проверявам JavaScript..." -ForegroundColor Cyan

foreach ($File in @(
    $Builtins,
    $SkillEngine,
    $Main,
    $Preload,
    $Renderer,
    $BrowserAgent
)) {
    & node.exe --check $File

    if ($LASTEXITCODE -ne 0) {
        throw "Синтактична грешка в: $File"
    }
}

& npm.cmd test

if ($LASTEXITCODE -ne 0) {
    throw "DAVID tests се провалиха."
}

Write-Host ""
Write-Host "ВГРАДЕНИЯТ GPT SKILL Е АКТИВЕН." -ForegroundColor Green
Write-Host ""
Write-Host 'Тест 1: "Пиши на GPT zdr2"' -ForegroundColor Cyan
Write-Host 'Тест 2: "Пиши на GPT" -> после "zdr2"' -ForegroundColor Cyan
Write-Host ""

Set-ExecutionPolicy -Scope Process Bypass -Force

if (Test-Path ".\START-DAVID-V2.ps1") {
    & ".\START-DAVID-V2.ps1"
}
elseif (Test-Path ".\START-DAVID-STABLE.ps1") {
    & ".\START-DAVID-STABLE.ps1"
}
else {
    & npm.cmd start
}
