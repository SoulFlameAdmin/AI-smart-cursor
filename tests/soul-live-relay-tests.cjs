"use strict";

const assert = require("assert");
const {
  HEARTBEAT_MS,
  LIVE_RELAY_VERSION,
  LIVE_STAGES,
  progressLabel
} = require("../core/soul-relay-live.cjs");
const { SoulBrowserAgent } = require("../core/soul-relay-runtime-v3.cjs");

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
assert.match(SoulBrowserAgent.prototype.runPage.toString(), /pageFindPrompt/u);

console.log("DAVID live Soul relay v3 real HUD tests: PASS");
