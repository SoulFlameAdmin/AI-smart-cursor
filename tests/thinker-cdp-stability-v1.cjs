"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const patchPath = path.join(root, "core", "david-thinker-cdp-stability-v1.cjs");
const source = fs.readFileSync(patchPath, "utf8");
const patch = require(patchPath);

assert.strictEqual(patch.VERSION, "david-thinker-cdp-stability-v1.1");
assert.strictEqual(typeof patch.installDavidThinkerCdpStabilityV1, "function");
assert.strictEqual(typeof patch.isThinkerProcess, "function");
assert.ok(patch.MIN_COMMAND_TIMEOUT_MS instanceof Map);
assert.strictEqual(patch.MIN_COMMAND_TIMEOUT_MS.get("Runtime.evaluate"), 60000);
assert.strictEqual(
  patch.isThinkerProcess(["node.exe", "D:/DAVID_ASI/DAVID/core/david-thinker-worker.cjs"]),
  true
);
assert.strictEqual(
  patch.isThinkerProcess(["node.exe", "D:/DAVID_ASI/DAVID/core/david-thinker-node-keeper.cjs"]),
  true
);
assert.strictEqual(
  patch.isThinkerProcess(["node.exe", "D:/DAVID_ASI/DAVID/edge-soul-node-main.cjs"]),
  false
);
assert.match(source, /Runtime\.enable/u);
assert.match(source, /Page\.enable/u);
assert.match(source, /Page\.bringToFront/u);
assert.match(source, /OPTIONAL_COMMANDS\.has\(name\)/u);
assert.match(source, /MIN_COMMAND_TIMEOUT_MS\.get\(name\)/u);
assert.match(source, /effectiveTimeoutMs/u);
assert.match(source, /Do NOT retry Runtime\.evaluate/u);
assert.match(source, /originalSend\.call\(this, method, params, effectiveTimeoutMs\)/u);
assert.match(source, /not-a-thinker-process/u);

console.log("DAVID THINKER CDP STABILITY V1.1 CONTRACT PASS");
