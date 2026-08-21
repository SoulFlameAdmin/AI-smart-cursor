"use strict";

const assert = require("assert");
const path = require("path");

const workerModule = process.env.DAVID_WORKER_MODULE_PATH ||
  path.join(__dirname, "..", "core", "david-thinker-worker.cjs");
const { AttachedThinkerBrowser } = require(workerModule);

const EXPECTED = "{\"protocol\":\"david_upgrade_loop_v1\",\"status\":\"action\"}";

function createHarness(mode) {
  const state = {
    fallbackClicks: 0,
    reports: [],
    cdpCalls: []
  };

  const connection = {
    async send(method, params) {
      state.cdpCalls.push({ method, params });
      return {};
    }
  };

  const harness = {
    connection,
    __davidExpectedPromptText: EXPECTED,
    __davidSendPrimaryConfirmMs: 1,
    __davidSendRestoredDraftGraceMs: 5,
    __davidSendFallbackConfirmMs: 5,
    __davidSendConfirmationPollMs: 1,
    async evaluate(source) {
      if (source.includes("button.click();")) {
        if (mode === "empty_pending") {
          throw new Error("Fallback must never run for a consumed composer.");
        }
        state.fallbackClicks += 1;
        return { clicked: true, reason: "exact_draft_restored" };
      }

      if (source.includes("composerMatchesExpected")) {
        if (mode === "empty_pending") {
          return {
            composerEmpty: true,
            composerChars: 0,
            composerMatchesExpected: false,
            exactMatches: 0,
            stopVisible: false
          };
        }

        if (mode === "restored_then_consumed" && state.fallbackClicks === 1) {
          return {
            composerEmpty: true,
            composerChars: 0,
            composerMatchesExpected: false,
            exactMatches: 0,
            stopVisible: true
          };
        }

        return {
          composerEmpty: false,
          composerChars: EXPECTED.length,
          composerMatchesExpected: true,
          exactMatches: 0,
          stopVisible: false
        };
      }

      if (source.includes("send_button_not_ready")) {
        return { ok: true, x: 20, y: 30, composerChars: EXPECTED.length };
      }

      throw new Error("Unexpected browser evaluation in contract test.");
    },
    async getSnapshot() {
      return {
        userCount: 0,
        lastUser: "",
        last: "",
        generating: false
      };
    },
    async showReport(event, message, detail, status) {
      state.reports.push({ event, message, detail, status });
    }
  };

  return { harness, state };
}

async function run() {
  {
    const { harness, state } = createHarness("restored_then_consumed");
    await AttachedThinkerBrowser.prototype.sendPrompt.call(harness, {});
    assert.strictEqual(state.fallbackClicks, 1, "restored draft must get one fallback");
    assert.strictEqual(harness.__davidExpectedPromptText, "");
    assert(state.reports.some((item) =>
      item.event === "worker_send_restored_draft_fallback"));
    assert(state.reports.some((item) => item.event === "worker_send_confirmed"));
  }

  {
    const { harness, state } = createHarness("empty_pending");
    await AttachedThinkerBrowser.prototype.sendPrompt.call(harness, {});
    assert.strictEqual(state.fallbackClicks, 0, "empty composer must never be resent");
    assert.strictEqual(harness.__davidExpectedPromptText, "");
    assert(state.reports.some((item) => item.event === "worker_send_commit_pending"));
  }

  {
    const { harness, state } = createHarness("fallback_stuck");
    await assert.rejects(
      () => AttachedThinkerBrowser.prototype.sendPrompt.call(harness, {}),
      /single fallback Send did not consume/
    );
    assert.strictEqual(state.fallbackClicks, 1, "fallback must remain single-shot");
    assert.strictEqual(harness.__davidExpectedPromptText, EXPECTED);
  }

  console.log("DAVID TRANSACTIONAL SEND CONTRACT PASS");
}

run().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
