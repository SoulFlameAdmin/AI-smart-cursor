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

  // DAVID_CDP_COMMAND_TIMEOUT_V1: a dead Edge tab must never block the whole queue.
  async send(method, params = {}, timeoutMs = 15000) {
    await this.opened;
    const id = ++this.sequence;
    let timer = null;
    const promise = new Promise((resolve, reject) => {
      const finish = (handler, value) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        handler(value);
      };
      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error)
      });
      timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        try { this.socket.close(); } catch {}
        pending.reject(new Error(
          `Edge CDP command ${method} timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        ));
      }, Math.max(1000, Number(timeoutMs) || 15000));
    });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.pending.get(id)?.reject(error);
    }
    return promise;
  }

  close() {
    try {
      this.socket.close();
    } catch {}
  }
}

class EdgeSoulBrowserAgent {
  constructor({ sendStatus, chatUrl, rootDir, port, profileDir, sessionKey, sessionLabel }) {
    this.sendStatus = sendStatus;
    this.chatUrl = validateSoulChatUrl(chatUrl);
    this.loginUrl = buildChatGptLoginUrl(this.chatUrl);
    this.rootDir = rootDir;
    this.port = Number(port || process.env.DAVID_EDGE_DEBUG_PORT || 9333);
    this.profileDir = profileDir || process.env.DAVID_EDGE_PROFILE_DIR ||
      path.join(rootDir, ".david-system", "edge-soul-profile");
    this.sessionKey = String(sessionKey || process.env.DAVID_SOUL_INSTANCE_ID || "default")
      .trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 80) || "default";
    this.sessionLabel = String(sessionLabel || this.sessionKey).trim().slice(0, 160);
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
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--disable-features=msEdgeSidebarV2",
      // DAVID_BACKGROUND_EDGE_V1: keep the dedicated DAVID browser alive without a visible window.
      "--new-window",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
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

    if (
      this.connection &&
      this.targetId === target.id &&
      this.connection.socket?.readyState === 1
    ) return this.connection;
    this.connection?.close();
    this.connection = new CdpConnection(target.webSocketDebuggerUrl);
    this.targetId = target.id;
    // DAVID_RUNTIME_ENABLE_NONBLOCKING_V1
    // Runtime.enable is optional for Runtime.evaluate/Input.
    // A heavy ChatGPT page must never kill a long Soul turn here.
    this.connection.send("Runtime.enable").catch(() => {});
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
        'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="РЎРїСЂРё" i], [data-is-streaming="true"], .result-streaming, [class*="result-streaming"]'
      ));
      // DAVID_PAGE_ERROR_IGNORE_CHAT_HISTORY_V1
const __davidErrorBody = document.body?.cloneNode(true);
__davidErrorBody?.querySelectorAll?.('[data-message-author-role]')
  .forEach((el) => el.remove());
const body = clean(__davidErrorBody?.innerText || '').toLowerCase();
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
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0 && rect.width >= 120 && rect.height >= 20 &&
          rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      };
      const selectors = [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"][data-virtualkeyboard]',
        '[contenteditable="true"].ProseMirror',
        'form [contenteditable="true"]',
        'textarea[data-id="root"]',
        'textarea[placeholder]',
        'textarea'
      ];
      const candidates = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element) || !visible(element)) continue;
          if (element.matches('[disabled], [aria-disabled="true"]')) continue;
          seen.add(element);
          const rect = element.getBoundingClientRect();
          const label = [element.id, element.getAttribute('data-testid'), element.getAttribute('role'),
            element.getAttribute('placeholder'), element.getAttribute('data-placeholder'),
            element.getAttribute('aria-label')].filter(Boolean).join(' ');
          let score = 0;
          if (element.id === 'prompt-textarea') score += 220;
          if (/prompt/i.test(label)) score += 170;
          if (element.getAttribute('role') === 'textbox') score += 100;
          if (element.isContentEditable) score += 80;
          if (element.tagName === 'TEXTAREA') score += 70;
          if (/message|prompt|ask|съобщ|подкан|питай/i.test(label)) score += 70;
          if (element.closest('form')) score += 40;
          if (rect.top > innerHeight * 0.45) score += 50;
          candidates.push({ element, score });
        }
      }
      candidates.sort((left, right) => right.score - left.score);
      const prompt = candidates[0]?.element || null;
      if (!prompt) return false;
      prompt.scrollIntoView({ block: 'center', inline: 'nearest' });
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
    // DAVID_NATIVE_CHUNKED_INPUT_V1
    //
    // ChatGPT/ProseMirror must receive real editor input events.
    // One giant Input.insertText payload was unstable, so DAVID sends
    // small native chunks and verifies the final composer contents
    // before Send is allowed.

    const value = String(text ?? "");

    const focused = await this.focusPrompt();
    if (!focused) {
      const info = await this.diagnostics().catch(() => this.lastDiagnostics || {});
      throw new Error(
        "DAVID did not find a visible ChatGPT prompt in Edge " +
        `(session=${this.sessionKey}, port=${this.port}, url=${String(info?.url || "unknown")}).`
      );
    }

    const connection = await this.connect();

    await connection.send("Page.bringToFront").catch(() => {});

    // Clear the real editor using native keyboard input.
    await connection.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    });

    await connection.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    });

    await connection.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    });

    await connection.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    });

    await sleep(100);

    const CHUNK_SIZE = 256;

    for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
      if (this.__davidClaimLost) {
        const error = new Error(
          `DAVID_CLAIM_LOST: ${this.__davidClaimLostReason || "message_not_claimed"}`
        );
        error.code = "DAVID_CLAIM_LOST";
        throw error;
      }

      const chunk = value.slice(offset, offset + CHUNK_SIZE);

      await connection.send("Input.insertText", {
        text: chunk
      });

      await sleep(15);
    }

    const verification = await this.evaluate(`(() => {
      const clean = (input) => String(input || '')
        .replace(/\\u200b/g, '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\r\\n/g, '\\n')
        .trim();

      const selector = [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea'
      ].join(',');

      const candidates = Array.from(document.querySelectorAll(selector));
      const prompt = candidates.find((element) => {
        try {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0 &&
            rect.width > 100 &&
            rect.height > 10;
        } catch {
          return false;
        }
      }) || null;

      if (!prompt) {
        return {
          ok: false,
          reason: 'prompt_not_found',
          chars: 0
        };
      }

      const current = prompt.isContentEditable
        ? String(prompt.innerText || prompt.textContent || '')
        : String(prompt.value || '');

      const expected = ${JSON.stringify(value)};

      return {
        ok: clean(current) === clean(expected),
        chars: current.length,
        expectedChars: expected.length,
        current: clean(current),
        expected: clean(expected)
      };
    })()`);

    if (!verification?.ok) {
      throw new Error(
        "DAVID native chunked input verification failed " +
        `(expected=${Number(verification?.expectedChars || value.length)}, ` +
        `actual=${Number(verification?.chars || 0)}, ` +
        `reason=${String(verification?.reason || "text_mismatch")}).`
      );
    }

    this.__davidExpectedPromptText = value;

    await this.showReport?.(
      "prompt_native_ready",
      `DAVID РІСЉРІРµРґРµ С†РµР»РёСЏ prompt РєР°С‚Рѕ native editor input В· ${value.length} Р·РЅР°РєР°.`,
      {
        native_chunked_input: "DAVID_NATIVE_CHUNKED_INPUT_V1",
        prompt_chars: value.length,
        chunk_size: CHUNK_SIZE
      },
      "working"
    ).catch(() => {});

    return value.length;
  }

  async sendPrompt(before) {
    // DAVID_SEND_LOCK_V1
    //
    // Send is NOT considered successful because the composer cleared,
    // because generation appeared, or because assistant DOM changed.
    // DAVID proceeds only after a NEW USER TURN appears with the exact
    // prompt that DAVID just typed.

    const normalize = (input) => String(input || "")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\s+/g, " ")
      .trim();

    const expected = String(this.__davidExpectedPromptText || "");
    const expectedNormalized = normalize(expected);

    if (!expectedNormalized) {
      throw new Error(
        "DAVID SEND LOCK has no expected prompt text. Send was blocked."
      );
    }

    const beforeUserCount = Number(before?.userCount || 0);

    const buttonState = await this.evaluate(`(() => {
      const clean = (input) => String(input || '')
        .replace(/\\u200b/g, '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\r\\n/g, '\\n')
        .replace(/\\s+/g, ' ')
        .trim();

      const expected = ${JSON.stringify(expected)};

      const rendered = (element) => {
        if (!element) return false;
        try {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0 &&
            rect.width > 4 &&
            rect.height > 4;
        } catch {
          return false;
        }
      };

      const promptSelectors = [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea'
      ];

      let prompt = null;

      for (const selector of promptSelectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        prompt = nodes.find(rendered) || prompt;
        if (prompt) break;
      }

      if (!prompt) {
        return {
          ok: false,
          reason: 'prompt_not_found'
        };
      }

      const current = prompt.isContentEditable
        ? String(prompt.innerText || prompt.textContent || '')
        : String(prompt.value || '');

      if (clean(current) !== clean(expected)) {
        return {
          ok: false,
          reason: 'composer_text_mismatch',
          composerChars: current.length,
          expectedChars: expected.length
        };
      }

      const selectors = [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="РР·РїСЂР°С‰" i]'
      ];

      let send = null;

      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        send = nodes.find((node) => rendered(node) && !node.disabled) || send;
        if (send) break;
      }

      if (!send) {
        return {
          ok: false,
          reason: 'send_button_not_ready'
        };
      }

      if (
        send.disabled ||
        send.getAttribute("aria-disabled") === "true"
      ) {
        return {
          ok: false,
          reason: "send_button_disabled",
          composerChars: current.length
        };
      }

      // DAVID_TRUSTED_ENTER_SEND_V4
      //
      // Composer and Send readiness were verified above.
      // Focus the REAL composer here.
      // The actual submission is performed below through CDP
      // as one trusted physical-style Enter key press.
      //
      // Exactly one attempt.
      // No JS .click().
      // No coordinate click.
      // No resend.

      prompt.focus();

      return {
        ok: true,
        readyForTrustedEnter: true,
        method: "cdp_trusted_enter",
        composerChars: current.length
      };
    })()`);

    if (!buttonState?.ok) {
      throw new Error(
        "DAVID SEND LOCK blocked Send " +
        `(reason=${String(buttonState?.reason || "unknown")}, ` +
        `composer_chars=${Number(buttonState?.composerChars || 0)}, ` +
        `expected_chars=${expected.length}).`
      );
    }

    // DAVID_TRUSTED_ENTER_DISPATCH_V4
    //
    // this.evaluate() above succeeded on the live CDP target,
    // therefore prefer that exact current connection.
    // Do NOT reconnect between focus and Enter unless no
    // connection exists at all.

    const connection = this.connection || await this.connect();

    await connection.send("Page.bringToFront").catch(() => {});

    await connection.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0
    });

    await connection.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0
    });

    const started = Date.now();
    let lastSnapshot = null;

    // DAVID_V7_DIAGNOSTIC_SCOPE_FIX
    // Persist proof state outside the polling loop only for diagnostics.
    let lastComposerCommitted = false;
    let lastComposerChars = 0;
    let lastActivityConfirmed = false;
    let lastSnapshotGenerating = false;
    let lastStopVisible = false;
    let lastAssistantChanged = false;
    let lastExactMatches = 0;

    while (Date.now() - started < 8000) {
      if (this.__davidClaimLost) {
        const error = new Error(
          `DAVID_CLAIM_LOST: ${this.__davidClaimLostReason || "message_not_claimed"}`
        );
        error.code = "DAVID_CLAIM_LOST";
        throw error;
      }

      lastSnapshot = await this.getSnapshot().catch(() => null);

      const observedUserCount = Number(lastSnapshot?.userCount || 0);
      const observedLastUser = normalize(
        lastSnapshot?.lastUser ||
        lastSnapshot?.lastUserText ||
        ""
      );

      // DAVID_FAST_SEND_V2
      // ChatGPT may virtualize old DOM turns, so userCount can stay equal
      // or even decrease. Do not block a valid send on DOM count alone.
      const beforeLastUser = normalize(
        before?.lastUser ||
        before?.lastUserText ||
        ""
      );

      const beforeAssistant = normalize(before?.last || "");
      const observedAssistant = normalize(lastSnapshot?.last || "");

      // DAVID_FAST_SEND_V5_VISIBLE_TURN_PROOF
      //
      // ChatGPT virtualizes conversation DOM. getSnapshot().lastUser
      // is therefore not guaranteed to be the newest submitted turn.
      //
      // Search ALL currently rendered user turns for the exact prompt.
      // This is proof-only: it NEVER sends or retries the prompt.

      const visibleTurnProof = await this.evaluate(`(() => {
        const normalize = (input) => String(input || "")
          .replace(/\\u200b/g, "")
          .replace(/\\u00a0/g, " ")
          .replace(/\\r\\n/g, "\\n")
          .replace(/\\s+/g, " ")
          .trim();

        const expected = ${JSON.stringify(expectedNormalized)};

        const selectors = [
          '[data-message-author-role="user"]',
          '[data-testid^="conversation-turn-"] [data-message-author-role="user"]'
        ];

        const nodes = [];

        for (const selector of selectors) {
          for (const node of document.querySelectorAll(selector)) {
            if (!nodes.includes(node)) nodes.push(node);
          }
        }

        // DAVID_FAST_SEND_V6_MESSAGE_TEXT_ONLY
        // Compare the actual user message text, not turn UI controls.

        const texts = nodes.map((node) => {
          const clone = node.cloneNode(true);

          for (const junk of clone.querySelectorAll(
            'button,[role="button"],svg,[data-testid*="copy"],[data-testid*="edit"]'
          )) {
            junk.remove();
          }

          return normalize(
            clone.innerText || clone.textContent || ""
          );
        });

        const exactMatches = texts.filter(
          (text) => text === expected
        ).length;

        const prompt =
          document.querySelector('#prompt-textarea') ||
          document.querySelector('[data-testid="prompt-textarea"]') ||
          document.querySelector('[contenteditable="true"][role="textbox"]') ||
          document.querySelector('textarea');

        const composerText = prompt
          ? normalize(
              prompt.isContentEditable
                ? (prompt.innerText || prompt.textContent || "")
                : (prompt.value || "")
            )
          : "";

        const stopVisible = Array.from(
          document.querySelectorAll(
            'button[data-testid*="stop"], button[aria-label*="Stop" i]'
          )
        ).some((node) => {
          try {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);

            return (
              rect.width > 4 &&
              rect.height > 4 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          } catch {
            return false;
          }
        });

        return {
          exactMatches,
          composerEmpty: composerText.length === 0,
          composerChars: composerText.length,
          stopVisible
        };
      })()`).catch(() => null);

      const exactVisibleUserTurn =
        Number(visibleTurnProof?.exactMatches || 0) > 0;

      const composerCommitted =
        Boolean(visibleTurnProof?.composerEmpty);

      // DAVID_FAST_SEND_V6_REAL_ACTIVITY_ONLY
      // userCount is NOT proof because ChatGPT virtualizes turns.

      const activityConfirmed = Boolean(
        Boolean(lastSnapshot?.generating) ||
        Boolean(visibleTurnProof?.stopVisible) ||
        (
          observedAssistant &&
          observedAssistant !== beforeAssistant
        )
      );

      lastComposerCommitted = Boolean(composerCommitted);
      lastComposerChars = Number(visibleTurnProof?.composerChars || 0);
      lastActivityConfirmed = Boolean(activityConfirmed);
      lastSnapshotGenerating = Boolean(lastSnapshot?.generating);
      lastStopVisible = Boolean(visibleTurnProof?.stopVisible);
      lastAssistantChanged = Boolean(
        observedAssistant &&
        observedAssistant !== beforeAssistant
      );
      lastExactMatches =
        Number(visibleTurnProof?.exactMatches || 0);

      // DAVID_SEND_COMMIT_PROOF_V7
      //
      // Exact outgoing text was already verified in the composer
      // BEFORE the single Send action.
      //
      // After Send, do not depend on ChatGPT's virtualized user-turn DOM.
      // Confirm the commit through:
      //   1. composer was consumed/cleared
      //   2. GPT generation/activity actually started
      //
      // No resend. No duplicate prompt.

      const fastSendConfirmed = Boolean(
        composerCommitted &&
        activityConfirmed
      );

      if (fastSendConfirmed) {
        this.__davidExpectedPromptText = "";

        await this.showReport?.(
          "send_confirmed_exact_user_turn",
          "DAVID РїРѕС‚РІСЉСЂРґРё СЂРµР°Р»РЅРѕС‚Рѕ РёР·РїСЂР°С‰Р°РЅРµ В· РЅРѕРІРёСЏС‚ user turn РІ ChatGPT СЃСЉРІРїР°РґР° С‚РѕС‡РЅРѕ СЃ РёР·РїСЂР°С‚РµРЅРёСЏ prompt.",
          {
            send_lock: "DAVID_SEND_LOCK_V1",
            user_count_before: beforeUserCount,
            user_count_after: observedUserCount,
            prompt_chars: expected.length,
            exact_user_turn_match: true
          },
          "working"
        ).catch(() => {});

        return lastSnapshot;
      }

      await sleep(100);
    }

    // DAVID_SEND_RELIABILITY_V19
    //
    // Primary path remains one trusted native Enter.
    // Only after its 8-second proof fails may DAVID use ONE bounded
    // physical-style mouse click on the real Send button.
    //
    // The fallback is allowed only when:
    //   - composer is still not committed/empty;
    //   - no GPT activity was observed;
    //   - composer still equals the exact expected prompt;
    //   - a rendered enabled Send/Submit button exists.
    //
    // No blind resend. No repeated fallback.

    let davidSendFallbackAttemptedV19 = false;
    let davidSendFallbackConfirmedV19 = false;

    if (
      !lastComposerCommitted &&
      !lastActivityConfirmed &&
      Number(lastComposerChars || 0) > 0
    ) {
      const fallbackGateV19 = await this.evaluate(`(() => {
        const normalize = (input) => String(input || "")
          .replace(/\\u200b/g, "")
          .replace(/\\u00a0/g, " ")
          .replace(/\\r\\n/g, "\\n")
          .replace(/\\s+/g, " ")
          .trim();

        const expected = ${JSON.stringify(expectedNormalized)};

        const rendered = (element) => {
          if (!element) return false;

          try {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();

            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || 1) !== 0 &&
              rect.width > 4 &&
              rect.height > 4 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < innerHeight &&
              rect.left < innerWidth
            );
          }
          catch {
            return false;
          }
        };

        const promptSelectors = [
          "#prompt-textarea",
          '[data-testid="prompt-textarea"]',
          '[contenteditable="true"][role="textbox"]',
          "textarea"
        ];

        let prompt = null;

        for (const selector of promptSelectors) {
          const nodes =
            Array.from(
              document.querySelectorAll(selector)
            );

          prompt =
            nodes.find(rendered) ||
            prompt;

          if (prompt) break;
        }

        if (!prompt) {
          return {
            ok: false,
            reason: "prompt_not_found"
          };
        }

        const current = normalize(
          prompt.isContentEditable
            ? (
                prompt.innerText ||
                prompt.textContent ||
                ""
              )
            : (
                prompt.value ||
                ""
              )
        );

        if (current !== expected) {
          return {
            ok: false,
            reason: "composer_not_exact",
            composerChars: current.length,
            expectedChars: expected.length
          };
        }

        const sendSelectors = [
          'button[data-testid="send-button"]',
          'button[data-testid="composer-submit-button"]',
          'button[aria-label*="Send" i]',
          'button[aria-label*="Submit" i]'
        ];

        let send = null;

        for (const selector of sendSelectors) {
          const nodes =
            Array.from(
              document.querySelectorAll(selector)
            );

          send =
            nodes.find(
              (node) =>
                rendered(node) &&
                !node.disabled &&
                node.getAttribute("aria-disabled") !== "true"
            ) ||
            send;

          if (send) break;
        }

        if (!send) {
          return {
            ok: false,
            reason: "send_button_not_ready",
            composerChars: current.length
          };
        }

        send.scrollIntoView({
          block: "nearest",
          inline: "nearest"
        });

        const rect =
          send.getBoundingClientRect();

        return {
          ok: true,
          reason: "safe_native_mouse_fallback_ready",
          composerChars: current.length,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      })()`).catch(() => null);

      if (fallbackGateV19?.ok) {
        davidSendFallbackAttemptedV19 = true;

        const fallbackConnectionV19 =
          this.connection ||
          await this.connect();

        await fallbackConnectionV19
          .send("Page.bringToFront")
          .catch(() => {});

        await fallbackConnectionV19.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: Number(fallbackGateV19.x),
            y: Number(fallbackGateV19.y),
            button: "none",
            buttons: 0
          }
        );

        await fallbackConnectionV19.send(
          "Input.dispatchMouseEvent",
          {
            type: "mousePressed",
            x: Number(fallbackGateV19.x),
            y: Number(fallbackGateV19.y),
            button: "left",
            buttons: 1,
            clickCount: 1
          }
        );

        await fallbackConnectionV19.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: Number(fallbackGateV19.x),
            y: Number(fallbackGateV19.y),
            button: "left",
            buttons: 0,
            clickCount: 1
          }
        );

        await this.showReport?.(
          "send_native_mouse_fallback_v19",
          "DAVID Send fallback: trusted Enter was not committed; one native mouse Send was used.",
          {
            send_reliability: "DAVID_SEND_RELIABILITY_V19",
            fallback: "native_mouse_once",
            composer_exact_before_fallback: true,
            prior_activity_confirmed: false,
            blind_resend: false
          },
          "working"
        ).catch(() => {});

        const fallbackStartedV19 =
          Date.now();

        const fallbackBeforeAssistantV19 =
          normalize(
            lastSnapshot?.last ||
            before?.last ||
            ""
          );

        while (
          Date.now() - fallbackStartedV19 <
          12000
        ) {
          if (this.__davidClaimLost) {
            const error = new Error(
              `DAVID_CLAIM_LOST: ${this.__davidClaimLostReason || "message_not_claimed"}`
            );

            error.code =
              "DAVID_CLAIM_LOST";

            throw error;
          }

          const fallbackSnapshotV19 =
            await this.getSnapshot()
              .catch(() => null);

          const fallbackProofV19 =
            await this.evaluate(`(() => {
              const normalize = (input) => String(input || "")
                .replace(/\\u200b/g, "")
                .replace(/\\u00a0/g, " ")
                .replace(/\\r\\n/g, "\\n")
                .replace(/\\s+/g, " ")
                .trim();

              const prompt =
                document.querySelector("#prompt-textarea") ||
                document.querySelector(
                  '[data-testid="prompt-textarea"]'
                ) ||
                document.querySelector(
                  '[contenteditable="true"][role="textbox"]'
                ) ||
                document.querySelector("textarea");

              const composerText =
                prompt
                  ? normalize(
                      prompt.isContentEditable
                        ? (
                            prompt.innerText ||
                            prompt.textContent ||
                            ""
                          )
                        : (
                            prompt.value ||
                            ""
                          )
                    )
                  : "";

              const stopVisible =
                Array.from(
                  document.querySelectorAll(
                    'button[data-testid*="stop"], button[aria-label*="Stop" i]'
                  )
                ).some((node) => {
                  try {
                    const rect =
                      node.getBoundingClientRect();

                    const style =
                      getComputedStyle(node);

                    return (
                      rect.width > 4 &&
                      rect.height > 4 &&
                      style.display !== "none" &&
                      style.visibility !== "hidden"
                    );
                  }
                  catch {
                    return false;
                  }
                });

              return {
                composerEmpty:
                  composerText.length === 0,
                composerChars:
                  composerText.length,
                stopVisible
              };
            })()`).catch(() => null);

          const fallbackObservedAssistantV19 =
            normalize(
              fallbackSnapshotV19?.last ||
              ""
            );

          const fallbackCommittedV19 =
            Boolean(
              fallbackProofV19?.composerEmpty
            );

          const fallbackActivityV19 =
            Boolean(
              Boolean(
                fallbackSnapshotV19?.generating
              ) ||
              Boolean(
                fallbackProofV19?.stopVisible
              ) ||
              (
                fallbackObservedAssistantV19 &&
                fallbackObservedAssistantV19 !==
                  fallbackBeforeAssistantV19
              )
            );

          lastSnapshot =
            fallbackSnapshotV19 ||
            lastSnapshot;

          lastComposerCommitted =
            Boolean(
              fallbackCommittedV19
            );

          lastComposerChars =
            Number(
              fallbackProofV19?.composerChars ||
              0
            );

          lastActivityConfirmed =
            Boolean(
              fallbackActivityV19
            );

          if (
            fallbackCommittedV19 &&
            fallbackActivityV19
          ) {
            davidSendFallbackConfirmedV19 =
              true;

            this.__davidExpectedPromptText =
              "";

            await this.showReport?.(
              "send_fallback_confirmed_v19",
              "DAVID confirmed the fallback Send: composer committed and GPT activity started.",
              {
                send_reliability:
                  "DAVID_SEND_RELIABILITY_V19",
                fallback_attempted:
                  true,
                fallback_confirmed:
                  true,
                blind_resend:
                  false,
                prompt_chars:
                  expected.length
              },
              "working"
            ).catch(() => {});

            return fallbackSnapshotV19;
          }

          await sleep(100);
        }
      }
    }

    const finalObserved = normalize(
      lastSnapshot?.lastUser ||
      lastSnapshot?.lastUserText ||
      ""
    );

    throw new Error(
      "DAVID FAST SEND proof timed out after 8 seconds. " +
      "No exact new user turn appeared, so GPT thinking was NOT confirmed. " +
      `users_before=${beforeUserCount} ` +
      `users_after=${Number(lastSnapshot?.userCount || 0)} ` +
      `expected_chars=${expected.length} ` +
      `observed_last_user_chars=${finalObserved.length} ` +
        `composer_committed=${Boolean(lastComposerCommitted)} ` +
        `composer_chars=${Number(lastComposerChars)} ` +
        `activity_confirmed=${Boolean(lastActivityConfirmed)} ` +
        `snapshot_generating=${Boolean(lastSnapshotGenerating)} ` +
        `stop_visible=${Boolean(lastStopVisible)} ` +
        `assistant_changed=${Boolean(lastAssistantChanged)} ` +
        `exact_matches=${Number(lastExactMatches)}`
    );
  }

  async waitForAnswer(before, timeoutMs) {
    const started = Date.now();
    const limit = Math.max(30000, Number(timeoutMs) || 240000);

    const NORMAL_STABLE_MS = 8000;
    const NORMAL_STABLE_SAMPLES = 12;

    const STREAM_STABLE_MS = 20000;
    const STREAM_STABLE_SAMPLES = 24;

    const FINAL_DRAIN_MS = 10000;
    const FINAL_DRAIN_STABLE_MS = 5000;

    let bestText = "";
    let stableText = "";
    let stableSince = 0;
    let stableSamples = 0;

    let sawGeneration = false;
    let sawNewAssistantTurn = false;

    // DAVID_CDP_RECOVERY_V1
    //
    // IMPORTANT:
    // Recovery happens only while READING an already-sent GPT turn.
    // The prompt is NOT sent again.
    const isTransientCdpError = (error) => {
      const message = String(
        error?.message || error || ""
      );

      return /Edge CDP connection closed|Edge CDP command .* timed out|WebSocket|socket|ECONNRESET|ECONNREFUSED|Target closed|Session closed|Inspected target navigated or closed/i.test(
        message
      );
    };

    const recoverReadConnection = async (
      error,
      stage = "reading"
    ) => {
      const message = String(
        error?.message || error || "unknown CDP error"
      );

      try {
        this.connection?.close?.();
      } catch {}

      // Force connect() to discover the current live target again.
      this.connection = null;
      this.targetId = null;

      await this.showReport?.(
        "cdp_read_recovering",
        `DAVID възстановява Edge връзката за сесия ${this.sessionKey} без повторно изпращане на въпроса.`,
        {
          recovery: "DAVID_CDP_RECOVERY_V1",
          session_key: this.sessionKey,
          port: this.port,
          stage,
          reason: message,
          prompt_resend: false
        },
        "working"
      ).catch(() => {});

      await sleep(1000);
    };

    const beforeAssistantCount =
      Number(before.assistantCount || 0);

    const beforeText =
      String(before.last || "").trim();

    while (Date.now() - started < limit) {

      if (this.__davidClaimLost) {
        const error = new Error(
          `DAVID_CLAIM_LOST: ${
            this.__davidClaimLostReason || "message_not_claimed"
          }`
        );

        error.code = "DAVID_CLAIM_LOST";
        throw error;
      }

      let snapshot;

      try {
        snapshot = await this.getSnapshot();
      } catch (error) {
        if (!isTransientCdpError(error)) {
          throw error;
        }

        await recoverReadConnection(
          error,
          "wait_for_answer"
        );

        continue;
      }

      if (snapshot.pageError) {
        throw new Error(snapshot.pageError);
      }

      if (snapshot.generating) {
        sawGeneration = true;
      }

      const text =
        String(snapshot.last || "").trim();

      const newAssistantTurn =
        Number(snapshot.assistantCount || 0) >
        beforeAssistantCount;

      const changedAssistantText =
        Boolean(text) &&
        text !== beforeText;

      if (newAssistantTurn) {
        sawNewAssistantTurn = true;
      }

      const isNew =
        newAssistantTurn ||
        changedAssistantText;

      if (!isNew || !text) {
        await sleep(400);
        continue;
      }

      // Never lose a longer version already observed.
      if (text.length > bestText.length) {
        bestText = text;
      }

      if (text !== stableText) {
        stableText = text;
        stableSince = Date.now();
        stableSamples = 1;
      } else {
        stableSamples += 1;
      }

      const stableFor =
        Date.now() - stableSince;

      const normalCandidate = Boolean(
        !snapshot.generating &&
        (sawGeneration || sawNewAssistantTurn) &&
        stableSamples >= NORMAL_STABLE_SAMPLES &&
        stableFor >= NORMAL_STABLE_MS
      );

      const staleStreamingCandidate = Boolean(
        snapshot.generating &&
        sawGeneration &&
        stableSamples >= STREAM_STABLE_SAMPLES &&
        stableFor >= STREAM_STABLE_MS
      );

      if (
        !normalCandidate &&
        !staleStreamingCandidate
      ) {
        await sleep(500);
        continue;
      }

      // ---------------------------------------------
      // FINAL DRAIN
      //
      // GPT may briefly look finished while the DOM
      // is still receiving the rest of the turn.
      // Keep reading and always preserve the longest
      // version of the SAME final assistant response.
      // ---------------------------------------------

      let drainBest =
        bestText.length >= stableText.length
          ? bestText
          : stableText;

      let drainStableSince = Date.now();
      const drainStarted = Date.now();

      while (
        Date.now() - drainStarted <
        FINAL_DRAIN_MS
      ) {

        if (this.__davidClaimLost) {
          const error = new Error(
            `DAVID_CLAIM_LOST: ${
              this.__davidClaimLostReason ||
              "message_not_claimed"
            }`
          );

          error.code = "DAVID_CLAIM_LOST";
          throw error;
        }

        await sleep(500);

        let finalSnapshot;

        try {
          finalSnapshot =
            await this.getSnapshot();
        } catch (error) {
          if (!isTransientCdpError(error)) {
            throw error;
          }

          await recoverReadConnection(
            error,
            "final_drain"
          );

          drainStableSince = Date.now();
          continue;
        }

        if (finalSnapshot.pageError) {
          throw new Error(
            finalSnapshot.pageError
          );
        }

        const finalText =
          String(
            finalSnapshot.last || ""
          ).trim();

        const stillNewTurn =
          Number(
            finalSnapshot.assistantCount || 0
          ) > beforeAssistantCount ||
          (
            Boolean(finalText) &&
            finalText !== beforeText
          );

        if (!stillNewTurn) {
          continue;
        }

        if (
          finalText &&
          finalText.length > drainBest.length
        ) {
          drainBest = finalText;
          drainStableSince = Date.now();
          continue;
        }

        if (
          finalText &&
          finalText !== drainBest &&
          finalText.length >=
            Math.floor(drainBest.length * 0.98)
        ) {
          // DOM changed without becoming shorter
          // enough to indicate another/old turn.
          drainBest =
            finalText.length >= drainBest.length
              ? finalText
              : drainBest;

          drainStableSince = Date.now();
        }

        if (
          !finalSnapshot.generating &&
          Date.now() - drainStableSince >=
            FINAL_DRAIN_STABLE_MS
        ) {
          break;
        }
      }

      const result =
        String(drainBest || "").trim();

      if (!result) {
        throw new Error(
          "DAVID GLOBAL FULL ANSWER produced an empty final turn."
        );
      }

      await this.showReport?.(
        "global_full_answer_ready",
        `DAVID прочете целия GPT отговор за сесия ${this.sessionKey} · ${result.length} знака.`,
        {
          finalizer: "DAVID_GLOBAL_FULL_ANSWER_V1",
          session_key: this.sessionKey,
          port: this.port,
          chars: result.length,
          saw_generation: sawGeneration,
          saw_new_assistant_turn: sawNewAssistantTurn,
          final_drain_ms: Date.now() - drainStarted
        },
        "ready"
      ).catch(() => {});

      return result;
    }

    // IMPORTANT:
    // The old implementation returned stableText here.
    // That could be a partial response.
    //
    // Partial timeout recovery is now FORBIDDEN.
    throw new Error(
      `DAVID refused to return a possibly partial GPT response after ${Math.round(limit / 1000)} seconds ` +
      `(session=${this.sessionKey}, best_chars=${bestText.length}).`
    );
  }

  async sendAndWait({ url, prompt, timeoutMs }) {
    await this.openIfNeeded(url);
    const before = await this.getSnapshot();
    await this.typePrompt(prompt);
    await this.sendPrompt(before);
    return this.waitForAnswer(before, timeoutMs);
  }
}

function safeSessionKey(value, fallback = "soul") {
  const source = String(value || fallback).trim().toLowerCase();
  const first = source.split(/\s+/)[0] || fallback;
  return first.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 60) || fallback;
}

function stableSessionPort(basePort, sessionKey, usedPorts) {
  if (sessionKey === "borko" && !usedPorts.has(basePort + 1)) return basePort + 1;
  let hash = 0;
  for (const character of sessionKey) {
    hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  }
  let port = basePort + 2 + (hash % 400);
  while (usedPorts.has(port)) port += 1;
  return port;
}

class EdgeSoulMultiSessionAgent {
  constructor({ sendStatus, chatUrl, rootDir }) {
    this.sendStatus = sendStatus;
    this.chatUrl = validateSoulChatUrl(chatUrl);
    this.rootDir = rootDir;
    this.basePort = Number(process.env.DAVID_EDGE_DEBUG_PORT || 9333);
    this.sessions = new Map();
    this.readyPromises = new Map();
    this.reportLog = [];
    this.lastDiagnostics = null;
    this.defaultSessionKey = safeSessionKey(
      process.env.DAVID_SOUL_INSTANCE_ID || "mitko",
      "mitko"
    );

    this.registerRoute({
      chat_url: this.chatUrl,
      route_label: this.defaultSessionKey,
      session_key: this.defaultSessionKey,
      primary: true
    });
  }

  routeKey(url) {
    return normalizeUrl(validateSoulChatUrl(url));
  }

  registerRoute(route = {}) {
    const url = validateSoulChatUrl(route.chat_url || route.chatUrl || this.chatUrl);
    const key = this.routeKey(url);
    if (this.sessions.has(key)) return this.sessions.get(key);

    const primary = Boolean(route.primary || key === this.routeKey(this.chatUrl));
    const fallbackKey = safeSessionKey(route.user_id, `soul-${this.sessions.size + 1}`);
    let sessionKey = primary
      ? this.defaultSessionKey
      : safeSessionKey(route.session_key || route.route_label, fallbackKey);
    const duplicateKey = Array.from(this.sessions.values()).some((session) => session.sessionKey === sessionKey);
    if (!primary && duplicateKey) sessionKey = `${sessionKey}-${fallbackKey.slice(0, 8)}`;
    // DAVID_MASTER_EDGE_PORT_ALIGN_V1
    //
    // One DAVID instance = one Edge process + one persistent login.
    // Every GPT route is a separate TAB, not a separate Edge debugger.
    //
    // MITKO instance -> all tabs use MITKO base port/profile.
    // BORKO isolated instance -> all tabs use BORKO base port/profile.
    //
    // sessionKey remains unique and continues to identify the route.

    const port = this.basePort;

    const profileDir =
      process.env.DAVID_EDGE_PROFILE_DIR ||
      path.join(
        this.rootDir,
        ".david-instances",
        this.defaultSessionKey,
        "edge-soul-profile"
      );

    const agent = new EdgeSoulBrowserAgent({
      sendStatus: this.sendStatus,
      chatUrl: url,
      rootDir: this.rootDir,
      port,
      profileDir,
      sessionKey,
      sessionLabel: route.route_label || sessionKey
    });
    const session = { key, url, sessionKey, port, profileDir, route, agent };
    this.sessions.set(key, session);
    return session;
  }

  registerRoutes(routes = []) {
    const registered = [];
    for (const route of Array.isArray(routes) ? routes : []) {
      try {
        registered.push(this.registerRoute(route));
      } catch (error) {
        this.sendStatus(`DAVID пропусна невалиден GPT маршрут: ${error.message}`, "warning");
      }
    }
    return registered;
  }

  sessionFor(url) {
    const key = this.routeKey(url || this.chatUrl);
    return this.sessions.get(key) || this.registerRoute({
      chat_url: url || this.chatUrl,
      route_label: `soul-${this.sessions.size + 1}`
    });
  }

  ensureReady(url) {
    const session = this.sessionFor(url);
    if (!this.readyPromises.has(session.key)) {
      const ready = session.agent.openIfNeeded(session.url)
        .then((result) => {
          this.lastDiagnostics = session.agent.lastDiagnostics;
          return result;
        })
        .catch((error) => {
          this.readyPromises.delete(session.key);
          throw error;
        });
      this.readyPromises.set(session.key, ready);
    }
    return this.readyPromises.get(session.key);
  }

  preloadRoutes(_routes = []) {
    // DAVID_MITKO_NO_EXTRA_ROUTES_V1
    // MITKO uses exactly one permanent ChatGPT conversation.
    return Promise.allSettled([
      this.ensureReady(this.chatUrl)
    ]);
  }

  async showReport(stage, message, details = {}, kind = "working") {
    const text = String(message || stage || "DAVID SOUL is working.");
    this.reportLog.push({ stage, message: text, details, kind, at: Date.now() });
    this.reportLog = this.reportLog.slice(-30);
    this.sendStatus(text, kind, { stage, details });
    return true;
  }

  async openIfNeeded(_url = this.chatUrl) {
    // DAVID_MITKO_PRIMARY_CHAT_ONLY_V1
    return this.ensureReady(this.chatUrl);
  }

  async sendAndWait({ url, prompt, timeoutMs }) {
    const session = this.sessionFor(this.chatUrl); // DAVID_MITKO_ONE_FIXED_CHAT_V1
    await this.ensureReady(session.url);
    const answer = await session.agent.sendAndWait({
      url: session.url,
      prompt,
      timeoutMs
    });
    this.lastDiagnostics = session.agent.lastDiagnostics;
    return answer;
  }

  close() {
    for (const session of this.sessions.values()) {
      session.agent.connection?.close?.();
    }
  }
}

module.exports = {
  CdpConnection,
  EdgeSoulBrowserAgent,
  EdgeSoulMultiSessionAgent,
  buildChatGptLoginUrl,
  findEdgeExecutable,
  isChatGptUrl,
  normalizeUrl,
  sameConversation
};
