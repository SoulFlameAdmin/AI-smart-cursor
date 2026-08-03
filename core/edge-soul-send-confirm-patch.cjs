"use strict";

const { EdgeSoulBrowserAgent } = require("./edge-cdp-soul-browser.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installReliableSoulSendConfirmation() {
  EdgeSoulBrowserAgent.prototype.getSnapshot = async function reliableSnapshot() {
    return this.evaluate(`(() => {
      const clean = (value) => String(value || '')
        .replace(/\\u200b/g, '')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
      const prompt = document.querySelector(
        '#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], textarea'
      );
      const promptText = clean(
        prompt?.innerText || prompt?.textContent || prompt?.value || ''
      );
      const sendButton = document.querySelector(
        'button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Изпращ"]'
      );
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
        sendButtonEnabled: Boolean(sendButton && !sendButton.disabled),
        url: location.href
      };
    })()`);
  };

  EdgeSoulBrowserAgent.prototype.waitForTypedPrompt = async function waitForTypedPrompt(
    expectedPrompt,
    timeoutMs = 6000
  ) {
    const expected = String(expectedPrompt || "").trim();
    const started = Date.now();
    let lastSnapshot = null;

    while (Date.now() - started < timeoutMs) {
      lastSnapshot = await this.getSnapshot();
      if (lastSnapshot.pageError) throw new Error(lastSnapshot.pageError);
      const hasTypedText = Boolean(lastSnapshot.promptText) || expected.length === 0;
      if (hasTypedText && lastSnapshot.sendButtonEnabled) return lastSnapshot;
      await sleep(250);
    }

    throw new Error(
      "DAVID inserted the SOUL message, but the ChatGPT send control did not become ready."
    );
  };

  EdgeSoulBrowserAgent.prototype.sendPrompt = async function reliableSendPrompt(before) {
    const clicked = await this.evaluate(`(() => {
      const button = document.querySelector(
        'button[data-testid="send-button"]:not([disabled]), button[aria-label*="Send"]:not([disabled]), button[aria-label*="Изпращ"]:not([disabled])'
      );
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
      ? ` prompt_empty=${Boolean(lastSnapshot.promptEmpty)} generating=${Boolean(lastSnapshot.generating)}`
      : "";
    throw new Error(
      `DAVID placed the message, but Edge did not confirm sending it to GPT after 20 seconds.${diagnostic}`
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
    version: "david-soul-send-confirm-v1.0.1",
    confirmation_timeout_ms: 20000,
    duplicate_submit_retry: false
  };
}

module.exports = {
  installReliableSoulSendConfirmation
};
