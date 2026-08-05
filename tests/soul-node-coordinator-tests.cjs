"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const coordinator = fs.readFileSync(
  path.join(root, "david-soul-node-coordinator.cjs"),
  "utf8"
);
const start = fs.readFileSync(
  path.join(root, "START-DAVID-SOUL-LIGHT.ps1"),
  "utf8"
);
const stop = fs.readFileSync(
  path.join(root, "STOP-DAVID-SOUL-LIGHT.ps1"),
  "utf8"
);

assert.doesNotMatch(coordinator, /require\(["']electron["']\)/u);
assert.doesNotMatch(coordinator, /electron\.exe/u);
assert.match(coordinator, /node-multi-session/u);
assert.match(coordinator, /discoverInstanceSpecs/u);
assert.match(coordinator, /BASE_ENV_FILE/u);
assert.match(coordinator, /\.david-instances/u);
assert.match(coordinator, /instance\.env/u);
assert.match(coordinator, /name:\s*"mitko"/u);
assert.match(coordinator, /if \(name === "borko"\) return 9444/u);
assert.match(coordinator, /BOOT_STAGGER_MS\s*=\s*7000/u);
assert.match(coordinator, /await sleep\(BOOT_STAGGER_MS\)/u);
assert.match(coordinator, /stopDedicatedEdgeProcesses/u);
assert.match(coordinator, /runtime\.state === "error"/u);
assert.match(coordinator, /Math\.min\(60000/u);
assert.match(coordinator, /DAVID_SOUL_ENABLED/u);
assert.match(coordinator, /DAVID_DEVICE_TOKEN/u);
assert.match(coordinator, /DAVID_SOUL_USER_ID/u);
assert.match(coordinator, /DAVID_SOUL_CHAT_URL/u);
assert.match(coordinator, /profileDir/u);
assert.match(coordinator, /electron_used:\s*false/u);
assert.doesNotMatch(coordinator, /chatgpt\.com\/c\/[0-9a-f-]{20,}/iu);
assert.doesNotMatch(coordinator, /console\.(?:log|error)\([^\n]*(?:DEVICE_TOKEN|CHAT_URL)/u);

assert.match(start, /Node\.js 22 or newer/u);
assert.match(start, /david-soul-node-coordinator\.cjs/u);
assert.match(start, /STOP-DAVID-SOUL-LIGHT\.ps1/u);
assert.match(start, /Electron\s+: not used/u);
assert.match(start, /\.david-instances\\<name>\\instance\.env/u);
assert.doesNotMatch(start, /electron\.exe/u);
assert.doesNotMatch(start, /\)\.Source/u);
assert.doesNotMatch(start, /chatgpt\.com\/c\/[0-9a-f-]{20,}/iu);

assert.match(stop, /coordinator\.pid/u);
assert.match(stop, /--david-soul-instance=/u);
assert.match(stop, /Name='msedge\.exe'/u);
assert.match(stop, /edge-soul-profile/u);
assert.match(stop, /--remote-debugging-port=/u);
assert.doesNotMatch(stop, /Stop-Process\s+-Name\s+msedge/u);
assert.doesNotMatch(stop, /taskkill/u);

console.log("DAVID SOUL lightweight Node multi-session coordinator tests: PASS");
