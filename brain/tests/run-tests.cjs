"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseDavidInput,
  buildUpgradeRequest,
  validateUpgradeEnvelope,
  buildCompletionReport,
  MemoryStore
} = require("../index.cjs");

function run() {
  const normal = parseDavidInput("пиши на GPT zdr2");
  assert.strictEqual(normal.kind, "command");
  assert.strictEqual(normal.requiresTeacher, false);

  const upgrade = parseDavidInput("-david направи курсора по-бърз");
  assert.strictEqual(upgrade.kind, "upgrade_request");
  assert.strictEqual(upgrade.request, "направи курсора по-бърз");
  assert.strictEqual(upgrade.requiresTeacher, true);

  const emptyUpgrade = parseDavidInput("-david");
  assert.strictEqual(emptyUpgrade.needsClarification, true);

  const request = buildUpgradeRequest({
    request: upgrade.request,
    currentVersion: "0.1.0-start",
    currentCommit: "unknown"
  });
  assert.strictEqual(request.repository, "SoulFlameAdmin/AI-smart-cursor");
  assert.strictEqual(request.requirements.rollback, true);

  const validEnvelope = validateUpgradeEnvelope({
    protocol: "david-upgrade/0.1",
    type: "upgrade_release",
    repository: "SoulFlameAdmin/AI-smart-cursor",
    commit: "a".repeat(40),
    changedFiles: ["brain/index.cjs"],
    testCommand: "npm test",
    healthCheck: "renderer-ready"
  });
  assert.strictEqual(validEnvelope.ok, true);

  const invalidEnvelope = validateUpgradeEnvelope({
    protocol: "unknown",
    repository: "someone/else"
  });
  assert.strictEqual(invalidEnvelope.ok, false);
  assert.ok(invalidEnvelope.errors.length >= 4);

  const success = buildCompletionReport({
    commit: "a".repeat(40),
    testsPassed: true,
    healthPassed: true
  });
  assert.strictEqual(success.terminalMessage, "GOTOVO DAVID");
  assert.strictEqual(success.success, true);

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "david-brain-"));
  const memoryPath = path.join(tempDirectory, "memory.json");
  const store = new MemoryStore(memoryPath);
  store.recordUpgradeRequest(request);
  store.recordUpgradeResult(success);

  const reloaded = new MemoryStore(memoryPath);
  assert.strictEqual(reloaded.state.upgradeRequests.length, 1);
  assert.strictEqual(reloaded.state.upgradeResults.length, 1);

  fs.rmSync(tempDirectory, { recursive: true, force: true });

  console.log("DAVID Brain 0.1 tests: PASS");
}

run();
