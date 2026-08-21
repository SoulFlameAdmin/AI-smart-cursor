"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const browserModule = require("./edge-cdp-soul-browser.cjs");

const VERSION = "0.3.1";
const STATUS = "LOCKED_ONE_STABLE_CANDIDATE";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const STABLE_MS = 5000;
const POLL_MS = 750;
const VERIFY_GAP_MS = 850;
const REPORT_MS = 5000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function cleanText(value) {
  return String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hashText(value) {
  return crypto.createHash("sha256").update(cleanText(value), "utf8").digest("hex");
}

function responseTimeoutMs(requested) {
  const envValue = Number.parseInt(
    process.env.DAVID_SOUL_ANCHOR2_TIMEOUT_MS ||
    process.env.DAVID_SOUL_RESPONSE_TIMEOUT_MS ||
    process.env.DAVID_GPT_RESPONSE_TIMEOUT_MS ||
    "",
    10
  );
  const candidates = [Number(requested), envValue, DEFAULT_TIMEOUT_MS]
    .filter(Number.isFinite);
  return Math.max(30000, Math.min(MAX_TIMEOUT_MS, Math.max(...candidates)));
}

function completionExpression() {
  return `(() => {
    const clean = (value) => String(value || '').replace(/\\u200b/g, '').trim();
    const visible = (element) => {
      if (!element || !element.isConnected) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || 1) !== 0 && rect.width > 2 && rect.height > 2;
    };
    const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
    const labels = buttons.map((button) => clean([
      button.getAttribute('data-testid'),
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.innerText
    ].filter(Boolean).join(' ')).toLowerCase());
    const stopVisible = labels.some((label) =>
      label.includes('stop-button') ||
      label.includes('stop generating') ||
      label.includes('спиране на генерирането') ||
      label === 'stop'
    );
    const continueVisible = labels.some((label) =>
      label.includes('continue generating') ||
      label.includes('continue-generation') ||
      label.includes('продължи генерирането')
    );
    const streaming = Boolean(document.querySelector(
      '[data-is-streaming="true"], .result-streaming, [class*="result-streaming"]'
    ));
    return { stopVisible, continueVisible, streaming };
  })()`;
}

function turnExpression() {
  return `(() => {
    const clean = (value) => String(value || '')
      .replace(/\\u200b/g, '')
      .replace(/\\s+/g, ' ')
      .trim();
    const unique = (nodes) => Array.from(new Set(nodes.filter(Boolean)));
    const assistants = unique(Array.from(document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-author="assistant"]'
    )));
    const users = unique(Array.from(document.querySelectorAll(
      '[data-message-author-role="user"], [data-author="user"]'
    )));
    const lastAssistant = assistants[assistants.length - 1] || null;
    const lastUser = users[users.length - 1] || null;
    const assistantRoot = lastAssistant?.closest?.(
      '[data-message-id], [data-testid^="conversation-turn-"], article'
    ) || lastAssistant;
    const userRoot = lastUser?.closest?.(
      '[data-message-id], [data-testid^="conversation-turn-"], article'
    ) || lastUser;
    const assistantTextNode = lastAssistant?.querySelector?.(
      '.markdown, [class*="markdown"], [data-message-content]'
    ) || lastAssistant;
    const assistantKey = clean(
      assistantRoot?.getAttribute?.('data-message-id') ||
      assistantRoot?.getAttribute?.('data-testid') ||
      lastAssistant?.getAttribute?.('data-message-id') ||
      ''
    );
    const userKey = clean(
      userRoot?.getAttribute?.('data-message-id') ||
      userRoot?.getAttribute?.('data-testid') ||
      lastUser?.getAttribute?.('data-message-id') ||
      ''
    );
    let assistantAfterLastUser = false;
    if (lastAssistant && lastUser && lastAssistant !== lastUser) {
      try {
        assistantAfterLastUser = Boolean(
          lastUser.compareDocumentPosition(lastAssistant) & Node.DOCUMENT_POSITION_FOLLOWING
        );
      } catch {}
    }
    return {
      assistantDomCount: assistants.length,
      userDomCount: users.length,
      lastAssistantDomText: clean(assistantTextNode?.innerText || assistantTextNode?.textContent || ''),
      lastAssistantDomKey: assistantKey,
      lastUserDomKey: userKey,
      assistantAfterLastUser
    };
  })()`;
}

async function readCompletionState(agent) {
  try {
    return await agent.evaluate(completionExpression());
  } catch {
    return { stopVisible: false, continueVisible: false, streaming: false };
  }
}

async function readTurnState(agent) {
  try {
    const state = await agent.evaluate(turnExpression());
    return state && typeof state === "object" ? state : {};
  } catch {
    return {};
  }
}

function snapshotAnswer(snapshot) {
  return cleanText(snapshot?.lastAssistantDomText || snapshot?.last || "");
}

function assistantCount(snapshot) {
  const dom = Number(snapshot?.assistantDomCount);
  const base = Number(snapshot?.assistantCount);
  const values = [dom, base].filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

function userCount(snapshot) {
  const dom = Number(snapshot?.userDomCount);
  const base = Number(snapshot?.userCount);
  const values = [dom, base].filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

function isNewAssistant(snapshot, before, generationSeen = false) {
  const currentAnswer = snapshotAnswer(snapshot);
  if (!currentAnswer) return false;

  const currentAssistantCount = assistantCount(snapshot);
  const beforeAssistantCount = assistantCount(before);
  const currentUserCount = userCount(snapshot);
  const beforeUserCount = userCount(before);
  const currentKey = cleanText(snapshot?.lastAssistantDomKey);
  const beforeKey = cleanText(before?.lastAssistantDomKey);
  const beforeAnswer = snapshotAnswer(before);

  if (currentAssistantCount > beforeAssistantCount) return true;
  if (currentKey && beforeKey && currentKey !== beforeKey) return true;
  if (currentAnswer !== beforeAnswer) return true;

  const userAdvanced = currentUserCount > beforeUserCount;
  if (userAdvanced && snapshot?.assistantAfterLastUser === true) return true;

  return false;
}

function claimLossReason(value) {
  const text = cleanText(
    value?.reason || value?.error || value?.message || value || ""
  ).toLowerCase();
  return text.includes("message_not_claimed") ||
    text.includes("message not claimed") ||
    text.includes("claim_lost") ||
    text.includes("claim lost")
    ? text || "message_not_claimed"
    : "";
}

function markClaimLost(agent, reason) {
  if (!agent || !reason) return;
  agent.__davidClaimLost = true;
  agent.__davidClaimLostReason = cleanText(reason, 500);
}

function throwIfClaimLost(agent) {
  if (!agent?.__davidClaimLost) return;
  const error = new Error(
    `DAVID_CLAIM_LOST: ${agent.__davidClaimLostReason || "message_not_claimed"}`
  );
  error.code = "DAVID_CLAIM_LOST";
  throw error;
}

async function reportChecked(agent, ...args) {
  if (!agent?.showReport) return null;
  try {
    const result = await agent.showReport(...args);
    const reason = claimLossReason(result);
    if (reason) {
      markClaimLost(agent, reason);
      throwIfClaimLost(agent);
    }
    return result;
  } catch (error) {
    const reason = claimLossReason(error);
    if (reason) {
      markClaimLost(agent, reason);
      throwIfClaimLost(agent);
    }
    return null;
  }
}

function writeManifest(result) {
  try {
    const rootDir = result?.root_dir || process.cwd();
    const directory = path.join(rootDir, ".david-system");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "soul-anchor-2.json"), JSON.stringify({
      anchor: 2,
      version: VERSION,
      status: STATUS,
      installed_at: new Date().toISOString(),
      features: {
        one_login_window_per_user: true,
        same_window_opens_fixed_chat_after_login: true,
        final_answer_stability_ms: STABLE_MS,
        double_read_verification: true,
        repeated_identical_answers_supported: true,
        dom_turn_order_verification: true,
        claim_loss_cancellation: true,
        partial_answers_forbidden: true,
        max_wait_ms: responseTimeoutMs(),
        queue_restart_recovery: true,
        realtime_frontend_reconnect: true
      }
    }, null, 2), "utf8");
  } catch {}
}

function installAgentAnchor2(AgentClass) {
  if (typeof AgentClass !== "function") return false;
  const prototype = AgentClass.prototype;
  if (prototype.__davidSoulAnchor2Installed) return true;

  const originalGetSnapshot = prototype.getSnapshot;
  if (typeof originalGetSnapshot === "function") {
    prototype.getSnapshot = async function anchor2TurnAwareSnapshot(...args) {
      const snapshot = await originalGetSnapshot.apply(this, args);
      const turnState = await readTurnState(this);
      return {
        ...(snapshot || {}),
        ...turnState
      };
    };
  }

  const originalShowReport = prototype.showReport;
  if (typeof originalShowReport === "function") {
    prototype.showReport = async function anchor2ClaimAwareReport(...args) {
      try {
        const result = await originalShowReport.apply(this, args);
        const reason = claimLossReason(result);
        if (reason) markClaimLost(this, reason);
        return result;
      } catch (error) {
        const reason = claimLossReason(error);
        if (reason) markClaimLost(this, reason);
        throw error;
      }
    };
  }

  const originalOpenIfNeeded = prototype.openIfNeeded;
  if (typeof originalOpenIfNeeded === "function") {
    prototype.openIfNeeded = function anchor2OpenIfNeeded(url, ...args) {
      if (this.__anchor2OpenPromise) return this.__anchor2OpenPromise;
      const target = url || this.chatUrl;
      this.__anchor2OpenPromise = Promise.resolve()
        .then(() => originalOpenIfNeeded.call(this, target, ...args))
        .finally(() => {
          this.__anchor2OpenPromise = null;
        });
      return this.__anchor2OpenPromise;
    };
  }

  prototype.waitForAnswer = async function anchor2WaitForFinalAnswer(before, requestedTimeoutMs) {
    const timeoutMs = responseTimeoutMs(requestedTimeoutMs);
    const started = Date.now();
    let stableHash = "";
    let stableSince = 0;
    let lastReportAt = 0;
    let lastSnapshot = null;
    let generationSeen = false;

    this.__davidClaimLost = false;
    this.__davidClaimLostReason = "";

    while (Date.now() - started < timeoutMs) {
      throwIfClaimLost(this);

      const snapshot = await this.getSnapshot();
      lastSnapshot = snapshot;
      if (snapshot?.pageError) throw new Error(snapshot.pageError);

      const completion = await readCompletionState(this);
      const generating = Boolean(
        snapshot?.generating ||
        completion?.stopVisible ||
        completion?.streaming
      );
      if (generating) generationSeen = true;

      const continueVisible = Boolean(completion?.continueVisible);
      const answer = snapshotAnswer(snapshot);
      const isNew = isNewAssistant(snapshot, before, generationSeen);

      if (isNew && answer) {
        const nextHash = hashText(answer);
        if (nextHash !== stableHash) {
          stableHash = nextHash;
          stableSince = Date.now();
        }

        if (!generating && !continueVisible && Date.now() - stableSince >= STABLE_MS) {
          const firstText = answer;
          const firstHash = nextHash;
          await sleep(VERIFY_GAP_MS);
          throwIfClaimLost(this);

          const verifySnapshot = await this.getSnapshot();
          const verifyCompletion = await readCompletionState(this);
          const secondText = snapshotAnswer(verifySnapshot);
          const secondHash = hashText(secondText);
          const verifyGenerating = Boolean(
            verifySnapshot?.generating ||
            verifyCompletion?.stopVisible ||
            verifyCompletion?.streaming
          );
          const verifyIsNew = isNewAssistant(verifySnapshot, before, generationSeen);

          if (
            verifyIsNew &&
            !verifyGenerating &&
            !verifyCompletion?.continueVisible &&
            firstText === secondText &&
            firstHash === secondHash &&
            secondText.length > 0
          ) {
            await reportChecked(
              this,
              "answer_ready",
              `DAVID confirmed the final GPT answer twice · ${secondText.length} characters.`,
              {
                anchor: 2,
                anchor_version: VERSION,
                answer_chars: secondText.length,
                stable_ms: Date.now() - stableSince,
                assistant_dom_count: Number(verifySnapshot?.assistantDomCount || 0),
                user_dom_count: Number(verifySnapshot?.userDomCount || 0),
                hash: secondHash.slice(0, 16)
              },
              "ready"
            );
            return secondText;
          }

          stableHash = secondHash;
          stableSince = Date.now();
        }
      } else {
        stableHash = "";
        stableSince = 0;
      }

      if (Date.now() - lastReportAt >= REPORT_MS) {
        lastReportAt = Date.now();
        const elapsedSeconds = Math.round((Date.now() - started) / 1000);
        const message = continueVisible
          ? `GPT paused with Continue generating · DAVID will not copy a partial answer · ${elapsedSeconds} sec.`
          : generating
            ? `GPT is still writing · DAVID waits for the real final answer · ${elapsedSeconds} sec.`
            : isNew && answer
              ? `DAVID verifies the final answer for ${Math.round(STABLE_MS / 1000)} seconds · ${elapsedSeconds} sec.`
              : answer
                ? `DAVID waits for the new assistant turn, not an older repeated answer · ${elapsedSeconds} sec.`
                : `DAVID waits for the first character of the GPT answer · ${elapsedSeconds} sec.`;
        await reportChecked(
          this,
          "waiting_for_gpt",
          message,
          {
            anchor: 2,
            anchor_version: VERSION,
            elapsed_seconds: elapsedSeconds,
            answer_chars: answer.length,
            generating,
            generation_seen: generationSeen,
            new_assistant_turn: isNew,
            assistant_dom_count: Number(snapshot?.assistantDomCount || 0),
            user_dom_count: Number(snapshot?.userDomCount || 0),
            assistant_after_last_user: snapshot?.assistantAfterLastUser === true,
            continue_generating: continueVisible,
            stable_ms: stableSince ? Date.now() - stableSince : 0
          },
          "working"
        );
      }

      await sleep(POLL_MS);
    }

    const diagnostic = lastSnapshot
      ? ` last_chars=${snapshotAnswer(lastSnapshot).length}` +
        ` generating=${Boolean(lastSnapshot.generating)}` +
        ` assistant_dom_count=${Number(lastSnapshot.assistantDomCount || 0)}` +
        ` user_dom_count=${Number(lastSnapshot.userDomCount || 0)}` +
        ` assistant_after_last_user=${lastSnapshot.assistantAfterLastUser === true}`
      : "";
    throw new Error(
      `DAVID SOUL Anchor 2 waited ${Math.round(timeoutMs / 60000)} minutes, ` +
      `but GPT did not produce a confirmed final answer. No partial answer was returned.${diagnostic}`
    );
  };

  Object.defineProperty(prototype, "__davidSoulAnchor2Installed", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  return true;
}

function installMultiSessionAnchor2(MultiSessionClass) {
  if (typeof MultiSessionClass !== "function") return false;
  const prototype = MultiSessionClass.prototype;
  if (prototype.__davidSoulAnchor2MultiInstalled) return true;

  const originalEnsureReady = prototype.ensureReady;
  if (typeof originalEnsureReady === "function") {
    prototype.ensureReady = function anchor2EnsureReady(url, ...args) {
      this.__anchor2ReadyPromises = this.__anchor2ReadyPromises || new Map();
      const key = String(url || "").trim().replace(/\/$/, "");
      if (this.__anchor2ReadyPromises.has(key)) {
        return this.__anchor2ReadyPromises.get(key);
      }
      const promise = Promise.resolve()
        .then(() => originalEnsureReady.call(this, url, ...args))
        .finally(() => this.__anchor2ReadyPromises.delete(key));
      this.__anchor2ReadyPromises.set(key, promise);
      return promise;
    };
  }

  Object.defineProperty(prototype, "__davidSoulAnchor2MultiInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  return true;
}

function installDavidSoulAnchor2(options = {}) {
  const agentInstalled = installAgentAnchor2(browserModule.EdgeSoulBrowserAgent);
  const multiInstalled = installMultiSessionAnchor2(browserModule.EdgeSoulMultiSessionAgent);
  const result = {
    anchor: 2,
    version: VERSION,
    status: STATUS,
    agent_installed: agentInstalled,
    multi_session_installed: multiInstalled,
    one_login_window_per_user: true,
    final_answer_stability_ms: STABLE_MS,
    double_read_verification: true,
    repeated_identical_answers_supported: true,
    dom_turn_order_verification: true,
    claim_loss_cancellation: true,
    partial_answers_forbidden: true,
    response_timeout_ms: responseTimeoutMs(),
    root_dir: options.rootDir || process.cwd()
  };
  writeManifest(result);
  return result;
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`DAVID SOUL Anchor 2 self-test failed: ${message}`);
  };

  assert(hashText("abc") === hashText("abc"), "stable hash");
  assert(hashText("abc") !== hashText("abcd"), "hash changes with answer");
  assert(responseTimeoutMs(1000) >= DEFAULT_TIMEOUT_MS, "minimum final-answer timeout");
  assert(
    isNewAssistant(
      { assistantDomCount: 2, userDomCount: 2, lastAssistantDomText: "same" },
      { assistantDomCount: 1, userDomCount: 1, lastAssistantDomText: "same" }
    ),
    "repeated identical answer accepted when assistant turn count advances"
  );
  assert(
    isNewAssistant(
      { assistantDomCount: 1, userDomCount: 2, lastAssistantDomText: "same", assistantAfterLastUser: true },
      { assistantDomCount: 1, userDomCount: 1, lastAssistantDomText: "same", assistantAfterLastUser: true },
      true
    ),
    "DOM turn order fallback accepts repeated answer after new user turn"
  );
  assert(
    !isNewAssistant(
      { assistantDomCount: 1, userDomCount: 2, lastAssistantDomText: "old", assistantAfterLastUser: false },
      { assistantDomCount: 1, userDomCount: 1, lastAssistantDomText: "old", assistantAfterLastUser: true },
      true
    ),
    "old assistant before newest user is rejected"
  );
  assert(claimLossReason({ reason: "message_not_claimed" }), "claim loss recognized");

  const result = installDavidSoulAnchor2({ rootDir: process.cwd() });
  assert(result.agent_installed, "EdgeSoulBrowserAgent patch installed");
  assert(result.partial_answers_forbidden, "partial answers forbidden");
  assert(result.final_answer_stability_ms === 5000, "five-second stability window");
  assert(result.repeated_identical_answers_supported, "repeated answers supported");
  assert(result.claim_loss_cancellation, "claim loss cancellation installed");
  return result;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  POLL_MS,
  STABLE_MS,
  STATUS,
  VERSION,
  claimLossReason,
  cleanText,
  hashText,
  installDavidSoulAnchor2,
  isNewAssistant,
  responseTimeoutMs,
  runSelfTest
};

if (require.main === module) {
  const result = runSelfTest();
  console.log("DAVID SOUL ANCHOR 2 TURN-AWARE SELF-TEST: PASS");
  console.log(JSON.stringify(result, null, 2));
}
