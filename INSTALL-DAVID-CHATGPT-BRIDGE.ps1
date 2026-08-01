$ErrorActionPreference = "Stop"

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
$BrowserAgent = Join-Path $Project "core\browser-agent.cjs"
$DemoTeacher = Join-Path $Project "core\demo-teacher.cjs"

if (-not (Test-Path $BrowserAgent)) {
    throw "Липсва: $BrowserAgent"
}

if (-not (Test-Path $DemoTeacher)) {
    throw "Липсва: $DemoTeacher"
}

Set-Location $Project

Write-Host ""
Write-Host "=== DAVID LOCAL CHATGPT BRIDGE ===" -ForegroundColor Cyan
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
$Backup = Join-Path $Project "backup-chatgpt-bridge-$Stamp"
New-Item -ItemType Directory -Path (Join-Path $Backup "core") -Force | Out-Null

Copy-Item $BrowserAgent (Join-Path $Backup "core\browser-agent.cjs") -Force
Copy-Item $DemoTeacher (Join-Path $Backup "core\demo-teacher.cjs") -Force

$BrowserAgentCode = @'
"use strict";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateHttpUrl(value) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Разрешени са само http/https адреси.");
  }

  return url.toString();
}

class BrowserAgent {
  constructor({ BrowserWindow, sendStatus }) {
    this.BrowserWindow = BrowserWindow;
    this.sendStatus = sendStatus;
    this.window = null;
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    this.window = new this.BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      title: "DAVID Browser",
      show: true,
      backgroundColor: "#111111",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        autoplayPolicy: "no-user-gesture-required",
        partition: "persist:david-browser"
      }
    });

    this.window.webContents.setWindowOpenHandler(({ url }) => {
      this.window.loadURL(validateHttpUrl(url));
      return { action: "deny" };
    });

    this.window.on("closed", () => {
      this.window = null;
    });

    return this.window;
  }

  async open(url) {
    const target = validateHttpUrl(url);
    const window = this.ensureWindow();

    this.sendStatus(
      `Отварям ${new URL(target).hostname}`,
      "working"
    );

    await window.loadURL(target);
    window.show();
    window.focus();
  }

  async waitForSelector(selector, timeout = 15000) {
    const window = this.ensureWindow();
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const exists = await window.webContents.executeJavaScript(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
        true
      );

      if (exists) return true;
      await sleep(250);
    }

    throw new Error(
      `Не намерих елемент: ${selector}. ` +
      "Ако ChatGPT иска вход, влез ръчно в DAVID Browser и повтори командата."
    );
  }

  async clickSelector(selector) {
    const window = this.ensureWindow();

    const result = await window.webContents.executeJavaScript(
      `(() => {
        const element = document.querySelector(
          ${JSON.stringify(selector)}
        );

        if (!element) {
          return { ok: false, reason: "not_found" };
        }

        element.scrollIntoView({
          block: "center",
          inline: "center"
        });

        element.click();

        return { ok: true };
      })()`,
      true
    );

    if (!result || !result.ok) {
      throw new Error(
        `Не намерих бутон/елемент: ${selector}`
      );
    }
  }

  async clickText(text) {
    const window = this.ensureWindow();

    const result = await window.webContents.executeJavaScript(
      `(() => {
        const wanted =
          ${JSON.stringify(String(text).trim().toLowerCase())};

        const nodes = Array.from(
          document.querySelectorAll(
            'button, [role="button"], a, tp-yt-paper-button'
          )
        );

        const element = nodes.find((node) =>
          String(node.innerText || node.textContent || "")
            .trim()
            .toLowerCase() === wanted
        );

        if (!element) return { ok: false };

        element.scrollIntoView({ block: "center" });
        element.click();

        return { ok: true };
      })()`,
      true
    );

    if (!result || !result.ok) {
      throw new Error(
        `Не намерих текстов бутон: ${text}`
      );
    }
  }

  async typeSelector(selector, text) {
    const window = this.ensureWindow();

    const result = await window.webContents.executeJavaScript(
      `(() => {
        const selector =
          ${JSON.stringify(selector)};

        const value =
          ${JSON.stringify(String(text))};

        const element =
          document.querySelector(selector);

        if (!element) {
          return {
            ok: false,
            reason: "not_found"
          };
        }

        element.scrollIntoView({
          block: "center",
          inline: "center"
        });

        element.focus();

        if (element.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();

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

          if (descriptor && descriptor.set) {
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

        return {
          ok: true,
          contentEditable: element.isContentEditable
        };
      })()`,
      true
    );

    if (!result || !result.ok) {
      throw new Error(
        `Не намерих поле: ${selector}`
      );
    }
  }

  async pressKey(key) {
    const window = this.ensureWindow();

    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: key
    });

    window.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: key
    });
  }

  verifyUrlContains(value) {
    const window = this.ensureWindow();
    const current = window.webContents.getURL();

    if (!current.includes(value)) {
      throw new Error(
        `Проверката на адреса се провали: ${current}`
      );
    }

    return true;
  }
}

