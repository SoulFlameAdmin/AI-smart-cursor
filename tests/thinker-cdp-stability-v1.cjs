"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const patchPath = path.join(root, "core", "david-thinker-cdp-stability-v1.cjs");
const source = fs.readFileSync(patchPath, "utf8");
const patch = require(patchPath);

assert.strictEqual(patch.VERSION, "david-thinker-cdp-stability-v1");
assert.strictEqual(typeof patch.installDavidThinkerCdpStabilityV1, "function");
assert.strictEqual(typeof patch.isThinkerProcess, "function");
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
assert.match(source, /originalSend\.call\(this, method, params, timeoutMs\)/u);
assert.match(source, /not-a-thinker-process/u);

console.log("DAVID THINKER CDP STABILITY V1 CONTRACT PASS");
