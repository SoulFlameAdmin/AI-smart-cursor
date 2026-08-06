"use strict";

const { EdgeSoulBrowserAgent } = require("./edge-cdp-soul-browser.cjs");

const VERSION = "david-soul-input-fallback-v1.0.0";
const PRIMARY_INSERT_TIMEOUT_MS = 4500;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizePromptText(value) {
  return String(value ?? "")
    .replace(/\u200b/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function promptMatches(actual, expected) {
  const left = normalizePromptText(actual);
  const right = normalizePromptText(expected);
  return Boolean(right) && (left === right || left.includes(right));
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function installEdgeSoulInputFallback() {
  const prototype = EdgeSoulBrowserAgent.prototype;
  if (prototype.__davidSoulInputFallbackInstalled) {
    return { version: VERSION, installed: true, repeated_install: true };
  }

  prototype.resetPromptConnection = function resetPromptConnection() {
    try {
      this.connection?.close?.();
    } catch {}
    this.connection = null;
    this.targetId = null;
  };

  prototype.focusPrompt = async function safeFocusPrompt() {
    return this.evaluate(`(() => {
      const prompt = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], textarea');
      if (!prompt) return false;
      prompt.focus();

      if (prompt.isContentEditable) {
        try {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(prompt);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('delete', false);
          selection.removeAllRanges();
        } catch {}

        if (String(prompt.innerText || prompt.textContent || '').trim()) {
          prompt.textContent = '';
        }

        try {
          prompt.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward',
            data: null
          }));
        } catch {
          prompt.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else {
        const prototype = prompt instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(prompt, '');
        else prompt.value = '';
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`);
  };

  prototype.readPromptText = async function readPromptText() {
    return this.evaluate(`(() => {
      const prompt = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], textarea');
      if (!prompt) return { found: false, text: '' };
      return {
        found: true,
        text: String(prompt.isContentEditable
          ? (prompt.innerText || prompt.textContent || '')
          : (prompt.value || ''))
      };
    })()`);
  };

  prototype.setPromptWithDom = async function setPromptWithDom(text) {
    const payload = String(text ?? "");
    const serialized = JSON.stringify(payload);
    return this.evaluate(`(() => {
      const payload = ${serialized};
      const prompt = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], textarea');
      if (!prompt) return { found: false, text: '', method: 'missing' };
      prompt.focus();

      if (prompt.isContentEditable) {
        try {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(prompt);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('delete', false);
          selection.removeAllRanges();
        } catch {}

        let inserted = false;
        try {
          inserted = Boolean(document.execCommand('insertText', false, payload));
        } catch {}

        const current = String(prompt.innerText || prompt.textContent || '');
        if (!inserted || !current.includes(payload)) {
          prompt.textContent = payload;
        }

        try {
          prompt.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: payload
          }));
        } catch {
          prompt.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else {
        const nativePrototype = prompt instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(nativePrototype, 'value')?.set;
        if (setter) setter.call(prompt, payload);
        else prompt.value = payload;
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        prompt.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return {
        found: true,
        text: String(prompt.isContentEditable
          ? (prompt.innerText || prompt.textContent || '')
          : (prompt.value || '')),
        method: 'dom_input'
      };
    })()`);
  };

  prototype.typePrompt = async function resilientTypePrompt(text) {
    const payload = String(text ?? "");
    if (!payload.trim()) throw new Error("DAVID received an empty GPT prompt.");

    const focused = await this.focusPrompt();
    if (!focused) throw new Error("DAVID did not find the ChatGPT prompt in Edge.");

    let primaryError = null;
    try {
      const connection = await this.connect();
      await withTimeout(
        connection.send("Input.insertText", { text: payload }),
        PRIMARY_INSERT_TIMEOUT_MS,
        `Edge CDP Input.insertText did not answer in ${Math.round(PRIMARY_INSERT_TIMEOUT_MS / 1000)} seconds.`
      );
    } catch (error) {
      primaryError = error;
      this.resetPromptConnection();
    }

    await sleep(180);

    let current = null;
    try {
      current = await this.readPromptText();
    } catch {
      this.resetPromptConnection();
    }

    // A CDP response can time out after Edge has already inserted the text.
    // Verify first so the fallback never duplicates the user's message.
    if (current?.found && promptMatches(current.text, payload)) {
      return payload.length;
    }

    if (primaryError) {
      await this.showReport?.(
        "prompt_input_recovery",
        "DAVID възстановява връзката с полето за писане в ChatGPT.",
        { primary_error: String(primaryError?.message || primaryError).slice(0, 300) },
        "working"
      );
    }

    this.resetPromptConnection();
    const fallback = await this.setPromptWithDom(payload);
    await sleep(180);

    if (fallback?.found && promptMatches(fallback.text, payload)) {
      return payload.length;
    }

    const verified = await this.readPromptText().catch(() => null);
    if (verified?.found && promptMatches(verified.text, payload)) {
      return payload.length;
    }

    throw new Error(
      "DAVID could not place the message in the ChatGPT prompt after CDP reconnect and DOM input fallback." +
      (primaryError ? ` Primary error: ${String(primaryError?.message || primaryError).slice(0, 300)}` : "")
    );
  };

  Object.defineProperty(prototype, "__davidSoulInputFallbackInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  return {
    version: VERSION,
    installed: true,
    primary_insert_timeout_ms: PRIMARY_INSERT_TIMEOUT_MS,
    verifies_before_fallback: true,
    trusted_html_not_used: true
  };
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`DAVID input fallback self-test failed: ${message}`);
  };
  assert(promptMatches("hello", "hello"), "exact text must match");
  assert(promptMatches("\u200bhello\r\n", "hello"), "zero-width and newline normalization must match");
  assert(!promptMatches("hello", "different"), "different text must not match");
  const installed = installEdgeSoulInputFallback();
  assert(installed.installed, "patch must install");
  assert(typeof EdgeSoulBrowserAgent.prototype.typePrompt === "function", "typePrompt must exist");
  return true;
}

module.exports = {
  VERSION,
  PRIMARY_INSERT_TIMEOUT_MS,
  installEdgeSoulInputFallback,
  normalizePromptText,
  promptMatches,
  runSelfTest
};

if (require.main === module) {
  runSelfTest();
  console.log("DAVID CDP INPUT FALLBACK SELF-TEST: PASS");
}
