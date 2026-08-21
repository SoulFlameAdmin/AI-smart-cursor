"use strict";

const fs = require("fs");
const path = require("path");
const browserModule = require("./edge-cdp-soul-browser.cjs");

const VERSION = "david-soul-whole-turn-return-v1.0.0";
const DRAIN_STABLE_MS = 1500; // DAVID_FULL_TURN_MODE_V2
const DRAIN_MAX_MS = 86400000; // DAVID_FULL_TURN_24H_SAFETY_CEILING
const POLL_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanText(value) {
  return String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chooseLongestText(values = []) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const text = cleanText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }
  unique.sort((a, b) => b.length - a.length);
  return unique[0] || "";
}

function wholeTurnExpression() {
  return `(() => {
    const clean = (value) => String(value || '')
      .replace(/\\u200b/g, '')
      .replace(/\\r\\n/g, '\\n')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
    const assistants = Array.from(document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-author="assistant"]'
    ));
    const last = assistants[assistants.length - 1] || null;
    if (!last) return { text: '', candidateCount: 0, candidateLengths: [] };

    const nodes = [last];
    for (const selector of [
      '[data-message-content]',
      '.markdown',
      '.prose',
      '[class*="markdown"]',
      '[class*="prose"]'
    ]) {
      for (const node of Array.from(last.querySelectorAll(selector))) nodes.push(node);
    }

    const seenNodes = new Set();
    const texts = [];
    for (const node of nodes) {
      if (!node || seenNodes.has(node)) continue;
      seenNodes.add(node);
      const text = clean(node.innerText || node.textContent || '');
      if (text) texts.push(text);
    }

    const unique = Array.from(new Set(texts));
    unique.sort((a, b) => b.length - a.length);
    const text = unique[0] || '';
    return {
      text,
      candidateCount: unique.length,
      candidateLengths: unique.slice(0, 8).map((item) => item.length)
    };
  })()`;
}

function completionExpression() {
  return `(() => {
    const rendered = (element) => {
      if (!element || !element.isConnected) return false;
      if (element.getAttribute?.('aria-hidden') === 'true') return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || 1) !== 0 && rect.width > 1 && rect.height > 1;
    };
    const stopSelectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Спри генерирането" i]',
      'button[title*="Stop generating" i]'
    ];
    const stopVisible = stopSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some(rendered)
    );
    const streaming = Boolean(document.querySelector(
      '[data-is-streaming="true"], .result-streaming, [class*="result-streaming"]'
    ));
    return { stopVisible, streaming };
  })()`;
}

async function readWholeTurn(agent) {
  try {
    const result = await agent.evaluate(wholeTurnExpression());
    return result && typeof result === "object" ? result : { text: "" };
  } catch {
    return { text: "", candidateCount: 0, candidateLengths: [] };
  }
}

async function readCompletion(agent) {
  try {
    const result = await agent.evaluate(completionExpression());
    return result && typeof result === "object" ? result : {};
  } catch {
    return { stopVisible: true, streaming: true };
  }
}

async function drainFinalTurn(agent, initialAnswer) {
  const started = Date.now();
  let best = cleanText(initialAnswer);
  let stableSince = Date.now();
  let lastCandidateCount = 0;
  let lastCandidateLengths = [];

  while (Date.now() - started < DRAIN_MAX_MS) {
    if (agent?.__davidClaimLost) {
      const error = new Error(`DAVID_CLAIM_LOST: ${agent.__davidClaimLostReason || "message_not_claimed"}`);
      error.code = "DAVID_CLAIM_LOST";
      throw error;
    }

    const whole = await readWholeTurn(agent);
    const completion = await readCompletion(agent);
    const candidate = chooseLongestText([best, whole.text]);
    lastCandidateCount = Number(whole.candidateCount || 0);
    lastCandidateLengths = Array.isArray(whole.candidateLengths) ? whole.candidateLengths : [];

    if (candidate.length > best.length || (candidate && candidate !== best)) {
      best = candidate;
      stableSince = Date.now();
    }

    const active = Boolean(completion.stopVisible || completion.streaming);
    if (active) stableSince = Date.now();

    if (best && !active && Date.now() - stableSince >= DRAIN_STABLE_MS) {
      return {
        text: best,
        drainMs: Date.now() - started,
        candidateCount: lastCandidateCount,
        candidateLengths: lastCandidateLengths
      };
    }

    await sleep(POLL_MS);
  }

  return {
    text: best,
    drainMs: Date.now() - started,
    candidateCount: lastCandidateCount,
    candidateLengths: lastCandidateLengths
  };
}