module.exports = {
  BrowserAgent,
  sleep,
  validateHttpUrl
};
'@

$DemoTeacherCode = @'
"use strict";

const DAVID_TEACHER_CHAT_URL =
  "https://chatgpt.com/c/6a6d7e46-3534-83eb-a42b-c981bad99c84";

function buildYouTubeSkill(version = 1) {
  return {
    skill_key: "youtube_play_search_result",
    title: "Пусни изпълнител или песен в YouTube",
    description:
      "Отваря YouTube търсене в защитен DAVID Browser и стартира първия резултат.",
    version,
    status: "candidate",
    risk_level: "low",
    matcher: {
      type: "regex",
      pattern:
        "(?:отвори|otvori)\\s+(?:youtube|yt|ютуб).*?(?:пусни|pusni)\\s+(.+)",
      flags: "iu",
      variables: ["query"]
    },
    steps: [
      {
        action: "browser_open",
        url:
          "https://www.youtube.com/results?search_query={{url:query}}"
      },
      {
        action: "wait",
        milliseconds: 1800
      },
      {
        action: "browser_click_text",
        text: "Reject all",
        allow_fail: true
      },
      {
        action: "browser_click_text",
        text: "Accept all",
        allow_fail: true
      },
      {
        action: "browser_click_text",
        text: "Отхвърляне на всички",
        allow_fail: true
      },
      {
        action: "browser_click_text",
        text: "Приемане на всички",
        allow_fail: true
      },
      {
        action: "browser_wait_selector",
        selector: "ytd-video-renderer a#thumbnail",
        timeout_ms: 20000
      },
      {
        action: "browser_click_selector",
        selector: "ytd-video-renderer a#thumbnail"
      },
      {
        action: "wait",
        milliseconds: 2500
      },
      {
        action: "verify_url_contains",
        value: "watch"
      }
    ]
  };
}

function buildChatGptBridgeSkill(version = 1) {
  return {
    skill_key: "chatgpt_teacher_room_write",
    title: "Пиши в DAVID Teacher ChatGPT разговора",
    description:
      "Отваря конкретния DAVID Teacher разговор в локален постоянен DAVID Browser и изпраща текста.",
    version,
    status: "candidate",
    risk_level: "low",
    matcher: {
      type: "regex",
      pattern:
        "(?:пиши|pishi|напиши|napishi|изпрати|izprati)" +
        "(?:\\s+(?:на|в|do))?\\s+" +
        "(?:gpt|chatgpt|тук|tuk)\\s+(.+)",
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
        milliseconds: 1800
      },
      {
        action: "browser_wait_selector",
        selector:
          "#prompt-textarea, textarea[data-id='root'], textarea",
        timeout_ms: 30000
      },
      {
        action: "browser_type_selector",
        selector:
          "#prompt-textarea, textarea[data-id='root'], textarea",
        text: "{{message}}"
      },
      {
        action: "wait",
        milliseconds: 500
      },
      {
        action: "browser_wait_selector",
        selector:
          "button[data-testid='send-button']:not([disabled]), " +
          "button[aria-label='Send prompt']:not([disabled]), " +
          "button[aria-label='Изпращане на подкана']:not([disabled])",
        timeout_ms: 10000
      },
      {
        action: "browser_click_selector",
        selector:
          "button[data-testid='send-button']:not([disabled]), " +
          "button[aria-label='Send prompt']:not([disabled]), " +
          "button[aria-label='Изпращане на подкана']:not([disabled])"
      },
      {
        action: "wait",
        milliseconds: 1200
      },
      {
        action: "verify_url_contains",
        value: "6a6d7e46-3534-83eb-a42b-c981bad99c84"
      },
      {
        action: "notify",
        title: "DAVID",
        text: "Съобщението е изпратено в Teacher разговора."
      }
    ]
  };
}

