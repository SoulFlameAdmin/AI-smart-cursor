"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const launcherPath = path.join(root, "START-BORKO-DAVID-SOUL.ps1");
const source = fs.readFileSync(launcherPath, "utf8");

assert.match(source, /Parameter\(Mandatory = \$true\)/u);
assert.match(source, /https:\/\/chatgpt\\\.com\/c\//u);
assert.match(source, /DAVID_SOUL_CHAT_URL/u);
assert.match(source, /DAVID_SOUL_USER_ID/u);
assert.match(source, /config-backups/u);
assert.match(source, /\.env\.before-borko-/u);
assert.match(source, /Copy-Item -LiteralPath \$backupPath -Destination \$envPath/u);
assert.match(source, /REPAIR-AND-START-DAVID-SOUL\.ps1/u);
assert.match(source, /\[switch\]\$RunTests/u);
assert.match(source, /& \$repairLauncher -SkipTests/u);
assert.match(source, /verified in GitHub CI; skipped locally for fast startup/u);
assert.match(source, /Previous DAVID local configuration was restored/u);
assert.doesNotMatch(source, /https:\/\/chatgpt\.com\/c\/[0-9a-f-]{20,}/iu);
assert.doesNotMatch(source, /Write-Host[^\n]*\$ChatUrl/u);
assert.doesNotMatch(source, /DAVID_DEVICE_TOKEN\s*=/u);

console.log("DAVID SOUL Borko private fixed-chat fast-start launcher tests: PASS");
