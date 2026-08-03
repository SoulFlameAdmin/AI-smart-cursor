"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { validateSoulChatUrl } = require("./soul-relay-runtime-v3.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findEdgeExecutable() {
  const candidates = [
    process.env.DAVID_EDGE_EXE,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "msedge.exe";
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function sameConversation(current, target) {
  try {
    const left = new URL(String(current || ""));
    const right = new URL(String(target || ""));
    return left.hostname === right.hostname &&
      left.pathname.replace(/\/$/, "") === right.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function buildChatGptLoginUrl(target) {
  const validated = validateSoulChatUrl(target);
  const parsed = new URL(validated);
  const next = `${parsed.pathname}${parsed.search || ""}`;
  return `https://chatgpt.com/auth/login?next=${encodeURIComponent(next)}`;
}

function isChatGptUrl(value) {
  try {
    return new URL(String(value || "")).hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

class CdpConnection {
  constructor(webSocketUrl) {
    if (typeof WebSocket !== "function") {
      throw new Error("This Electron/Node version does not provide WebSocket for Edge CDP.");
    }

    this.socket = new WebSocket(webSocketUrl);
    this.sequence = 0;
    this.pending = new Map();
    this.events = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });

    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data || ""));
      } catch {
        return;
      }

      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || "CDP command failed."));
        else resolve(message.result || {});
        return;
      }

      if (message.method && this.events.has(message.method)) {
        for (const listener of this.events.get(message.method)) {
          listener(message.params || {});
        }
      }
    });

    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("Edge CDP connection closed."));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.opened;
    const id = ++this.sequence;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    try {
      this.socket.close();
    } catch {}
  }
}

class EdgeSoulBrowserAgent {
  constructor({ sendStatus, chatUrl, rootDir }) {
    this.sendStatus = sendStatus;
    this.chatUrl = validateSoulChatUrl(chatUrl);
    this.loginUrl = buildChatGptLoginUrl(this.chatUrl);
    this.rootDir = rootDir;
    this.port = Number(process.env.DAVID_EDGE_DEBUG_PORT || 9333);
    this.profileDir = process.env.DAVID_EDGE_PROFILE_DIR ||
      path.join(rootDir, ".david-system", "edge-soul-profile");
    this.edgeExe = findEdgeExecutable();
    this.edgeProcess = null;
    this.connection = null;
    this.targetId = null;
    this.lastDiagnostics = null;
    this.reportLog = [];
  }

  async showReport(stage, message, details = {}, kind = "working") {
    const text = String(message || stage || "DAVID SOUL is working.");
    this.reportLog.push({ stage, message: text, details, kind, at: Date.now() });
    this.reportLog = this.reportLog.slice(-30);
    this.sendStatus(text, kind, { stage, details });
    return true;
  }

