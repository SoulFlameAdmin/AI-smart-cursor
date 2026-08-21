"use strict";

const { EdgeSoulBrowserAgent } = require("./edge-cdp-soul-browser.cjs");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const VERSION = "david-soul-final-answer-v1.1.0";
const STABLE_CHECKS_REQUIRED = 3;
const STABLE_CHECK_INTERVAL_MS = 2000;

function normalizeAnswerText(value) {
  return String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isTransientAssistantText(value) {
  const text = normalizeAnswerText(value)
    .toLocaleLowerCase("bg")
    .replace(/[.…:!?*_#>|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return true;
  return [
    "thinking",
    "thinking…",
    "thought",
    "reasoning",
    "analyzing",
    "working",
    "working on it",
    "мисли",
    "мислене",
    "обмисля",
    "обмисляне",
    "разсъждава",
    "разсъждение",
    "анализира",
    "анализиране",
    "подготвя отговор"
  ].includes(text);
}

function shouldCommitAnswer({
  text,
  isNewAssistantTurn,
  generating,
  composerReady,
  stableChecks
}) {
  return Boolean(
    normalizeAnswerText(text) &&
    !isTransientAssistantText(text) &&
    isNewAssistantTurn &&
    !generating &&
    composerReady &&
    Number(stableChecks) >= STABLE_CHECKS_REQUIRED
  );
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`DAVID V1.1 self-test failed: ${message}`);
  };

  assert(isTransientAssistantText("Thinking"), "English thinking label must be rejected");
  assert(isTransientAssistantText("Мислене"), "Bulgarian thinking label must be rejected");
  assert(!isTransientAssistantText("Ето пълния завършен отговор."), "real answer must be accepted");
  assert(!shouldCommitAnswer({
    text: "Ето пълния отговор.",
    isNewAssistantTurn: true,
    generating: true,
    composerReady: true,
    stableChecks: 5
  }), "streaming answer must not be committed");
  assert(!shouldCommitAnswer({
    text: "Ето пълния отговор.",
    isNewAssistantTurn: true,
    generating: false,
    composerReady: true,
    stableChecks: 2
  }), "two stable checks are not enough");
  assert(shouldCommitAnswer({
    text: "Ето пълния отговор.",
    isNewAssistantTurn: true,
    generating: false,
    composerReady: true,
    stableChecks: 3
  }), "three stable checks must accept a completed answer");
  return true;
}

function installCompletedSoulAnswerDetection() {
  const prototype = EdgeSoulBrowserAgent.prototype;
  if (prototype.__davidFinalAnswerV11Installed) {
    return { version: VERSION, installed: true, repeated_install: true };
  }

  prototype.getSnapshot = async function finalAnswerSnapshot() {
    return this.evaluate(`(() => {
      const clean = (value) => String(value || '')
        .replace(/\\u200b/g, '')
        .replace(/\\r\\n/g, '\\n')
        .replace(/[ \\t]+/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      const isRendered = (element) => {
        if (!element || !element.isConnected) return false;
        if (element.getAttribute?.('aria-hidden') === 'true') return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 &&
          rect.width > 1 && rect.height > 1;
      };

      const transient = (value) => {
        const text = clean(value)
          .toLocaleLowerCase('bg')
          .replace(/[.…:!?*_#>|-]+/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
        return !text || [
          'thinking', 'thought', 'reasoning', 'analyzing', 'working', 'working on it',
          'мисли', 'мислене', 'обмисля', 'обмисляне', 'разсъждава',
          'разсъждение', 'анализира', 'анализиране', 'подготвя отговор'
        ].includes(text);
      };

      const reasoningLabel = /reason|thinking|thought|chain-of-thought|analysis|oai-thought|мислен|разсъжд|обмисл/i;
      const isInsideReasoning = (element, turn) => {
        let current = element;
        while (current && current !== turn) {
          if (current.tagName === 'DETAILS' || current.tagName === 'SUMMARY') return true;
          const label = [
            current.getAttribute?.('data-testid'),
            current.getAttribute?.('data-state'),
            current.getAttribute?.('aria-label'),
            current.getAttribute?.('role'),
            typeof current.className === 'string' ? current.className : ''
          ].filter(Boolean).join(' ');
          if (reasoningLabel.test(label)) return true;
          current = current.parentElement;
        }
        return false;
      };

      const roleOf = (turn) => {
        const roleNode = turn.matches?.('[data-message-author-role]')
          ? turn
          : turn.querySelector?.('[data-message-author-role]');
        return clean(roleNode?.getAttribute?.('data-message-author-role')).toLowerCase();
      };

      const turnKey = (turn, role, index) => clean(
        turn.getAttribute?.('data-testid') ||
        turn.getAttribute?.('data-message-id') ||
        turn.id ||
        role + '-' + index
      );

      const finalAnswerFromTurn = (turn) => {
        const selectors = [
          '[data-testid*="assistant-message"] .markdown',
          '[data-testid*="assistant-message"] [class*="markdown"]',
          '[data-testid*="assistant-message"] [class*="prose"]',
          '.markdown',
          '[class*="markdown"]',
          '[class*="prose"]',
          '[data-testid*="assistant-message"]'
        ];
        const nodes = [];
        const seen = new Set();
        let order = 0;

        for (const selector of selectors) {
          for (const element of turn.querySelectorAll(selector)) {
            if (seen.has(element)) continue;
            seen.add(element);
            order += 1;
            if (!isRendered(element)) continue;
            if (element.closest('button, summary')) continue;
            if (isInsideReasoning(element, turn)) continue;
            const text = clean(element.innerText || element.textContent || '');
            if (!text || transient(text)) continue;
            nodes.push({ text, order });
          }
        }

        nodes.sort((left, right) =>
          right.text.length - left.text.length || right.order - left.order
        );
        return {
          text: nodes[0]?.text || '',
          candidateCount: nodes.length
        };
      };

      const primaryTurns = Array.from(
        document.querySelectorAll('[data-testid^="conversation-turn-"]')
      );
      const candidates = primaryTurns.length
        ? primaryTurns
        : Array.from(document.querySelectorAll('article')).filter((turn) =>
            Boolean(turn.querySelector('[data-message-author-role]'))
          );

      const assistantTurns = [];
      const userTurns = [];

      for (let index = 0; index < candidates.length; index += 1) {
        const turn = candidates[index];
        const role = roleOf(turn);
        if (role === 'assistant') {
          const answer = finalAnswerFromTurn(turn);
          if (answer.text) {
            assistantTurns.push({
              text: answer.text,
              key: turnKey(turn, role, index),
              candidateCount: answer.candidateCount
            });
          }
        } else if (role === 'user') {
          const roleNode = turn.matches?.('[data-message-author-role="user"]')
            ? turn
            : turn.querySelector?.('[data-message-author-role="user"]');
          const text = clean(roleNode?.innerText || roleNode?.textContent || turn.innerText || '');
          if (text) userTurns.push({ text, key: turnKey(turn, role, index) });
        }
      }

      const lastAssistant = assistantTurns.at(-1) || { text: '', key: '', candidateCount: 0 };
      const lastUser = userTurns.at(-1) || { text: '', key: '' };

      const stopSelectors = [
        'button[data-testid="stop-button"]',
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Спри" i]',
        '[data-is-streaming="true"]',
        '.result-streaming',
        '[class*="result-streaming"]'
      ];
      const stopBySelector = stopSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some(isRendered)
      );
      const stopByLabel = Array.from(document.querySelectorAll('button')).some((button) => {
        if (!isRendered(button)) return false;
        const label = clean([
          button.getAttribute('data-testid'),
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.innerText
        ].filter(Boolean).join(' ')).toLowerCase();
        return label.includes('stop-button') ||
          label.includes('stop generating') ||
          label.includes('stop response') ||
          label.includes('спри генерирането') ||
          label.includes('спиране на генерирането');
      });

      const promptSelectors = [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea'
      ];
      const prompt = promptSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((element) => isRendered(element) &&
          !element.disabled && element.getAttribute('aria-disabled') !== 'true') || null;

      const sendSelectors = [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Изпращ" i]',
        'button[aria-label*="Submit" i]'
      ];
      const sendButton = sendSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find(isRendered) || null;

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
        assistantCount: assistantTurns.length,
        userCount: userTurns.length,
        last: lastAssistant.text,
        lastLength: lastAssistant.text.length,
        lastAssistantTurnKey: lastAssistant.key,
        lastFinalCandidateCount: lastAssistant.candidateCount,
        lastUser: lastUser.text,
        lastUserTurnKey: lastUser.key,
        generating: stopBySelector || stopByLabel,
        stopButtonFound: stopBySelector || stopByLabel,
        composerReady: Boolean(prompt),
        promptVisible: Boolean(prompt),
        sendButtonFound: Boolean(sendButton),
        sendButtonEnabled: Boolean(sendButton && !sendButton.disabled &&
          sendButton.getAttribute('aria-disabled') !== 'true'),
        pageError,
        url: location.href
      };
    })()`);
  };

  prototype.waitForAnswer = async function waitForCompletedFinalAnswer(before, timeoutMs) {
    const started = Date.now();
    const maximumWait = Math.max(30000, Number(timeoutMs) || 240000);
    let stableText = "";
    let stableTurnKey = "";
    let stableChecks = 0;
    let lastSnapshot = null;

    while (Date.now() - started < maximumWait) {
      lastSnapshot = await this.getSnapshot();
      if (lastSnapshot.pageError) throw new Error(lastSnapshot.pageError);

      const text = normalizeAnswerText(lastSnapshot.last);
      const turnKey = String(lastSnapshot.lastAssistantTurnKey || "");
      const isNewAssistantTurn = Boolean(
        lastSnapshot.assistantCount > Number(before.assistantCount || 0) ||
        (turnKey && turnKey !== String(before.lastAssistantTurnKey || ""))
      );

      if (isNewAssistantTurn && text && !isTransientAssistantText(text)) {
        if (text === stableText && turnKey === stableTurnKey) {
          stableChecks += 1;
        } else {
          stableText = text;
          stableTurnKey = turnKey;
          stableChecks = 1;
        }

        if (shouldCommitAnswer({
          text,
          isNewAssistantTurn,
          generating: Boolean(lastSnapshot.generating),
          composerReady: Boolean(lastSnapshot.composerReady),
          stableChecks
        })) {
          return text;
        }
      } else {
        stableText = "";
        stableTurnKey = "";
        stableChecks = 0;
      }

      await sleep(STABLE_CHECK_INTERVAL_MS);
    }

    const diagnostic = lastSnapshot
      ? ` generating=${Boolean(lastSnapshot.generating)}` +
        ` composer_ready=${Boolean(lastSnapshot.composerReady)}` +
        ` stable_checks=${stableChecks}` +
        ` final_chars=${String(lastSnapshot.last || "").length}` +
        ` final_candidates=${Number(lastSnapshot.lastFinalCandidateCount || 0)}`
      : " no_snapshot=true";

    throw new Error(
      `DAVID did not receive a fully completed final GPT answer in ${Math.round(maximumWait / 1000)} seconds.` +
      diagnostic
    );
  };

  Object.defineProperty(prototype, "__davidFinalAnswerV11Installed", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  return {
    version: VERSION,
    installed: true,
    reasoning_blocks_ignored: true,
    stable_checks_required: STABLE_CHECKS_REQUIRED,
    stable_check_interval_ms: STABLE_CHECK_INTERVAL_MS,
    partial_answer_fallback: false
  };
}

module.exports = {
  VERSION,
  STABLE_CHECKS_REQUIRED,
  STABLE_CHECK_INTERVAL_MS,
  installCompletedSoulAnswerDetection,
  isTransientAssistantText,
  normalizeAnswerText,
  runSelfTest,
  shouldCommitAnswer
};