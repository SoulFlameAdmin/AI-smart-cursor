"use strict";

const { sleep, validateHttpUrl } = require("./browser-agent.cjs");
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

  const id = String(item.id || item.message_id || item.job_id || "").trim();
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
  return prompt.length > maxChars ? prompt.slice(prompt.length - maxChars) : prompt;
}

function pageFindPrompt() {
  const visible = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0 && rect.width >= 120 && rect.height >= 20 &&
      rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };

  const selectors = [
    "#prompt-textarea",
    "[data-testid='prompt-textarea']",
    "[contenteditable='true'][role='textbox']",
    "[contenteditable='true'][data-virtualkeyboard]",
    "[contenteditable='true'].ProseMirror",
    "form [contenteditable='true']",
    "textarea[data-id='root']",
    "textarea[placeholder]",
    "textarea"
  ];

  const found = [];
  const seen = new Set();

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element) || !visible(element)) continue;
      if (element.matches("[disabled], [aria-disabled='true']")) continue;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      const label = [
        element.id,
        element.getAttribute("data-testid"),
        element.getAttribute("role"),
        element.getAttribute("placeholder"),
        element.getAttribute("data-placeholder"),
        element.getAttribute("aria-label")
      ].filter(Boolean).join(" ");
      let score = 0;
      if (element.id === "prompt-textarea") score += 220;
      if (/prompt/i.test(label)) score += 170;
      if (element.getAttribute("role") === "textbox") score += 100;
      if (element.isContentEditable) score += 80;
      if (element.tagName === "TEXTAREA") score += 70;
      if (/message|prompt|ask|съобщ|подкан|питай/i.test(label)) score += 70;
      if (element.closest("form")) score += 40;
      if (rect.top > innerHeight * 0.45) score += 50;
      found.push({ element, score, label: label.slice(0, 160), rect });
    }
  }

  found.sort((a, b) => b.score - a.score);
  return found;
}

function pageDiagnostics() {
  const found = pageFindPrompt();
  const body = String(document.body?.innerText || "").slice(0, 12000);
  const lower = body.toLowerCase();
  const url = location.href;
  let blocker = "";

  if (/\/auth\/login|\/login(?:[/?#]|$)/i.test(url)) {
    blocker = "ChatGPT иска вход в профила.";
  } else if (
    lower.includes("verify you are human") ||
    lower.includes("checking your browser") ||
    lower.includes("cloudflare")
  ) {
    blocker = "ChatGPT показва проверка, която трябва да се потвърди ръчно.";
  } else if (
    lower.includes("conversation not found") ||
    lower.includes("unable to load conversation")
  ) {
    blocker = "Постоянният ChatGPT разговор не е достъпен в този профил.";
  } else if (found.length === 0 && (lower.includes("log in") || lower.includes("sign up"))) {
    blocker = "ChatGPT не е влязъл в профила.";
  }

  return {
    url,
    title: document.title,
    readyState: document.readyState,
    promptCount: found.length,
    prompt: found[0] ? {
      tag: found[0].element.tagName,
      label: found[0].label,
      score: found[0].score,
      rect: {
        x: Math.round(found[0].rect.x),
        y: Math.round(found[0].rect.y),
        width: Math.round(found[0].rect.width),
        height: Math.round(found[0].rect.height)
      }
    } : null,
    blocker,
    bodyPreview: body.replace(/\s+/g, " ").slice(0, 400)
  };
}

function pageFocusPrompt() {
  const found = pageFindPrompt();
  const element = found[0]?.element;
  if (!element) return { ok: false, reason: "prompt_not_found" };
  element.scrollIntoView({ block: "center", inline: "nearest" });
  element.click();
  element.focus();
  return {
    ok: document.activeElement === element || element.contains(document.activeElement),
    tag: element.tagName,
    contentEditable: Boolean(element.isContentEditable)
  };
}

function pageReadPrompt() {
  const active = document.activeElement;
  if (!active) return "";
  return String(
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? active.value
      : active.innerText || active.textContent || ""
  ).trim();
}

function pageSetPromptFallback(value) {
  const active = document.activeElement;
  if (!active) return { ok: false, reason: "active_prompt_missing" };
  const element = active;
  element.focus();

  if (element.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete", false);
    const inserted = document.execCommand("insertText", false, String(value));
    if (!inserted || !String(element.innerText || element.textContent || "").trim()) {
      element.textContent = String(value);
    }
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: String(value)
    }));
  } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, String(value));
    else element.value = String(value);
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  const text = String(
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : element.innerText || element.textContent || ""
  ).trim();
  return { ok: text.length > 0, length: text.length };
}