function extractYouTubeQuery(command) {
  const regex =
    /(?:отвори|otvori)\s+(?:youtube|yt|ютуб).*?(?:пусни|pusni)\s+(.+)/iu;

  const match = regex.exec(command);

  return match
    ? match[1].trim()
    : null;
}

function extractChatGptMessage(command) {
  const regex =
    /(?:пиши|pishi|напиши|napishi|изпрати|izprati)(?:\s+(?:на|в|do))?\s+(?:gpt|chatgpt|тук|tuk)\s+(.+)/iu;

  const match = regex.exec(command);

  return match
    ? match[1].trim()
    : null;
}

async function createDemoPlan(command, previousSkill) {
  const chatMessage =
    extractChatGptMessage(command);

  if (chatMessage) {
    return {
      requestId: `local-chatgpt-${Date.now()}`,
      skill: buildChatGptBridgeSkill(
        Number(previousSkill?.version || 0) + 1
      )
    };
  }

  const query =
    extractYouTubeQuery(command);

  if (query) {
    return {
      requestId: `demo-youtube-${Date.now()}`,
      skill: buildYouTubeSkill(
        Number(previousSkill?.version || 0) + 1
      )
    };
  }

  return {
    requestId: `demo-${Date.now()}`,
    skill: {
      skill_key: `demo_explain_${Date.now()}`,
      title: "Нужна е връзка с DAVID Teacher",
      description:
        "Локалният demo teacher познава YouTube и локалния ChatGPT Bridge.",
      version: 1,
      status: "candidate",
      risk_level: "low",
      matcher: {
        type: "regex",
        pattern: "^$",
        flags: "u",
        variables: []
      },
      steps: [
        {
          action: "notify",
          title: "DAVID Teacher",
          text:
            "Тази команда няма local skill. Свържи Supabase + OpenAI Teacher за автоматично обучение."
        }
      ]
    }
  };
}

module.exports = {
  DAVID_TEACHER_CHAT_URL,
  buildYouTubeSkill,
  buildChatGptBridgeSkill,
  extractYouTubeQuery,
  extractChatGptMessage,
  createDemoPlan
};
'@

Set-Content $BrowserAgent $BrowserAgentCode -Encoding UTF8
Set-Content $DemoTeacher $DemoTeacherCode -Encoding UTF8

Write-Host "Проверявам синтаксиса..." -ForegroundColor Cyan

& node.exe --check $BrowserAgent
if ($LASTEXITCODE -ne 0) {
    throw "browser-agent.cjs има синтактична грешка."
}

& node.exe --check $DemoTeacher
if ($LASTEXITCODE -ne 0) {
    throw "demo-teacher.cjs има синтактична грешка."
}

& npm.cmd test
if ($LASTEXITCODE -ne 0) {
    throw "DAVID tests се провалиха."
}

Write-Host ""
Write-Host "CHATGPT BRIDGE Е ИНСТАЛИРАН." -ForegroundColor Green
Write-Host ""
Write-Host "При първо отваряне:" -ForegroundColor Yellow
Write-Host "1. Влез ръчно в ChatGPT в прозореца DAVID Browser." -ForegroundColor Yellow
Write-Host "2. Затвори или остави прозореца отворен." -ForegroundColor Yellow
Write-Host "3. Натисни Ctrl+Shift+D и кажи: пиши на GPT zdr2" -ForegroundColor Yellow
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
