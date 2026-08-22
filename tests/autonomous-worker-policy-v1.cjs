"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  boundedAutonomousGptTimeoutMs,
  isAutonomousInnerGoal
} = require("../core/david-teacher-client.cjs");
const { loadConfig } = require("../core/config.cjs");

assert.strictEqual(
  isAutonomousInnerGoal("DAVID AUTONOMOUS ORCHESTRATOR V1\nGOAL=test"),
  true
);
assert.strictEqual(isAutonomousInnerGoal("normal teacher goal"), false);
assert.ok(boundedAutonomousGptTimeoutMs() >= 240000);
assert.ok(boundedAutonomousGptTimeoutMs() <= 900000);

const oldRepo = process.env.DAVID_AUTO_APPROVE_REPOSITORY_POWERSHELL;
try {
  process.env.DAVID_AUTO_APPROVE_REPOSITORY_POWERSHELL = "true";
  assert.strictEqual(loadConfig().autoApproveRepositoryPowerShell, true);
} finally {
  if (oldRepo === undefined) delete process.env.DAVID_AUTO_APPROVE_REPOSITORY_POWERSHELL;
  else process.env.DAVID_AUTO_APPROVE_REPOSITORY_POWERSHELL = oldRepo;
}

const clientSource = fs.readFileSync(
  path.join(__dirname, "..", "core", "david-teacher-client.cjs"),
  "utf8"
);
assert.match(clientSource, /DAVID_AUTONOMOUS_REPOSITORY_POLICY_V1/u);
assert.match(clientSource, /DAVID_AUTO_APPROVE_REPOSITORY_POWERSHELL\s*=\s*"true"/u);
assert.match(clientSource, /DAVID_GPT_RESPONSE_TIMEOUT_MS\s*=\s*String\(boundedAutonomousGptTimeoutMs\(\)\)/u);

console.log("DAVID AUTONOMOUS WORKER POLICY V1 CONTRACT PASS");