function pageClickSend() {
  const visible = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0 && rect.width >= 20 && rect.height >= 20 &&
      rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };

  const buttons = Array.from(document.querySelectorAll("button"))
    .filter((button) => visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true")
    .map((button) => {
      const label = [
        button.getAttribute("data-testid"),
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.innerText
      ].filter(Boolean).join(" ");
      let score = 0;
      if (/send-button/i.test(label)) score += 220;
      if (/send|изпращ/i.test(label)) score += 140;
      if (button.type === "submit") score += 60;
      if (button.closest("form")) score += 40;
      return { button, score, label };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (buttons[0]) {
    buttons[0].button.click();
    return { ok: true, method: "button", label: buttons[0].label.slice(0, 120) };
  }

  const form = document.activeElement?.closest?.("form");
  if (form && typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return { ok: true, method: "requestSubmit" };
  }

  return { ok: false, reason: "send_button_not_found" };
}

function pageSnapshot() {
  const clean = (value) => String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const collect = (role) => {
    const nodes = Array.from(document.querySelectorAll(`[data-message-author-role="${role}"]`));
    const messages = [];
    const seen = new Set();
    for (const node of nodes) {
      const container = node.closest("[data-testid^='conversation-turn-']") || node.closest("article") || node;
      const preferred = container.querySelector?.(".markdown") || container.querySelector?.("[class*='markdown']") || node;
      const text = clean(preferred.innerText || preferred.textContent || "");
      if (!text || seen.has(text)) continue;
      seen.add(text);
      messages.push(text);
    }
    return messages;
  };

  const assistants = collect("assistant");
  const users = collect("user");
  const last = assistants[assistants.length - 1] || "";
  const lastUser = users[users.length - 1] || "";
  const generating = Array.from(document.querySelectorAll("button")).some((button) => {
    const label = clean([
      button.getAttribute("data-testid"),
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.innerText
    ].filter(Boolean).join(" ")).toLowerCase();
    return label.includes("stop-button") || label.includes("stop generating") ||
      label.includes("спиране на генерирането") || label === "stop";
  });
  const body = clean(document.body?.innerText || "").toLowerCase();
  let pageError = "";
  if (body.includes("something went wrong")) pageError = "ChatGPT показа Something went wrong.";
  else if (body.includes("network error")) pageError = "ChatGPT показа network error.";

  return {
    assistantCount: assistants.length,
    userCount: users.length,
    last,
    lastLength: last.length,
    lastUser,
    generating,
    pageError,
    url: location.href
  };
}

function pageUpdateHud(payload) {
  const id = "david-soul-live-report";
  let root = document.getElementById(id);
  if (!root) {
    root = document.createElement("section");
    root.id = id;
    root.setAttribute("aria-live", "polite");
    Object.assign(root.style, {
      position: "fixed",
      top: "18px",
      right: "18px",
      width: "min(390px, calc(100vw - 36px))",
      maxHeight: "calc(100vh - 36px)",
      overflow: "hidden",
      zIndex: "2147483647",
      pointerEvents: "none",
      color: "#f7f7f8",
      background: "rgba(14,16,20,.94)",
      border: "1px solid rgba(255,255,255,.18)",
      borderRadius: "16px",
      boxShadow: "0 18px 60px rgba(0,0,0,.45)",
      backdropFilter: "blur(16px)",
      fontFamily: "Inter,system-ui,-apple-system,Segoe UI,sans-serif",
      padding: "14px"
    });
    document.documentElement.appendChild(root);
  }

  const kind = String(payload?.kind || "working");
  const badgeColor = kind === "error" ? "#ff6b6b" : kind === "ready" ? "#4ade80" : "#fbbf24";
  const events = Array.isArray(payload?.events) ? payload.events.slice(-8) : [];
  root.innerHTML = "";

  const head = document.createElement("div");
  Object.assign(head.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" });
  const title = document.createElement("strong");
  title.textContent = "DAVID SOUL · РЕАЛЕН ОТЧЕТ";
  Object.assign(title.style, { fontSize: "13px", letterSpacing: ".03em" });
  const badge = document.createElement("span");
  badge.textContent = String(payload?.stage || "working").toUpperCase();
  Object.assign(badge.style, { color: badgeColor, border: `1px solid ${badgeColor}`, borderRadius: "999px", padding: "3px 8px", fontSize: "10px", fontWeight: "800" });
  head.append(title, badge);

  const message = document.createElement("div");
  message.textContent = String(payload?.message || "DAVID работи...");
  Object.assign(message.style, { marginTop: "10px", fontSize: "13px", lineHeight: "1.4", fontWeight: "650" });
  const route = document.createElement("div");
  route.textContent = "Soul → DAVID Electron → GPT → Soul";
  Object.assign(route.style, { marginTop: "6px", fontSize: "10px", opacity: ".66" });
  const list = document.createElement("ol");
  Object.assign(list.style, { listStyle: "none", padding: "0", margin: "10px 0 0", display: "grid", gap: "5px", maxHeight: "210px", overflow: "hidden" });

  for (const event of events) {
    const item = document.createElement("li");
    Object.assign(item.style, { display: "grid", gridTemplateColumns: "58px 1fr", gap: "7px", fontSize: "10px", lineHeight: "1.3", opacity: ".82" });
    const time = document.createElement("time");
    time.textContent = String(event?.time || "");
    time.style.opacity = ".62";
    const text = document.createElement("span");
    text.textContent = String(event?.message || event?.stage || "");
    item.append(time, text);
    list.appendChild(item);
  }

  root.append(head, message, route, list);
  return true;
}

class SoulBrowserAgent {
  constructor({ BrowserWindow, sendStatus, visible }) {
    this.BrowserWindow = BrowserWindow;
    this.sendStatus = sendStatus;
    this.visible = visible;
    this.window = null;
    this.reportLog = [];
    this.lastDiagnostics = null;
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
    this.window.webContents.on("did-finish-load", () => {
      this.renderReport().catch(() => {});
    });
    this.window.on("closed", () => { this.window = null; });
    return this.window;
  }

  async runPage(fn, ...args) {
    const source = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
    return this.ensureWindow().webContents.executeJavaScript(source, true);
  }

  async showReport(stage, message, details = {}, kind = "working") {
    const event = {
      time: new Intl.DateTimeFormat("bg-BG", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date()),
      stage: String(stage || "working"),
      message: String(message || "DAVID работи..."),
      details
    };
    this.reportLog.push(event);
    this.reportLog = this.reportLog.slice(-20);
    if (!this.window || this.window.isDestroyed()) return false;
    return this.renderReport(stage, message, details, kind);
  }

  async renderReport(stage, message, details = {}, kind = "working") {
    if (!this.window || this.window.isDestroyed()) return false;
    const last = this.reportLog[this.reportLog.length - 1] || {};
    try {
      return await this.runPage(pageUpdateHud, {
        stage: stage || last.stage || "waiting",
        message: message || last.message || "DAVID чака въпрос от Soul.",
        details,
        kind,
        events: this.reportLog.slice(-8)
      });
    } catch {
      return false;
    }
  }

  async diagnose() {
    const diagnostics = await this.runPage(pageDiagnostics);
    this.lastDiagnostics = diagnostics;
    return diagnostics;
  }

  async openIfNeeded(url) {
    const target = validateSoulChatUrl(url);
    const window = this.ensureWindow();
    const current = window.webContents.getURL();
    await this.showReport("opening_chat", "DAVID Electron отваря постоянната GPT сесия.", { target });
    if (!current || current === "about:blank" || current !== target) await window.loadURL(target);
    if (this.visible) { window.show(); window.focus(); }
    await this.waitForPrompt(60000);
    return window;
  }

  async waitForPrompt(timeout = 45000) {
    const started = Date.now();
    let lastHudAt = 0;
    while (Date.now() - started < timeout) {
      const diagnostics = await this.diagnose();
      if (diagnostics.blocker) {
        await this.showReport("manual_action", diagnostics.blocker, diagnostics, "error");
        throw new Error(diagnostics.blocker);
      }
      if (diagnostics.promptCount > 0) {
        await this.showReport("prompt_ready", `Полето на ChatGPT е намерено · кандидати: ${diagnostics.promptCount}.`, diagnostics, "ready");
        return diagnostics;
      }
      if (Date.now() - lastHudAt >= 2000) {
        lastHudAt = Date.now();
        const elapsed = Math.round((Date.now() - started) / 1000);
        await this.showReport("finding_prompt", `DAVID търси полето за писане в ChatGPT · ${elapsed} сек.`, diagnostics);
      }
      await sleep(400);
    }
    const diagnostics = this.lastDiagnostics || {};
    throw new Error(`SOUL не намери полето на ChatGPT за ${Math.round(timeout / 1000)} сек. URL: ${diagnostics.url || "неизвестен"}.`);
  }

  async getSnapshot() {
    return this.runPage(pageSnapshot);
  }

  async typePrompt(text) {
    const window = this.ensureWindow();
    const focused = await this.runPage(pageFocusPrompt);
    if (!focused?.ok) throw new Error("SOUL не успя да фокусира полето на ChatGPT.");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "BACKSPACE" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "BACKSPACE" });
    await window.webContents.insertText(String(text));
    await sleep(250);
    let current = await this.runPage(pageReadPrompt);
    if (!current) {
      const fallback = await this.runPage(pageSetPromptFallback, String(text));
      if (!fallback?.ok) throw new Error("SOUL не успя да постави въпроса в ChatGPT.");
      current = await this.runPage(pageReadPrompt);
    }
    if (!current) throw new Error("Полето на ChatGPT остана празно след поставянето.");
    await this.showReport("prompt_filled", `Въпросът е поставен в ChatGPT · ${current.length} знака.`, { prompt_chars: current.length }, "ready");
    return current.length;
  }

  async pressEnter() {
    const window = this.ensureWindow();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
  }

  async sendPrompt(before) {
    const clicked = await this.runPage(pageClickSend);
    if (!clicked?.ok) await this.pressEnter();
    const started = Date.now();
    while (Date.now() - started < 7000) {
      const snapshot = await this.getSnapshot();
      const changed = snapshot.generating ||
        snapshot.userCount > Number(before.userCount || 0) ||
        snapshot.assistantCount > Number(before.assistantCount || 0) ||
        (snapshot.lastUser && snapshot.lastUser !== String(before.lastUser || ""));
      if (changed) {
        await this.showReport("sent_to_gpt", `Въпросът е изпратен към GPT · метод: ${clicked?.method || "Enter"}.`, {
          method: clicked?.method || "Enter",
          user_count: snapshot.userCount,
          assistant_count: snapshot.assistantCount
        }, "ready");
        return snapshot;
      }
      await sleep(350);
    }
    throw new Error("DAVID постави текста, но ChatGPT не потвърди изпращането.");
  }

  async waitForAnswer(before, timeoutMs) {
    const started = Date.now();
    let stableText = "";
    let stableSince = 0;
    let lastHudAt = 0;
    while (Date.now() - started < timeoutMs) {
      const snapshot = await this.getSnapshot();
      if (snapshot.pageError) throw new Error(snapshot.pageError);
      const isNew = snapshot.assistantCount > Number(before.assistantCount || 0) ||
        (snapshot.last && snapshot.last !== String(before.last || ""));
      if (isNew && snapshot.last) {
        if (snapshot.last !== stableText) {
          stableText = snapshot.last;
          stableSince = Date.now();
        }
        if (Date.now() - lastHudAt >= 1000) {
          lastHudAt = Date.now();
          const elapsed = Math.round((Date.now() - started) / 1000);
          await this.showReport("gpt_thinking", snapshot.generating
            ? `GPT пише отговора · ${elapsed} сек. · ${snapshot.lastLength} знака.`
            : `DAVID проверява края на отговора · ${snapshot.lastLength} знака.`, {
              elapsed_seconds: elapsed,
              answer_chars: snapshot.lastLength,
              generating: snapshot.generating
            });
        }
        if (!snapshot.generating && Date.now() - stableSince >= 1800) {
          const answer = String(snapshot.last || "").trim();
          if (!answer) throw new Error("GPT върна празен отговор.");
          await this.showReport("answer_ready", `DAVID прочете завършения GPT отговор · ${answer.length} знака.`, { answer_chars: answer.length }, "ready");
          return answer;
        }
      } else if (Date.now() - lastHudAt >= 1500) {
        lastHudAt = Date.now();
        const elapsed = Math.round((Date.now() - started) / 1000);
        await this.showReport("waiting_answer", `DAVID чака първия знак от GPT · ${elapsed} сек.`, {
          elapsed_seconds: elapsed,
          assistant_count: snapshot.assistantCount,
          generating: snapshot.generating
        });
      }
      await sleep(500);
    }
    throw new Error(`SOUL GPT не завърши отговора за ${Math.round(timeoutMs / 1000)} секунди.`);
  }

  async sendAndWait({ url, prompt, timeoutMs }) {
    try {
      await this.openIfNeeded(url);
      const before = await this.getSnapshot();
      await this.typePrompt(prompt);
      await this.sendPrompt(before);
      return await this.waitForAnswer(before, timeoutMs);
    } catch (error) {
      const diagnostics = await this.diagnose().catch(() => this.lastDiagnostics || {});
      await this.showReport("failed", String(error.message || error), diagnostics, "error");
      throw error;
    }
  }
}

class SoulRelay {
  constructor({ BrowserWindow, sendStatus }) {
    this.config = readSoulConfig();
    this.sendStatus = sendStatus;
    this.bridge = new DeviceBridgeClient({ config: this.config, sendStatus });
    this.browser = new SoulBrowserAgent({ BrowserWindow, sendStatus, visible: this.config.browserVisible });
    this.active = false;
    this.busy = false;
    this.timer = null;
    this.currentMessageId = null;
  }

  getStatus() {
    return {
      active: this.active,
      busy: this.busy,
      configured: Boolean(this.bridge.isConfigured() && this.config.chatUrl),
      user_id: this.config.userId || null,
      current_message_id: this.currentMessageId,
      poll_ms: this.config.pollMs,
      browser_diagnostics: this.browser.lastDiagnostics
    };
  }

  async start() {
    if (this.active) return this.getStatus();
    validateSoulChatUrl(this.config.chatUrl);
    if (!this.bridge.isConfigured()) {
      throw new Error("SOUL няма SUPABASE_URL и DAVID_DEVICE_TOKEN. Попълни локалния .env файл.");
    }
    this.active = true;
    this.sendStatus("SOUL режимът е активен · чакам въпроси от Twins", "ready");
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
      this.pollOnce().catch((error) => {
        this.sendStatus(`SOUL грешка: ${error.message}`, "error");
      }).finally(() => this.schedule());
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
      if (this.config.userId && job.userId && job.userId !== this.config.userId) {
        throw new Error("Получено е съобщение от различен SOUL потребител.");
      }
      this.currentMessageId = job.id;
      this.sendStatus("SOUL получи въпрос · изпращам към GPT", "working");
      const prompt = buildSoulPrompt(job, this.config.maxMessageChars);
      const answer = await this.browser.sendAndWait({ url: this.config.chatUrl, prompt, timeoutMs: this.config.responseTimeoutMs });
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
        } catch {}
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