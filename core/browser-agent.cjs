"use strict";

const PROMPT_SELECTOR =
  "#prompt-textarea, " +
  "[contenteditable='true'][data-virtualkeyboard], " +
  "[contenteditable='true'].ProseMirror, " +
  "textarea[data-id='root'], textarea";

const SEND_SELECTOR =
  "button[data-testid='send-button']:not([disabled]), " +
  "button[aria-label='Send prompt']:not([disabled]), " +
  "button[aria-label='Изпращане на подкана']:not([disabled]), " +
  "button[aria-label='Send message']:not([disabled])";

const ASSISTANT_SELECTOR =
  "[data-message-author-role='assistant']";

const STOP_SELECTOR =
  "button[data-testid='stop-button'], " +
  "button[aria-label='Stop generating'], " +
  "button[aria-label='Спиране на генерирането']";

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
    this.teacherBaseline = null;
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
      show: false,
      frame: true,
      resizable: true,
      minimizable: true,
      maximizable: true,
      fullscreenable: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      autoHideMenuBar: true,
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

    this.window.once("ready-to-show", () => {
      const window = this.window;

      if (!window || window.isDestroyed()) {
        return;
      }

      window.maximize();
      window.show();
      window.focus();
    });

    this.window.on("page-title-updated", (event) => {
      event.preventDefault();
    });

    this.window.webContents.setWindowOpenHandler(({ url }) => {
      this.window.loadURL(validateHttpUrl(url));
      return { action: "deny" };
    });

    this.window.on("closed", () => {
      this.window = null;
      this.teacherBaseline = null;
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

    /* DAVID_CHATGPT_REDIRECT_LOAD_FIX_BEGIN */
    const navigationErrors = [];

    const getCurrentUrl = () =>
      String(window.webContents.getURL() || "");

    const isUsableChatGptPage = () => {
      const current = getCurrentUrl();

      if (!current || current.startsWith("chrome-error://")) {
        return false;
      }

      try {
        const hostname = new URL(current).hostname.toLowerCase();

        return (
          hostname === "chatgpt.com" ||
          hostname.endsWith(".chatgpt.com") ||
          hostname === "openai.com" ||
          hostname.endsWith(".openai.com")
        );
      } catch {
        return false;
      }
    };

    try {
      await window.loadURL(target);
    } catch (error) {
      navigationErrors.push(String(error?.message || error));
      await sleep(1500);

      // Chromium can report ERR_FAILED/ERR_ABORTED while a redirect or
      // authentication page has already loaded successfully.
      if (!isUsableChatGptPage()) {
        try {
          await window.loadURL("https://chatgpt.com/");
          await sleep(1000);

          await window.webContents.executeJavaScript(
            `location.assign(${JSON.stringify(target)})`,
            true
          );

          const retryStarted = Date.now();

          while (Date.now() - retryStarted < 15000) {
            if (isUsableChatGptPage()) {
              break;
            }

            await sleep(250);
          }
        } catch (retryError) {
          navigationErrors.push(
            String(retryError?.message || retryError)
          );
        }
      }
    }

    if (!isUsableChatGptPage()) {
      throw new Error(
        "DAVID Browser не успя да зареди ChatGPT: " +
        navigationErrors.join(" | ")
      );
    }
    /* DAVID_CHATGPT_REDIRECT_LOAD_FIX_END */

    if (window.isMinimized()) {
      window.restore();
    }

    if (window.isFullScreen()) {
      window.setFullScreen(false);
    }

    window.setAlwaysOnTop(false);
    window.setSkipTaskbar(false);
    window.maximize();
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

  async getAssistantState() {
    const window = this.ensureWindow();

    return window.webContents.executeJavaScript(
      `(() => {
        const nodes = Array.from(
          document.querySelectorAll(${JSON.stringify(ASSISTANT_SELECTOR)})
        );

        const last = nodes[nodes.length - 1] || null;
        const text = last
          ? String(last.innerText || last.textContent || "").trim()
          : "";

        const stopButtons = Array.from(
          document.querySelectorAll(
            ${JSON.stringify(STOP_SELECTOR)}
          )
        );

        const generating = stopButtons.some((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();

          return (
            !element.disabled &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            rect.width > 0 &&
            rect.height > 0
          );
        });

        return {
          count: nodes.length,
          text,
          generating
        };
      })()`,
      true
    );
  }

  async markTeacherState() {
    this.teacherBaseline = await this.getAssistantState();
    return this.teacherBaseline;
  }

  async waitForTeacherResponse(timeout = 120000) {
    const started = Date.now();
    const baseline = this.teacherBaseline || await this.getAssistantState();
    let stableText = "";
    let stableSince = 0;

    this.sendStatus("Чакам отговора на GPT Teacher...", "training");

    while (Date.now() - started < timeout) {
      const state = await this.getAssistantState();
      const changed =
        state.count > baseline.count ||
        (state.text && state.text !== baseline.text);

      if (changed && state.text) {
        if (state.text !== stableText) {
          stableText = state.text;
          stableSince = Date.now();
        } else {
          const stableFor = Date.now() - stableSince;

          if (
            (!state.generating && stableFor >= 1200) ||
            stableFor >= 5000
          ) {
            this.teacherBaseline = state;
            return state;
          }
        }
      } else {
        stableText = "";
        stableSince = 0;
      }

      await sleep(500);
    }

    throw new Error("GPT Teacher не завърши отговора в позволеното време.");
  }

  async sendTeacherMessage(text) {
    await this.waitForSelector(PROMPT_SELECTOR, 30000);
    await this.markTeacherState();
    await this.typeSelector(PROMPT_SELECTOR, text);
    await sleep(500);
    await this.waitForSelector(SEND_SELECTOR, 15000);
    await this.clickSelector(SEND_SELECTOR);
  }
}

module.exports = {
  BrowserAgent,
  sleep,
  validateHttpUrl,
  PROMPT_SELECTOR,
  SEND_SELECTOR,
  ASSISTANT_SELECTOR,
  STOP_SELECTOR
};
