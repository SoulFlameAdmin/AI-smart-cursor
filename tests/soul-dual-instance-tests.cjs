"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const instance = fs.readFileSync(path.join(root, "START-DAVID-SOUL-INSTANCE.ps1"), "utf8");
const mitko = fs.readFileSync(path.join(root, "START-MITKO-DAVID-SOUL.ps1"), "utf8");
const borko = fs.readFileSync(path.join(root, "START-BORKO-DAVID-SOUL.ps1"), "utf8");
const both = fs.readFileSync(path.join(root, "START-BOTH-DAVID-SOUL.ps1"), "utf8");
const main = fs.readFileSync(path.join(root, "edge-soul-main.cjs"), "utf8");

assert.match(instance, /\.david-instances\\\$instance/u);
assert.match(instance, /--david-soul-instance=\$instance/u);
assert.match(instance, /DAVID_SOUL_MULTI_INSTANCE/u);
assert.match(instance, /DAVID_SOUL_INSTANCE_ID/u);
assert.match(instance, /Stop-OnlyThisInstance/u);
assert.match(instance, /CommandLine -like "\*--david-soul-instance=\$instance\*"/u);
assert.doesNotMatch(instance, /ExecutablePath -eq \$electronExe -or/u);
assert.doesNotMatch(instance, /CommandLine -like "\*\$root\*"/u);
assert.match(instance, /edge-soul-profile/u);
assert.match(instance, /electron-worker-data/u);
assert.match(instance, /soul-status\.json/u);
assert.match(instance, /david-soul\.pid/u);

assert.match(mitko, /InstanceName 'mitko'/u);
assert.match(mitko, /PreferredDebugPort 9333/u);
assert.match(mitko, /legacyProfile/u);
assert.match(mitko, /Copy-Item -LiteralPath \$legacyProfile/u);
assert.match(borko, /InstanceName 'borko'/u);
assert.match(borko, /PreferredDebugPort 9444/u);
assert.match(borko, /\.david-instances\\borko/u);

assert.match(both, /START-MITKO-DAVID-SOUL\.ps1/u);
assert.match(both, /START-BORKO-DAVID-SOUL\.ps1/u);
assert.match(both, /Start-Process/u);
assert.match(both, /TWO DAVID SOUL SERVERS STARTED/u);
assert.match(both, /does not stop the other/u);
assert.match(both, /function Find-PowerShellExecutable/u);
assert.match(both, /Get-Process -Id \$PID/u);
assert.match(both, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/u);
assert.match(both, /Join-Path \$PSHOME 'pwsh\.exe'/u);
assert.doesNotMatch(both, /\(Get-Command powershell\.exe -ErrorAction Stop\)\.Source/u);

assert.match(main, /const multiInstance = process\.env\.DAVID_SOUL_MULTI_INSTANCE === "1"/u);
assert.match(main, /multiInstance\s*\?\s*true\s*:\s*app\.requestSingleInstanceLock/u);
assert.match(main, /instance_id: instanceId/u);
assert.match(main, /isolated Edge -> fixed GPT chat/u);

assert.doesNotMatch(instance, /chatgpt\.com\/c\/[0-9a-f-]{20,}/iu);
assert.doesNotMatch(both, /DAVID_DEVICE_TOKEN/u);

console.log("DAVID SOUL dual-instance isolation, profile migration and PowerShell resolution tests: PASS");
