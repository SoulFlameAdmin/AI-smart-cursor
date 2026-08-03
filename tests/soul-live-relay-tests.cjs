"use strict";

const assert = require("assert");
const {
  HEARTBEAT_MS,
  LIVE_RELAY_VERSION,
  LIVE_STAGES,
  progressLabel
} = require("../core/soul-relay-live.cjs");

assert.strictEqual(LIVE_RELAY_VERSION, "david-soul-relay-v2");
assert.strictEqual(HEARTBEAT_MS, 5000);
assert.strictEqual(LIVE_STAGES.RECEIVED, "received");
assert.strictEqual(LIVE_STAGES.GPT_THINKING, "gpt_thinking");
assert.strictEqual(LIVE_STAGES.RETURNING_TO_SOUL, "returning_to_soul");
assert.match(progressLabel(LIVE_STAGES.RECEIVED), /получи съобщението/u);
assert.match(progressLabel(LIVE_STAGES.GPT_THINKING, 15), /15 сек/u);
assert.match(progressLabel(LIVE_STAGES.COMPLETED), /завършен/u);

console.log("DAVID live Soul relay tests: PASS");
