"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const launcherPath = path.join(root, "START-DAVID-SOUL-NODE.ps1");
const source = fs.readFileSync(launcherPath, "utf8");

assert.match(source, /edge-soul-node-main\.cjs/u);
assert.match(source, /DAVID SOUL NODE MODE - ELECTRON FREE/u);
assert.match(source, /DAVID_EDGE_DEBUG_PORT = '9333'/u);
assert.match(source, /DAVID_EDGE_PROFILE_DIR/u);
assert.match(source, /DAVID_SOUL_STATUS_FILE/u);
assert.match(source, /soul-node-runtime-v1\.cjs/u);
assert.match(source, /Press Ctrl\+C to stop DAVID SOUL Node mode/u);
assert.doesNotMatch(source, /node_modules\\electron/u);
assert.doesNotMatch(source, /START-DAVID-SOUL-MODE\.ps1/u);
assert.doesNotMatch(source, /ResetEdgeProfile/u);
assert.doesNotMatch(source, /\.env[^\n]*Write-Host/u);

console.log("DAVID SOUL NODE LAUNCHER V1 CONTRACT PASS");