  async debuggerJson(pathname = "/json/list", options = {}) {
    const response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
      signal: AbortSignal.timeout(3000),
      ...options
    });
    if (!response.ok) throw new Error(`Edge debugger HTTP ${response.status}.`);
    return response.json();
  }

  async debuggerReady() {
    try {
      const version = await this.debuggerJson("/json/version");
      return Boolean(version?.webSocketDebuggerUrl);
    } catch {
      return false;
    }
  }

  startEdge() {
    fs.mkdirSync(this.profileDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${this.port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=msEdgeSidebarV2",
      "--new-window",
      this.chatUrl
    ];

    this.edgeProcess = spawn(this.edgeExe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    this.edgeProcess.unref();
  }

  async ensureEdge() {
    if (!(await this.debuggerReady())) {
      await this.showReport(
        "opening_edge",
        "DAVID opens Microsoft Edge with the permanent SOUL profile.",
        { profile: this.profileDir, debug_address: `127.0.0.1:${this.port}` },
        "working"
      );
      this.startEdge();
    }

    const started = Date.now();
    while (Date.now() - started < 30000) {
      if (await this.debuggerReady()) return true;
      await sleep(500);
    }

    throw new Error(
      `Microsoft Edge did not expose the DAVID debugging port ${this.port}. ` +
      "Close the dedicated DAVID Edge window and restart SOUL mode."
    );
  }

  async findOrCreateTarget() {
    const targets = await this.debuggerJson("/json/list");
    let target = targets.find((item) =>
      item.type === "page" && sameConversation(item.url, this.chatUrl)
    );

    if (!target) {
      target = targets.find((item) => item.type === "page" && isChatGptUrl(item.url));
    }

    if (!target) {
      const encoded = encodeURIComponent(this.chatUrl);
      target = await this.debuggerJson(`/json/new?${encoded}`, { method: "PUT" });
    }

    if (!target?.webSocketDebuggerUrl) {
      throw new Error("DAVID could not find the ChatGPT tab in Microsoft Edge.");
    }

    return target;
  }

  async connect() {
    await this.ensureEdge();
    const target = await this.findOrCreateTarget();

    if (this.connection && this.targetId === target.id) return this.connection;
    this.connection?.close();
    this.connection = new CdpConnection(target.webSocketDebuggerUrl);
    this.targetId = target.id;
    await this.connection.send("Runtime.enable");
    await this.connection.send("Page.enable");
    await this.connection.send("Page.bringToFront").catch(() => {});
    return this.connection;
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const connection = await this.connect();
    const result = await connection.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Edge page evaluation failed.");
    }
    return result.result?.value;
  }

  async navigate(url) {
    const connection = await this.connect();
    await connection.send("Page.navigate", { url });
    await connection.send("Page.bringToFront").catch(() => {});
  }

  async diagnostics() {
    const value = await this.evaluate(`(() => {
      const clean = (v) => String(v || '').trim();
      const prompt = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], textarea');
      const body = clean(document.body?.innerText || '');
      return {
        url: location.href,
        title: document.title,
        promptCount: prompt ? 1 : 0,
        bodyLength: body.length,
        loginVisible: /log in|sign in|continue with|вход|влизане|продължи с/i.test(body),
        authPage: /\\/auth\\/|\\/login|\\/onboarding|\\/welcome/i.test(location.pathname),
        readyState: document.readyState
      };
    })()`);
    this.lastDiagnostics = value;
    return value;
  }

  async openIfNeeded(url = this.chatUrl) {
    const target = validateSoulChatUrl(url);
    const loginUrl = buildChatGptLoginUrl(target);
    await this.connect();

    const started = Date.now();
    let lastNavigate = 0;
    let lastReport = 0;
    let loginNavigationAttempted = false;

    while (Date.now() - started < 10 * 60 * 1000) {
      const info = await this.diagnostics().catch(() => null);
      const current = info?.url || "";
      const now = Date.now();
      const elapsed = now - started;
      const promptReady = Number(info?.promptCount || 0) > 0;

      if (sameConversation(current, target) && promptReady) {
        await this.showReport(
          "prompt_ready",
          "The fixed ChatGPT session is open in Microsoft Edge. DAVID is waiting for SOUL.",
          info,
          "ready"
        );
        return true;
      }

      if (promptReady && !sameConversation(current, target) && now - lastNavigate > 3000) {
        lastNavigate = now;
        await this.showReport(
          "opening_fixed_chat",
          "ChatGPT login is active. DAVID opens the fixed SOUL conversation.",
          info || {},
          "working"
        );
        await this.navigate(target);
        await sleep(1400);
        continue;
      }

      if (!isChatGptUrl(current) && now - lastNavigate > 3000) {
        lastNavigate = now;
        await this.navigate(target);
        await sleep(1400);
        continue;
      }

      const blankOrSignedOut = Boolean(info) && (
        info.authPage ||
        info.loginVisible ||
        (elapsed > 5000 && Number(info.bodyLength || 0) < 80)
      );

      if (
        blankOrSignedOut &&
        !info?.authPage &&
        !loginNavigationAttempted &&
        now - lastNavigate > 3000
      ) {
        loginNavigationAttempted = true;
        lastNavigate = now;
        await this.showReport(
          "opening_login",
          "DAVID opens the ChatGPT login page in the dedicated Edge profile.",
          info || {},
          "working"
        );
        await this.navigate(loginUrl);
        await sleep(1400);
        continue;
      }

      if (now - lastReport > 2000) {
        lastReport = now;
        const loginRequired = Boolean(info?.authPage || info?.loginVisible || blankOrSignedOut);
        await this.showReport(
          loginRequired ? "login_required" : "waiting_chatgpt",
          loginRequired
            ? "Log in to ChatGPT in the Microsoft Edge window. DAVID will continue automatically."
            : "DAVID is waiting for the fixed ChatGPT session to finish loading.",
          info || {},
          loginRequired ? "login_required" : "working"
        );
      }

      await sleep(700);
    }

    throw new Error("DAVID waited 10 minutes for ChatGPT login in Microsoft Edge.");
  }

  async getSnapshot() {
    return this.evaluate(`(() => {
      const clean = (value) => String(value || '').replace(/\\u200b/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
      const candidates = [];
      const seen = new Set();
      const add = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        candidates.push(node);
      };
      for (const node of document.querySelectorAll('[data-testid^="conversation-turn-"]')) add(node);
      for (const node of document.querySelectorAll('article')) add(node);
      for (const roleNode of document.querySelectorAll('[data-message-author-role]')) {
        add(roleNode.closest('[data-testid^="conversation-turn-"]') || roleNode.closest('article') || roleNode);
      }

      const messages = [];
      for (const turn of candidates) {
        const roleNode = turn.matches?.('[data-message-author-role]')
          ? turn
          : turn.querySelector?.('[data-message-author-role]');
        const role = clean(roleNode?.getAttribute?.('data-message-author-role')).toLowerCase();
        if (role !== 'assistant' && role !== 'user') continue;
        const preferred = role === 'assistant'
          ? turn.querySelector?.('.markdown, [class*="markdown"], [class*="prose"], [data-testid*="assistant-message"]')
          : roleNode;
        const text = clean(preferred?.innerText || preferred?.textContent || turn.innerText || '');
        if (text) messages.push({ role, text });
      }

      const assistants = messages.filter((item) => item.role === 'assistant');
      const users = messages.filter((item) => item.role === 'user');
      const lastAssistant = assistants.at(-1)?.text || '';
      const lastUser = users.at(-1)?.text || '';
      const generating = Boolean(document.querySelector(
        'button[data-testid="stop-button"], [data-is-streaming="true"], .result-streaming, [class*="result-streaming"]'
      ));
      const body = clean(document.body?.innerText || '').toLowerCase();
      let pageError = '';
      if (body.includes('something went wrong')) pageError = 'ChatGPT showed Something went wrong.';
      else if (body.includes('network error')) pageError = 'ChatGPT showed a network error.';
      else if (body.includes('conversation not found')) pageError = 'The fixed ChatGPT conversation was not found.';

      return {
        assistantCount: assistants.length,
        userCount: users.length,
        last: lastAssistant,
        lastLength: lastAssistant.length,
        lastUser,
        generating,
        pageError,
        url: location.href
      };
    })()`);
  }

  async focusPrompt() {
    return this.evaluate(`(() => {
      const prompt = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], textarea');
      if (!prompt) return false;
      prompt.focus();
      if (prompt.isContentEditable) {
        prompt.innerHTML = '';
        prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      } else {
        prompt.value = '';
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`);
  }

  async typePrompt(text) {
    const focused = await this.focusPrompt();
    if (!focused) throw new Error("DAVID did not find the ChatGPT prompt in Edge.");
    const connection = await this.connect();
    await connection.send("Input.insertText", { text: String(text) });
    await sleep(250);
    return String(text).length;
  }

  async sendPrompt(before) {
    const clicked = await this.evaluate(`(() => {
      const button = document.querySelector('button[data-testid="send-button"]:not([disabled]), button[aria-label*="Send"]:not([disabled]), button[aria-label*="Изпращ"]:not([disabled])');
      if (!button) return false;
      button.click();
      return true;
    })()`);

    if (!clicked) {
      const connection = await this.connect();
      await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }

    const started = Date.now();
    while (Date.now() - started < 8000) {
      const snapshot = await this.getSnapshot();
      if (snapshot.generating || snapshot.userCount > Number(before.userCount || 0) || snapshot.lastUser !== before.lastUser) {
        return snapshot;
      }
      await sleep(350);
    }
    throw new Error("DAVID placed the message, but Edge did not confirm sending it to GPT.");
  }

  async waitForAnswer(before, timeoutMs) {
    const started = Date.now();
    let stableText = "";
    let stableSince = 0;

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
        if (!snapshot.generating && Date.now() - stableSince >= 1800) {
          return String(snapshot.last).trim();
        }
      }
      await sleep(500);
    }

    throw new Error(`GPT did not finish the SOUL response in ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  async sendAndWait({ url, prompt, timeoutMs }) {
    await this.openIfNeeded(url);
    const before = await this.getSnapshot();
    await this.typePrompt(prompt);
    await this.sendPrompt(before);
    return this.waitForAnswer(before, timeoutMs);
  }
}

module.exports = {
  CdpConnection,
  EdgeSoulBrowserAgent,
  buildChatGptLoginUrl,
  findEdgeExecutable,
  isChatGptUrl,
  normalizeUrl,
  sameConversation
};
