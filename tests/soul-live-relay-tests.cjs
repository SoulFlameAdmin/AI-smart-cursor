"use strict";

const assert = require("assert");
const {
  HEARTBEAT_MS,
  LIVE_RELAY_VERSION,
  LIVE_STAGES,
  progressLabel
} = require("../core/soul-relay-live.cjs");
const {
  SoulBrowserAgent,
  pageSnapshotRuntime,
  isChatGptUrl,
  sameConversation
} = require("../core/soul-relay-runtime-v3.cjs");

assert.strictEqual(LIVE_RELAY_VERSION, "david-soul-relay-v3");
assert.strictEqual(HEARTBEAT_MS, 5000);
assert.strictEqual(LIVE_STAGES.RECEIVED, "received");
assert.strictEqual(LIVE_STAGES.GPT_THINKING, "gpt_thinking");
assert.strictEqual(LIVE_STAGES.RETURNING_TO_SOUL, "returning_to_soul");
assert.match(progressLabel(LIVE_STAGES.RECEIVED), /получи съобщението/u);
assert.match(progressLabel(LIVE_STAGES.GPT_THINKING, 15), /15 сек/u);
assert.match(progressLabel(LIVE_STAGES.COMPLETED), /завършен/u);
assert.strictEqual(typeof SoulBrowserAgent.prototype.showReport, "function");
assert.strictEqual(typeof SoulBrowserAgent.prototype.diagnose, "function");
assert.strictEqual(typeof SoulBrowserAgent.prototype.runPage, "function");
assert.strictEqual(typeof SoulBrowserAgent.prototype.getSnapshot, "function");
assert.strictEqual(typeof SoulBrowserAgent.prototype.openIfNeeded, "function");
assert.strictEqual(typeof pageSnapshotRuntime, "function");
assert.strictEqual(typeof isChatGptUrl, "function");
assert.strictEqual(typeof sameConversation, "function");
assert.match(SoulBrowserAgent.prototype.runPage.toString(), /pageFindPrompt/u);
assert.match(SoulBrowserAgent.prototype.getSnapshot.toString(), /pageSnapshotRuntime/u);

const openSource = SoulBrowserAgent.prototype.openIfNeeded.toString();
assert.match(openSource, /ERR_FAILED/u);
assert.match(openSource, /ERR_ABORTED/u);
assert.match(openSource, /manual_login/u);
assert.match(openSource, /sameConversation/u);
assert.match(openSource, /10 \* 60 \* 1000/u);

assert.strictEqual(isChatGptUrl("https://chatgpt.com/c/example"), true);
assert.strictEqual(isChatGptUrl("https://example.com/c/example"), false);
assert.strictEqual(
  sameConversation(
    "https://chatgpt.com/c/abc-123?model=test",
    "https://chatgpt.com/c/abc-123"
  ),
  true
);
assert.strictEqual(
  sameConversation(
    "https://chatgpt.com/",
    "https://chatgpt.com/c/abc-123"
  ),
  false
);

const snapshotSource = pageSnapshotRuntime.toString();
assert.match(snapshotSource, /conversation-turn-/u);
assert.match(snapshotSource, /data-message-author-role/u);
assert.match(snapshotSource, /lastAssistantTurnKey/u);
assert.match(snapshotSource, /data-is-streaming/u);
assert.match(snapshotSource, /stop-button/u);
assert.match(snapshotSource, /result-streaming/u);

console.log("DAVID live Soul relay v3 redirect recovery and answer detection tests: PASS");
