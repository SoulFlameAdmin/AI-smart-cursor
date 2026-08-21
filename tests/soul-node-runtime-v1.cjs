"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const runtimePath = path.join(root, "edge-soul-node-main.cjs");
const source = fs.readFileSync(runtimePath, "utf8");
const runtime = require(runtimePath);

assert.strictEqual(runtime.VERSION, "david-soul-node-main-v1");
assert.strictEqual(typeof runtime.boot, "function");
assert.strictEqual(typeof runtime.installRuntimePatches, "function");
assert.strictEqual(typeof runtime.writeStatus, "function");
assert.strictEqual(typeof runtime.inferState, "function");

assert.doesNotMatch(source, /require\(["']electron["']\)/u);
assert.doesNotMatch(source, /requestSingleInstanceLock/u);
assert.match(source, /BrowserWindow:\s*null/u);
assert.match(source, /EdgeSoulMultiSessionAgent/u);
assert.match(source, /LiveSoulRelay/u);
assert.match(source, /installPersistentSoulSession/u);
assert.match(source, /installEdgeSoulRecovery/u);
assert.match(source, /installCompletedSoulAnswerDetection/u);
assert.match(source, /installDavidSoulTurnFinalizerV4/u);
assert.match(source, /installDavidSoulAnchor2/u);
assert.match(source, /installDavidSoulMasterEdge/u);
assert.match(source, /installDavidSoulWholeTurnReturn/u);
assert.match(source, /installDavidSoulNetworkShield/u);
assert.match(source, /installDavidSoulAutoReconnectV11/u);
assert.match(source, /installDavidFastBrainIO/u);
assert.match(source, /electron_used:\s*false/u);
assert.match(source, /Soul -> Thinker -> Worker -> Soul/u);
assert.match(source, /DAVID_SOUL_CHAT_URL/u);
assert.match(source, /DAVID_DEVICE_TOKEN/u);
assert.match(source, /SUPABASE_URL/u);

assert.strictEqual(
  runtime.inferState("LOGIN HOLD: Log in to ChatGPT", "warning", {}),
  "login_required"
);
assert.strictEqual(
  runtime.inferState("SOUL mode is active and waiting for SOUL", "ready", {}),
  "ready"
);
assert.strictEqual(
  runtime.inferState("Saved login ready", "ready", { stage: "saved_login_ready" }),
  "gpt_ready"
);
assert.strictEqual(
  runtime.inferState("boom", "error", {}),
  "error"
);

console.log("DAVID SOUL NODE RUNTIME V1 CONTRACT PASS");
