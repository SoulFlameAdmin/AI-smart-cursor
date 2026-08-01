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

const CHATGPT_PROMPT_SELECTOR = [
  "#prompt-textarea",
  "[contenteditable='true'][data-virtualkeyboard]",
  "[contenteditable='true'].ProseMirror",
  "textarea[data-id='root']",
  "textarea"
].join(", ");

const CHATGPT_SEND_SELECTOR = [
  "button[data-testid='send-button']:not([disabled])",
  "button[aria-label='Send prompt']:not([disabled])",
  "button[aria-label='Изпращане на подкана']:not([disabled])",
  "button[aria-label='Send message']:not([disabled])"
].join(", ");

const CHATGPT_STOP_SELECTOR = [
  "button[data-testid='stop-button']",
  "button[aria-label*='Stop generating']",
  "button[aria-label*='Спиране на генерирането']",
  "button[aria-label*='Stop']"
].join(", ");

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

  async openIfNeeded(url) {
    const target = validateHttpUrl(url);
    const window = this.ensureWindow();
    const current = window.webContents.getURL();

    if (!current || current === "about:blank" || current !== target) {
      await this.open(target);
    } else {
      window.show();
      window.focus();
    }

    await this.waitForSelector(CHATGPT_PROMPT_SELECTOR, 45000);
    return window;
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

  async getChatGptSnapshot() {
    const window = this.ensureWindow();

    return window.webContents.executeJavaScript(
      `(() => {
        const nodes = Array.from(
          document.querySelectorAll('[data-message-author-role="assistant"]')
        );
        const messages = [];
        const seen = new Set();

        for (const node of nodes) {
          const container = node.closest('article') || node;
          const text = String(container.innerText || node.innerText || "").trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          messages.push(text);
        }

        const last = messages[messages.length - 1] || "";
        return {
          count: messages.length,
          last,
          last_length: last.length,
          generating: Boolean(document.querySelector(${JSON.stringify(CHATGPT_STOP_SELECTOR)})),
          url: location.href
        };
      })()`,
      true
    );
  }

  async sendChatGptMessage(message) {
    const window = this.ensureWindow();
    window.show();
    window.focus();

    await this.waitForSelector(CHATGPT_PROMPT_SELECTOR, 30000);
    const before = await this.getChatGptSnapshot();
    await this.typeSelector(CHATGPT_PROMPT_SELECTOR, String(message));

    try {
      await this.waitForSelector(CHATGPT_SEND_SELECTOR, 15000);
      await this.clickSelector(CHATGPT_SEND_SELECTOR);
    } catch (error) {
      // React UI selectors occasionally change. Enter is the visible Electron fallback.
      await this.pressKey("ENTER");
      await sleep(800);

      const promptStillHasText = await window.webContents.executeJavaScript(
        `(() => {
          const element = document.querySelector(${JSON.stringify(CHATGPT_PROMPT_SELECTOR)});
          if (!element) return false;
          return Boolean(String(element.innerText || element.value || "").trim());
        })()`,
        true
      );

      if (promptStillHasText) throw error;
    }

    return before;
  }

  async waitForChatGptResponse({ before, timeoutMs = 240000 }) {
    const started = Date.now();
    let stableText = "";
    let stableSince = 0;

    while (Date.now() - started < timeoutMs) {
      const snapshot = await this.getChatGptSnapshot();
      const isNew =
        snapshot.count > Number(before?.count || 0) ||
        (snapshot.last && snapshot.last !== String(before?.last || ""));

      if (isNew && snapshot.last) {
        if (snapshot.last !== stableText) {
          stableText = snapshot.last;
          stableSince = Date.now();
        }

        if (!snapshot.generating && Date.now() - stableSince >= 2200) {
          return snapshot.last;
        }
      }

      await sleep(500);
    }

    throw new Error(
      `GPT не завърши отговора за ${Math.round(timeoutMs / 1000)} секунди.`
    );
  }
}

module.exports = {
  BrowserAgent,
  CHATGPT_PROMPT_SELECTOR,
  CHATGPT_SEND_SELECTOR,
  CHATGPT_STOP_SELECTOR,
  sleep,
  validateHttpUrl
};
