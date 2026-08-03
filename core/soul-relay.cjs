"use strict";

const {
  CHATGPT_PROMPT_SELECTOR,
  CHATGPT_SEND_SELECTOR,
  CHATGPT_STOP_SELECTOR,
  sleep,
  validateHttpUrl
} = require("./browser-agent.cjs");
const { DeviceBridgeClient } = require("./device-bridge-client.cjs");

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function readSoulConfig() {
  return {
    supabaseUrl: process.env.SUPABASE_URL || "",
    deviceBridgeFunction:
      process.env.DAVID_DEVICE_BRIDGE_FUNCTION || "david-device-bridge",
    deviceToken: process.env.DAVID_DEVICE_TOKEN || "",
    chatUrl: process.env.DAVID_SOUL_CHAT_URL || "",
    userId: process.env.DAVID_SOUL_USER_ID || "",
    pollMs: parseInteger(process.env.DAVID_SOUL_POLL_MS, 2500, 1000, 60000),
    responseTimeoutMs: parseInteger(
      process.env.DAVID_SOUL_RESPONSE_TIMEOUT_MS ||
        process.env.DAVID_GPT_RESPONSE_TIMEOUT_MS,
      240000,
      30000,
      900000
    ),
    browserVisible: parseBoolean(
      process.env.DAVID_SOUL_BROWSER_VISIBLE,
      true
    ),
    maxMessageChars: parseInteger(
      process.env.DAVID_SOUL_MAX_MESSAGE_CHARS,
      20000,
      1000,
      100000
    )
  };
}

function validateSoulChatUrl(value) {
  const target = validateHttpUrl(value);
  const parsed = new URL(target);

  if (parsed.hostname !== "chatgpt.com" || !parsed.pathname.startsWith("/c/")) {
    throw new Error(
      "DAVID_SOUL_CHAT_URL трябва да е реален ChatGPT адрес от вида https://chatgpt.com/c/..."
    );
  }

  return target;
}

function normalizeClaimedMessage(data) {
  const item = data?.message || data?.job || data?.item || null;
  if (!item || typeof item !== "object") return null;

  const id = String(
    item.id || item.message_id || item.job_id || ""
  ).trim();
  const text = String(
    item.text || item.message || item.prompt || item.content || ""
  ).trim();

  if (!id || !text) return null;

  return {
    id,
    text,
    userId: String(item.user_id || item.userId || "").trim(),
    conversationId: String(
      item.conversation_id || item.conversationId || ""
    ).trim(),
    contextText: String(
      item.context_text || item.contextText || ""
    ).trim(),
    messages: Array.isArray(item.messages) ? item.messages : []
  };
}

function buildSoulPrompt(job, maxChars = 20000) {
  const parts = [];

  if (job.contextText) {
    parts.push(job.contextText);
  } else if (job.messages.length > 0) {
    const history = job.messages
      .slice(-30)
      .map((entry) => {
        const role = String(entry?.role || "user").toLowerCase();
        const content = String(
          entry?.content || entry?.text || entry?.message || ""
        ).trim();
        if (!content) return "";
        return `${role === "assistant" ? "SOUL" : "USER"}: ${content}`;
      })
      .filter(Boolean)
      .join("\n\n");

    if (history) parts.push(history);
  }

  parts.push(job.text);

  const prompt = parts.join("\n\n").trim();
  if (!prompt) throw new Error("SOUL получи празно съобщение.");

  if (prompt.length > maxChars) {
    return prompt.slice(prompt.length - maxChars);
  }

  return prompt;
}

class SoulBrowserAgent {
  constructor({ BrowserWindow, sendStatus, visible }) {
    this.BrowserWindow = BrowserWindow;
    this.sendStatus = sendStatus;
    this.visible = visible;
    this.window = null;
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;

    this.window = new this.BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      title: "DAVID SOUL",
      show: this.visible,
      backgroundColor: "#111111",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        autoplayPolicy: "no-user-gesture-required",
        partition: "persist:david-soul"
      }
    });

    this.window.__davidSkipFullScreenPatch = true;

    this.window.webContents.setWindowOpenHandler(({ url }) => {
      this.window.loadURL(validateHttpUrl(url));
      return { action: "deny" };
    });

    this.window.on("closed", () => {
      this.window = null;
    });

    return this.window;
  }

  async openIfNeeded(url) {
    const target = validateSoulChatUrl(url);
    const window = this.ensureWindow();
    const current = window.webContents.getURL();

    if (!current || current === "about:blank" || current !== target) {
      await window.loadURL(target);
    }

    if (this.visible) {
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
      "SOUL не намери полето на ChatGPT. Влез ръчно в прозореца DAVID SOUL и повтори командата twins."
    );
  }

  async getSnapshot() {
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
          generating: Boolean(document.querySelector(${JSON.stringify(
            CHATGPT_STOP_SELECTOR
          )}))
        };
      })()`,
      true
    );
  }

  async typePrompt(text) {
    const window = this.ensureWindow();

    const result = await window.webContents.executeJavaScript(
      `(() => {
        const element = document.querySelector(${JSON.stringify(
          CHATGPT_PROMPT_SELECTOR
        )});
        if (!element) return { ok: false };

        const value = ${JSON.stringify(String(text))};
        element.focus();

        if (element.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand("insertText", false, value);
          element.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            composed: true,
            inputType: "insertText",
            data: value
          }));
        } else {
          const prototype = element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          if (descriptor?.set) descriptor.set.call(element, value);
          else element.value = value;
          element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        }

        return { ok: true };
      })()`,
      true
    );

    if (!result?.ok) throw new Error("SOUL не успя да постави въпроса в ChatGPT.");
  }

  async pressEnter() {
    const window = this.ensureWindow();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
  }

  async sendAndWait({ url, prompt, timeoutMs }) {
    const window = await this.openIfNeeded(url);
    const before = await this.getSnapshot();

    await this.typePrompt(prompt);

    try {
      await this.waitForSelector(CHATGPT_SEND_SELECTOR, 15000);
      await window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(CHATGPT_SEND_SELECTOR)})?.click()`,
        true
      );
    } catch (error) {
      await this.pressEnter();
      await sleep(800);

      const promptStillHasText = await window.webContents.executeJavaScript(
        `(() => {
          const element = document.querySelector(${JSON.stringify(
            CHATGPT_PROMPT_SELECTOR
          )});
          return Boolean(String(element?.innerText || element?.value || "").trim());
        })()`,
        true
      );

      if (promptStillHasText) throw error;
    }

    const started = Date.now();
    let stableText = "";
    let stableSince = 0;

    while (Date.now() - started < timeoutMs) {
      const snapshot = await this.getSnapshot();
      const isNew =
        snapshot.count > Number(before.count || 0) ||
        (snapshot.last && snapshot.last !== String(before.last || ""));

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
      `SOUL GPT не завърши отговора за ${Math.round(timeoutMs / 1000)} секунди.`
    );
  }
}

