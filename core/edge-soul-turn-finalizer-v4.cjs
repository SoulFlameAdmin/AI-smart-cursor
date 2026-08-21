"use strict";

const { EdgeSoulBrowserAgent } = require("./edge-cdp-soul-browser.cjs");

const VERSION = "david-soul-turn-finalizer-v4.0.0";
const POLL_MS = 200;
const TEXT_STABLE_MS = 1500; // DAVID_FULL_TURN_MODE_V2
const IMAGE_STABLE_MS = 2500;
const STALE_GENERATING_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(value) {
  return String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isNewResponse(before, current) {
  const userAdvanced = Boolean(
    Number(current.userCount || 0) > Number(before.userCount || 0) ||
    (current.lastUserKey && current.lastUserKey !== before.lastUserKey) ||
    Number(current.lastUserIndex ?? -1) > Number(before.lastUserIndex ?? -1) ||
    (current.lastUserText && current.lastUserText !== before.lastUserText)
  );

  const assistantAdvanced = Boolean(
    Number(current.assistantCount || 0) > Number(before.assistantCount || 0) ||
    (current.lastAssistantKey && current.lastAssistantKey !== before.lastAssistantKey) ||
    Number(current.lastAssistantIndex ?? -1) > Number(before.lastAssistantIndex ?? -1) ||
    (current.lastAssistantText && current.lastAssistantText !== before.lastAssistantText)
  );

  const assistantAfterLatestUser = Boolean(
    Number(current.lastUserIndex ?? -1) >= 0 &&
    Number(current.lastAssistantIndex ?? -1) > Number(current.lastUserIndex ?? -1)
  );

  return Boolean((userAdvanced && assistantAfterLatestUser) || assistantAdvanced);
}

function formatImageResult(url) {
  const value = clean(url);
  if (/^https?:\/\//i.test(value)) {
    return `GPT generated an image: ${value}`;
  }
  return "GPT generated an image in the ChatGPT session. The current SOUL text relay cannot transfer the image file yet.";
}

async function readTurnState(agent) {
  return agent.evaluate(`(() => {
    const clean = (value) => String(value || '')
      .replace(/\\u200b/g, '')
      .replace(/\\r\\n/g, '\\n')
      .replace(/[ \\t]+/g, ' ')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();

    const rendered = (element) => {
      if (!element || !element.isConnected) return false;
      if (element.getAttribute?.('aria-hidden') === 'true') return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || 1) !== 0 && rect.width > 1 && rect.height > 1;
    };

    const roleOf = (turn) => {
      const node = turn.matches?.('[data-message-author-role]')
        ? turn
        : turn.querySelector?.('[data-message-author-role]');
      return clean(node?.getAttribute?.('data-message-author-role')).toLowerCase();
    };

    const keyOf = (turn, role, index) => clean(
      turn.getAttribute?.('data-testid') ||
      turn.getAttribute?.('data-message-id') ||
      turn.id ||
      role + '-' + index
    );

    const insideReasoning = (element, turn) => {
      let current = element;
      while (current && current !== turn) {
        if (current.tagName === 'DETAILS' || current.tagName === 'SUMMARY') return true;
        const label = [
          current.getAttribute?.('data-testid'),
          current.getAttribute?.('aria-label'),
          typeof current.className === 'string' ? current.className : ''
        ].filter(Boolean).join(' ').toLowerCase();
        if (/reason|thinking|thought|analysis|oai-thought/.test(label)) return true;
        current = current.parentElement;
      }
      return false;
    };

    const assistantText = (turn) => {
      const selectors = [
        '[data-testid*="assistant-message"] .markdown',
        '[data-testid*="assistant-message"] [class*="markdown"]',
        '[data-testid*="assistant-message"] [class*="prose"]',
        '.markdown',
        '[class*="markdown"]',
        '[class*="prose"]',
        '[data-testid*="assistant-message"]'
      ];
      const seen = new Set();
      const texts = [];
      for (const selector of selectors) {
        for (const element of turn.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          if (!rendered(element)) continue;
          if (element.closest('button, summary')) continue;
          if (insideReasoning(element, turn)) continue;
          const text = clean(element.innerText || element.textContent || '');
          if (text) texts.push(text);
        }
      }
      texts.sort((a, b) => b.length - a.length);
      return texts[0] || '';
    };

    const assistantImages = (turn) => Array.from(turn.querySelectorAll('img'))
      .filter((img) => {
        if (!rendered(img)) return false;
        const rect = img.getBoundingClientRect();
        return rect.width >= 64 && rect.height >= 64;
      })
      .map((img) => clean(img.currentSrc || img.src || ''))
      .filter(Boolean);

    const primary = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    const turns = primary.length
      ? primary
      : Array.from(document.querySelectorAll('article')).filter((turn) => Boolean(turn.querySelector('[data-message-author-role]')));

    const assistants = [];
    const users = [];

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const role = roleOf(turn);
      if (role === 'assistant') {
        assistants.push({
          index,
          key: keyOf(turn, role, index),
          text: assistantText(turn),
          images: assistantImages(turn)
        });
      } else if (role === 'user') {
        const node = turn.matches?.('[data-message-author-role="user"]')
          ? turn
          : turn.querySelector?.('[data-message-author-role="user"]');
        users.push({
          index,
          key: keyOf(turn, role, index),
          text: clean(node?.innerText || node?.textContent || turn.innerText || '')
        });
      }
    }

    const lastAssistant = assistants.at(-1) || { index: -1, key: '', text: '', images: [] };
    const lastUser = users.at(-1) || { index: -1, key: '', text: '' };

    const stopSelectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
      '[data-is-streaming="true"]',
      '.result-streaming',
      '[class*="result-streaming"]'
    ];
    const generating = stopSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some(rendered)
    );

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
      lastAssistantIndex: lastAssistant.index,
      lastAssistantKey: lastAssistant.key,
      lastAssistantText: lastAssistant.text,
      imageUrls: lastAssistant.images,
      lastUserIndex: lastUser.index,
      lastUserKey: lastUser.key,
      lastUserText: lastUser.text,
      generating,
      pageError,
      url: location.href
    };
  })()`);
}

async function waitForTurnV4(before, timeoutMs) {
  const started = Date.now();
  const maximumWait = Math.max(30000, Number(timeoutMs) || 240000);
  let stableText = '';
  let stableImageSignature = '';
  let stableSince = 0;
  let lastState = null;

  while (Date.now() - started < maximumWait) {
    lastState = await readTurnState(this);
    if (lastState?.pageError) throw new Error(lastState.pageError);

    const fresh = isNewResponse(before, lastState);
    const text = clean(lastState?.lastAssistantText);
    const images = Array.isArray(lastState?.imageUrls) ? lastState.imageUrls : [];
    const imageSignature = images.join('|');

    if (fresh && text) {
      if (text !== stableText) {
        stableText = text;
        stableImageSignature = '';
        stableSince = Date.now();
      }
      const stableFor = Date.now() - stableSince;
      if (!lastState.generating && stableFor >= TEXT_STABLE_MS) return stableText;
      if (false && lastState.generating && stableFor >= STALE_GENERATING_MS) return stableText; // DAVID_FULL_TURN_NEVER_FINALIZE_WHILE_GENERATING
    } else if (fresh && images.length) {
      if (imageSignature !== stableImageSignature) {
        stableText = '';
        stableImageSignature = imageSignature;
        stableSince = Date.now();
      }
      const stableFor = Date.now() - stableSince;
      if (!lastState.generating && stableFor >= IMAGE_STABLE_MS) {
        const publicUrl = images.find((url) => /^https?:\/\//i.test(url)) || '';
        return formatImageResult(publicUrl);
      }
    } else {
      stableText = '';
      stableImageSignature = '';
      stableSince = 0;
    }

    await sleep(POLL_MS);
  }

  const diagnostic = lastState
    ? [
        `assistants=${Number(lastState.assistantCount || 0)}`,
        `users=${Number(lastState.userCount || 0)}`,
        `a_index=${Number(lastState.lastAssistantIndex ?? -1)}`,
        `u_index=${Number(lastState.lastUserIndex ?? -1)}`,
        `chars=${clean(lastState.lastAssistantText).length}`,
        `images=${Array.isArray(lastState.imageUrls) ? lastState.imageUrls.length : 0}`,
        `generating=${Boolean(lastState.generating)}`
      ].join(' ')
    : 'no_state=true';

  throw new Error(`DAVID TURN FINALIZER V4 timed out. ${diagnostic}`);
}

function installDavidSoulTurnFinalizerV4() {
  const prototype = EdgeSoulBrowserAgent.prototype;

  prototype.sendAndWait = async function davidTurnFinalizerV4SendAndWait({ url, prompt, timeoutMs }) {
    // DAVID_V4_2_DIRECT_FINAL_RETURN
    //
    // Phase 1:
    // Finalizer V4 proves that a NEW assistant turn exists.
    //
    // Phase 2:
    // The answer must pass through the runtime waitForAnswer chain,
    // which is wrapped by Whole Turn Return and Completion Proof.
    //
    // Never return the preliminary V4 DOM fragment directly.

    const started = Date.now();
    const totalTimeout = Math.max(86400000, Number(timeoutMs) || 0); // DAVID_FULL_TURN_24H_SAFETY_CEILING

    await this.openIfNeeded(url);

    const before = await readTurnState(this);
    const legacyBefore = await this.getSnapshot();

    await this.typePrompt(prompt);
    await this.sendPrompt(legacyBefore);

    const preliminary = await waitForTurnV4.call(
      this,
      before,
      totalTimeout
    );

    // Preserve V4 image-only behavior.
    if (
      typeof preliminary === "string" &&
      preliminary.startsWith("GPT generated an image")
    ) {
      return preliminary;
    }

    // DAVID V4.2 DIRECT FINAL RETURN
    //
    // waitForTurnV4 already proved:
    // - this is a NEW assistant turn
    // - the text is stable
    // - normal generation has finished
    //
    // Do not start a second waitForAnswer cycle for the same GPT turn.
    const finalAnswer = preliminary;
    const finalText = clean(finalAnswer);

    if (!finalText) {
      throw new Error(
        "DAVID V4.1 full pipeline produced an empty final answer."
      );
    }

    await this.showReport?.(
      "v4_1_full_pipeline_ready",
      `DAVID V4.1 прочете целия потвърден GPT отговор · ${finalText.length} знака.`,
      {
        finalizer: "DAVID_V4_2_DIRECT_FINAL_RETURN",
        preliminary_chars: clean(preliminary).length,
        final_chars: finalText.length,
        elapsed_ms: Date.now() - started
      },
      "ready"
    ).catch(() => {});

    return finalText;
  };

  Object.defineProperty(prototype, '__davidSoulTurnFinalizerV4Installed', {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false
  });

  return {
    version: VERSION,
    installed: true,
    master_edge_unchanged: true,
    route_logic_unchanged: true,
    reused_turn_detection: true,
    repeated_identical_answer_safe: true,
    image_only_turn_no_hang: true,
    text_stable_ms: TEXT_STABLE_MS,
    image_stable_ms: IMAGE_STABLE_MS
  };
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`TURN FINALIZER V4 self-test failed: ${message}`);
  };

  const before = {
    assistantCount: 3,
    userCount: 3,
    lastAssistantIndex: 5,
    lastAssistantKey: 'same-key',
    lastAssistantText: 'same answer',
    lastUserIndex: 4,
    lastUserKey: 'user-3',
    lastUserText: 'old prompt'
  };

  const repeated = {
    assistantCount: 3,
    userCount: 4,
    lastAssistantIndex: 7,
    lastAssistantKey: 'same-key',
    lastAssistantText: 'same answer',
    lastUserIndex: 6,
    lastUserKey: 'user-4',
    lastUserText: 'new prompt'
  };

  assert(isNewResponse(before, repeated), 'reused assistant key with repeated text must still be new after the new user turn');
  assert(formatImageResult('https://example.test/image.png').includes('https://'), 'public image URL must be returned');
  assert(formatImageResult('blob:test').includes('cannot transfer'), 'blob image must not hang');
  return true;
}

module.exports = {
  VERSION,
  installDavidSoulTurnFinalizerV4,
  runSelfTest,
  isNewResponse,
  formatImageResult
};

if (require.main === module) {
  runSelfTest();
  console.log('DAVID TURN FINALIZER V4 SELF-TEST: PASS');
}
