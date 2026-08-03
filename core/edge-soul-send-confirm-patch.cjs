"use strict";

const { EdgeSoulBrowserAgent } = require("./edge-cdp-soul-browser.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePromptText(value) {
  return String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function promptContainsExpected(actual, expected) {
  const left = normalizePromptText(actual);
  const right = normalizePromptText(expected);
  if (!right) return true;
  if (!left) return false;
  if (left === right) return true;
  const tail = right.slice(-Math.min(160, right.length));
  return tail.length >= 8 ? left.includes(tail) : left.includes(right);
}

function installReliableSoulSendConfirmation() {
  EdgeSoulBrowserAgent.prototype.getSnapshot = async function reliableSnapshot() {
    return this.evaluate(`(() => {
      const clean = (value) => String(value || '')
        .replace(/\\u200b/g, '')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
      const isVisible = (element) => {
        if (!element || !element.isConnected) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 &&
          rect.width > 2 && rect.height > 2;
      };
      const promptSelectors = [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea'
      ];
      const promptCandidates = promptSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector))
      );
      const prompt = promptCandidates.find((element) =>
        isVisible(element) &&
        !element.disabled &&
        element.getAttribute('aria-hidden') !== 'true'
      ) || null;
      const promptText = clean(
        prompt?.innerText || prompt?.textContent || prompt?.value || ''
      );
      const sendSelectors = [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="Изпращ"]',
        'button[aria-label*="Submit"]'
      ];
      const sendCandidates = sendSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector))
      );
      const sendButton = sendCandidates.find(isVisible) || null;
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
        promptText,
        promptEmpty: promptText.length === 0,
        promptVisible: Boolean(prompt),
        promptCandidateCount: promptCandidates.length,
        sendButtonFound: Boolean(sendButton),
        sendButtonEnabled: Boolean(
          sendButton &&
          !sendButton.disabled &&
          sendButton.getAttribute('aria-disabled') !== 'true'
        ),
        url: location.href
      };
    })()`);
  };

  EdgeSoulBrowserAgent.prototype.typePrompt = async function reliableTypePrompt(text) {
    const expected = String(text || "");
    const prepared = await this.evaluate(`(() => {
      const isVisible = (element) => {
        if (!element || !element.isConnected) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 && rect.width > 2 && rect.height > 2;
      };
      const selectors = [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea'
      ];
      const prompt = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((element) => isVisible(element) && !element.disabled &&
          element.getAttribute('aria-hidden') !== 'true');
      if (!prompt) return { ok: false, reason: 'visible_prompt_not_found' };
      prompt.scrollIntoView({ block: 'center', inline: 'nearest' });
      prompt.focus();
      if (prompt.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(prompt);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete', false, null);
      } else {
        const prototype = prompt instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(prompt, '');
        else prompt.value = '';
        prompt.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'deleteContentBackward',
          data: null
        }));
      }
      return { ok: true };
    })()`);

    if (!prepared?.ok) {
      throw new Error("DAVID did not find the visible ChatGPT prompt in Edge.");
    }

    const connection = await this.connect();
    await connection.send("Input.insertText", { text: expected });
    await sleep(350);

    let snapshot = await this.getSnapshot();
    if (!promptContainsExpected(snapshot.promptText, expected)) {
      const serialized = JSON.stringify(expected);
      await this.evaluate(`(() => {
        const text = ${serialized};
        const isVisible = (element) => {
          if (!element || !element.isConnected) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0 && rect.width > 2 && rect.height > 2;
        };
        const selectors = [
          '#prompt-textarea',
          '[data-testid="prompt-textarea"]',
          '[contenteditable="true"][role="textbox"]',
          'textarea'
        ];
        const prompt = selectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .find((element) => isVisible(element) && !element.disabled &&
            element.getAttribute('aria-hidden') !== 'true');
        if (!prompt) return false;
        prompt.focus();
        if (prompt.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(prompt);
          selection.removeAllRanges();
          selection.addRange(range);
          const inserted = document.execCommand('insertText', false, text);
          if (!inserted) prompt.textContent = text;
        } else {
          const prototype = prompt instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(prompt, text);
          else prompt.value = text;
        }
        prompt.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text
        }));
        prompt.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(450);
      snapshot = await this.getSnapshot();
    }

    if (!promptContainsExpected(snapshot.promptText, expected)) {
      throw new Error(
        `DAVID could not verify the text in the visible ChatGPT prompt. ` +
        `visible=${Boolean(snapshot.promptVisible)} chars=${String(snapshot.promptText || '').length}`
      );
    }

    return expected.length;
  };

  EdgeSoulBrowserAgent.prototype.waitForTypedPrompt = async function waitForTypedPrompt(
    expectedPrompt,
    timeoutMs = 10000
  ) {
    const expected = String(expectedPrompt || "");
    const started = Date.now();
    let lastSnapshot = null;

    while (Date.now() - started < timeoutMs) {
      lastSnapshot = await this.getSnapshot();
      if (lastSnapshot.pageError) throw new Error(lastSnapshot.pageError);
      if (
        lastSnapshot.promptVisible &&
        promptContainsExpected(lastSnapshot.promptText, expected)
      ) {
        return lastSnapshot;
      }
      await sleep(250);
    }

    const diagnostic = lastSnapshot
      ? ` visible=${Boolean(lastSnapshot.promptVisible)} chars=${String(lastSnapshot.promptText || '').length}`
      : "";
    throw new Error(
      `DAVID inserted the SOUL message, but could not verify it in the visible ChatGPT prompt.${diagnostic}`
    );
  };

  EdgeSoulBrowserAgent.prototype.sendPrompt = async function reliableSendPrompt(before) {
    const clicked = await this.evaluate(`(() => {
      const isVisible = (element) => {
        if (!element || !element.isConnected) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 && rect.width > 2 && rect.height > 2;
      };
      const promptSelectors = [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea'
      ];
      const prompt = promptSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((element) => isVisible(element) && !element.disabled &&
          element.getAttribute('aria-hidden') !== 'true');
      prompt?.focus();
      const sendSelectors = [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="Изпращ"]',
        'button[aria-label*="Submit"]'
      ];
      const button = sendSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((element) => isVisible(element) && !element.disabled &&
          element.getAttribute('aria-disabled') !== 'true');
      if (!button) return false;
      button.click();
      return true;
    })()`);

    if (!clicked) {
      const connection = await this.connect();
      await connection.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13
      });
      await connection.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13
      });
    }

    const started = Date.now();
    let lastSnapshot = null;
    while (Date.now() - started < 20000) {
      lastSnapshot = await this.getSnapshot();
      if (lastSnapshot.pageError) throw new Error(lastSnapshot.pageError);

      const userTurnChanged =
        lastSnapshot.userCount > Number(before.userCount || 0) ||
        (lastSnapshot.lastUser && lastSnapshot.lastUser !== String(before.lastUser || ""));
      const promptWasAccepted = lastSnapshot.promptEmpty && Date.now() - started >= 600;

      if (lastSnapshot.generating || userTurnChanged || promptWasAccepted) {
        return lastSnapshot;
      }
      await sleep(350);
    }

    const diagnostic = lastSnapshot
      ? ` prompt_empty=${Boolean(lastSnapshot.promptEmpty)}` +
        ` generating=${Boolean(lastSnapshot.generating)}` +
        ` send_found=${Boolean(lastSnapshot.sendButtonFound)}` +
        ` send_enabled=${Boolean(lastSnapshot.sendButtonEnabled)}`
      : "";
    throw new Error(
      `DAVID submitted the visible prompt once, but Edge did not confirm GPT receipt after 20 seconds.${diagnostic}`
    );
  };

  EdgeSoulBrowserAgent.prototype.sendAndWait = async function reliableSendAndWait({
    url,
    prompt,
    timeoutMs
  }) {
    await this.openIfNeeded(url);
    const before = await this.getSnapshot();
    await this.typePrompt(prompt);
    await this.waitForTypedPrompt(prompt);
    await this.sendPrompt(before);
    return this.waitForAnswer(before, timeoutMs);
  };

  return {
    version: "david-soul-send-confirm-v1.0.2",
    visible_prompt_only: true,
    confirmation_timeout_ms: 20000,
    duplicate_submit_retry: false
  };
}

module.exports = {
  installReliableSoulSendConfirmation,
  normalizePromptText,
  promptContainsExpected
};