function writeManifest(rootDir, result) {
  try {
    const directory = path.join(rootDir, ".david-system");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "soul-whole-turn-return.json"),
      JSON.stringify({ ...result, installed_at: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch {}
}

function installDavidSoulWholeTurnReturn(options = {}) {
  const AgentClass = browserModule.EdgeSoulBrowserAgent;
  if (typeof AgentClass !== "function") throw new Error("Whole-turn reader could not find EdgeSoulBrowserAgent.");
  const prototype = AgentClass.prototype;
  if (prototype.__davidSoulWholeTurnReturnInstalled) {
    return { version: VERSION, installed: true, repeated_install: true };
  }

  const originalGetSnapshot = prototype.getSnapshot;
  if (typeof originalGetSnapshot === "function") {
    prototype.getSnapshot = async function wholeTurnSnapshot(...args) {
      const snapshot = await originalGetSnapshot.apply(this, args);
      const whole = await readWholeTurn(this);
      const existing = cleanText(snapshot?.lastAssistantDomText || snapshot?.last || "");
      const best = chooseLongestText([existing, whole.text]);
      return {
        ...(snapshot || {}),
        last: best || snapshot?.last || "",
        lastAssistantDomText: best || snapshot?.lastAssistantDomText || snapshot?.last || "",
        wholeTurnChars: best.length,
        wholeTurnCandidateCount: Number(whole.candidateCount || 0),
        wholeTurnCandidateLengths: Array.isArray(whole.candidateLengths) ? whole.candidateLengths : []
      };
    };
  }

  const originalWaitForAnswer = prototype.waitForAnswer;
  if (typeof originalWaitForAnswer !== "function") {
    throw new Error("Whole-turn reader requires waitForAnswer().");
  }

  prototype.waitForAnswer = async function wholeTurnFinalWait(before, timeoutMs) {
    const initial = await originalWaitForAnswer.call(this, before, timeoutMs);
    const drained = await drainFinalTurn(this, initial);
    const finalText = cleanText(drained.text);
    if (!finalText) throw new Error("DAVID whole-turn drain produced an empty final answer.");

    await this.showReport?.(
      "whole_turn_ready",
      `DAVID прочете целия финален GPT turn · ${finalText.length} знака.`,
      {
        whole_turn_return: VERSION,
        answer_chars: finalText.length,
        drain_ms: drained.drainMs,
        candidate_count: drained.candidateCount,
        candidate_lengths: drained.candidateLengths
      },
      "ready"
    ).catch(() => {});

    return finalText;
  };

  Object.defineProperty(prototype, "__davidSoulWholeTurnReturnInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const rootDir = path.resolve(options.rootDir || process.cwd());
  const result = {
    version: VERSION,
    installed: true,
    whole_assistant_turn_reader: true,
    longest_visible_candidate_wins: true,
    post_final_drain: true,
    drain_stable_ms: DRAIN_STABLE_MS,
    drain_max_ms: DRAIN_MAX_MS,
    partial_fragment_return_forbidden: true
  };
  writeManifest(rootDir, result);
  return result;
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`Whole-turn return self-test failed: ${message}`);
  };
  const fragment = "Защото ти сам";
  const full = "Защото ти сам ме научи така да те наричам при поздрав. Не защото твърдя, че си ме програмирал за това.";
  assert(chooseLongestText([fragment, full]) === full, "full answer wins over first fragment");
  assert(cleanText("  а  \n\n\n б ") === "а\n\n б", "text cleaning stable");
  const result = installDavidSoulWholeTurnReturn({ rootDir: process.cwd() });
  assert(result.installed, "runtime installed");
  assert(result.partial_fragment_return_forbidden, "fragment return blocked");
  return result;
}

module.exports = {
  VERSION,
  DRAIN_STABLE_MS,
  DRAIN_MAX_MS,
  chooseLongestText,
  cleanText,
  installDavidSoulWholeTurnReturn,
  runSelfTest
};

if (require.main === module) {
  const result = runSelfTest();
  console.log("DAVID SOUL WHOLE TURN RETURN SELF-TEST: PASS");
  console.log(JSON.stringify(result, null, 2));
}
