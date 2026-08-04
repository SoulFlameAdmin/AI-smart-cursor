"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const recoveryPath = path.join(root, "core", "edge-soul-recovery-patch.cjs");
const mainPath = path.join(root, "edge-soul-main.cjs");
const repairLauncherPath = path.join(root, "REPAIR-AND-START-DAVID-SOUL.ps1");

const recovery = fs.readFileSync(recoveryPath, "utf8");
const main = fs.readFileSync(mainPath, "utf8");
const launcher = fs.readFileSync(repairLauncherPath, "utf8");

assert.match(recovery, /installEdgeSoulRecovery/u);
assert.match(recovery, /stopDedicatedEdgeProcesses/u);
assert.match(recovery, /--user-data-dir/u);
assert.match(recovery, /--remote-debugging-port/u);
assert.match(recovery, /Name='msedge\.exe'/u);
assert.match(recovery, /retry_count:\s*1/u);
assert.match(recovery, /dedicated_edge_only:\s*true/u);
assert.doesNotMatch(recovery, /taskkill\s+\/IM\s+msedge\.exe/u);
assert.doesNotMatch(recovery, /Stop-Process\s+-Name\s+(?:msedge|MicrosoftEdge)/u);

assert.match(main, /require\("\.\/core\/edge-soul-recovery-patch\.cjs"\)/u);
assert.match(main, /installEdgeSoulRecovery\(\)/u);
assert.match(main, /installReliableSoulSendConfirmation\(\)/u);
assert.match(main, /requestSingleInstanceLock/u);

assert.match(launcher, /STOP-DAVID-SOUL-MODE\.ps1/u);
assert.match(launcher, /START-DAVID-SOUL-MODE\.ps1/u);
assert.match(launcher, /persistent Edge profile/u);
assert.match(launcher, /New-Item -ItemType Directory/u);
assert.match(launcher, /stopped normally/u);
assert.doesNotMatch(launcher, /ResetEdgeProfile/u);

console.log("DAVID SOUL dedicated Edge recovery and repair launcher tests: PASS");
