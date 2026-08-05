"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const launcherPath = path.join(root, "START-BORKO-DAVID-SOUL.ps1");
const source = fs.readFileSync(launcherPath, "utf8");

assert.match(source, /https:\/\/chatgpt\\\.com\/c\//u);
assert.match(source, /DAVID_SOUL_CHAT_URL/u);
assert.match(source, /DAVID_SOUL_USER_ID/u);
assert.match(source, /\.david-instances\\borko/u);
assert.match(source, /instance\.env/u);
assert.match(source, /START-DAVID-SOUL-INSTANCE\.ps1/u);
assert.match(source, /InstanceName 'borko'/u);
assert.match(source, /PreferredDebugPort 9444/u);
assert.match(source, /separate saved ChatGPT login/u);
assert.match(source, /only Borko SOUL messages/u);
assert.match(source, /ConfigureOnly/u);
assert.doesNotMatch(source, /Copy-Item[^\n]+\.env/u);
assert.doesNotMatch(source, /REPAIR-AND-START-DAVID-SOUL\.ps1/u);
assert.doesNotMatch(source, /https:\/\/chatgpt\.com\/c\/[0-9a-f-]{20,}/iu);
assert.doesNotMatch(source, /Write-Host[^\n]*\$ChatUrl/u);
assert.doesNotMatch(source, /DAVID_DEVICE_TOKEN\s*=/u);

console.log("DAVID SOUL Borko isolated fixed-chat launcher tests: PASS");
