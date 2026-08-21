"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const bootstrapPath = path.join(root, "core", "david-thinker-runtime-bootstrap.cjs");
const keeperPath = path.join(root, "core", "david-thinker-node-keeper.cjs");
const clientPath = path.join(root, "core", "david-teacher-client.cjs");

const bootstrap = require(bootstrapPath);
const keeper = require(keeperPath);
const bootstrapSource = fs.readFileSync(bootstrapPath, "utf8");
const keeperSource = fs.readFileSync(keeperPath, "utf8");
const clientSource = fs.readFileSync(clientPath, "utf8");

assert.strictEqual(bootstrap.DEFAULT_THINKER_PORT, 9444);
assert.strictEqual(typeof bootstrap.ensureThinkerRuntime, "function");
assert.strictEqual(typeof bootstrap.thinkerReady, "function");
assert.strictEqual(typeof bootstrap.thinkerPaths, "function");
assert.strictEqual(typeof keeper.boot, "function");
assert.strictEqual(keeper.port, 9444);

assert.match(bootstrapSource, /david-thinker-node-keeper\.cjs/u);
assert.match(bootstrapSource, /thinker-node-status\.json/u);
assert.match(bootstrapSource, /edge-soul-profile/u);
assert.match(bootstrapSource, /thinkerReady/u);
assert.match(bootstrapSource, /startKeeper/u);
assert.match(bootstrapSource, /\[REDACTED\]/u);

assert.match(keeperSource, /EdgeSoulBrowserAgent/u);
assert.match(keeperSource, /\.david-instances["'],\s*["']david/u);
assert.match(keeperSource, /debuggerReady/u);
assert.match(keeperSource, /healthLoop/u);
assert.match(keeperSource, /thinker_node_ready/u);

assert.match(clientSource, /DAVID_AUTONOMOUS_THINKER_BOOTSTRAP_V1/u);
assert.match(clientSource, /ensureThinkerRuntime/u);
assert.match(clientSource, /const thinkerPort = 9444/u);
assert.match(clientSource, /DAVID_TEACHER_EDGE_PORT:\s*String\(thinkerPort\)/u);

console.log("DAVID AUTONOMOUS THINKER BOOTSTRAP V1 CONTRACT PASS");