class SoulRelay {
  constructor({ BrowserWindow, sendStatus }) {
    this.config = readSoulConfig();
    this.sendStatus = sendStatus;
    this.bridge = new DeviceBridgeClient({
      config: this.config,
      sendStatus
    });
    this.browser = new SoulBrowserAgent({
      BrowserWindow,
      sendStatus,
      visible: this.config.browserVisible
    });
    this.active = false;
    this.busy = false;
    this.timer = null;
    this.currentMessageId = null;
  }

  getStatus() {
    return {
      active: this.active,
      busy: this.busy,
      configured: Boolean(
        this.bridge.isConfigured() && this.config.chatUrl
      ),
      user_id: this.config.userId || null,
      current_message_id: this.currentMessageId,
      poll_ms: this.config.pollMs
    };
  }

  async start() {
    if (this.active) return this.getStatus();

    validateSoulChatUrl(this.config.chatUrl);

    if (!this.bridge.isConfigured()) {
      throw new Error(
        "SOUL няма SUPABASE_URL и DAVID_DEVICE_TOKEN. Попълни локалния .env файл."
      );
    }

    this.active = true;
    this.sendStatus(
      "SOUL режимът е активен · чакам въпроси от Twins",
      "ready"
    );

    this.schedule(0);
    return this.getStatus();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.sendStatus("SOUL режимът е спрян.", "warning");
    return this.getStatus();
  }

  schedule(delay = this.config.pollMs) {
    clearTimeout(this.timer);
    if (!this.active) return;

    this.timer = setTimeout(() => {
      this.pollOnce()
        .catch((error) => {
          this.sendStatus(`SOUL грешка: ${error.message}`, "error");
        })
        .finally(() => this.schedule());
    }, delay);
  }

  async pollOnce() {
    if (!this.active || this.busy) return;
    this.busy = true;
    let job = null;

    try {
      const claimed = await this.bridge.request("claim_soul_message", {
        user_id: this.config.userId || null,
        worker: "david-soul-relay-v1"
      });

      job = normalizeClaimedMessage(claimed);
      if (!job) return;

      if (
        this.config.userId &&
        job.userId &&
        job.userId !== this.config.userId
      ) {
        throw new Error("Получено е съобщение от различен SOUL потребител.");
      }

      this.currentMessageId = job.id;
      this.sendStatus("SOUL получи въпрос · изпращам към GPT", "working");

      const prompt = buildSoulPrompt(job, this.config.maxMessageChars);
      const answer = await this.browser.sendAndWait({
        url: this.config.chatUrl,
        prompt,
        timeoutMs: this.config.responseTimeoutMs
      });

      await this.bridge.request("complete_soul_message", {
        message_id: job.id,
        user_id: job.userId || this.config.userId || null,
        conversation_id: job.conversationId || null,
        answer
      });

      await this.bridge.logEvent("soul_message_completed", {
        message_id: job.id,
        conversation_id: job.conversationId || null,
        answer_chars: answer.length
      });

      this.sendStatus("SOUL върна отговора към Twins", "ready");
    } catch (error) {
      if (job?.id) {
        try {
          await this.bridge.request("fail_soul_message", {
            message_id: job.id,
            user_id: job.userId || this.config.userId || null,
            error: String(error.message || error).slice(0, 1000)
          });
        } catch {
          // Следващият poll или сървърният lease може да възстанови задачата.
        }
      }

      throw error;
    } finally {
      this.currentMessageId = null;
      this.busy = false;
    }
  }
}

module.exports = {
  SoulRelay,
  SoulBrowserAgent,
  buildSoulPrompt,
  normalizeClaimedMessage,
  readSoulConfig,
  validateSoulChatUrl
};
