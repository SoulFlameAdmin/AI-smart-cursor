"use strict";

const TRUSTED_REPOSITORY = "SoulFlameAdmin/AI-smart-cursor";
const PROTOCOL_VERSION = "david-upgrade/0.1";

function buildUpgradeRequest({ request, currentVersion, currentCommit, diagnostics = [] }) {
  if (!String(request || "").trim()) {
    throw new Error("Upgrade request is empty.");
  }

  return {
    protocol: PROTOCOL_VERSION,
    type: "upgrade_request",
    repository: TRUSTED_REPOSITORY,
    request: String(request).trim(),
    device: {
      currentVersion: currentVersion || "unknown",
      currentCommit: currentCommit || "unknown"
    },
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    requirements: {
      backup: true,
      tests: true,
      healthCheck: true,
      rollback: true
    }
  };
}

function validateUpgradeEnvelope(value) {
  const errors = [];
  const envelope = value && typeof value === "object" ? value : {};

  if (envelope.protocol !== PROTOCOL_VERSION) {
    errors.push("Invalid protocol version.");
  }

  if (envelope.type !== "upgrade_release") {
    errors.push("Invalid envelope type.");
  }

  if (envelope.repository !== TRUSTED_REPOSITORY) {
    errors.push("Untrusted repository.");
  }

  if (!/^[0-9a-f]{40}$/iu.test(String(envelope.commit || ""))) {
    errors.push("Commit must be a full 40-character SHA.");
  }

  if (!Array.isArray(envelope.changedFiles) || envelope.changedFiles.length === 0) {
    errors.push("changedFiles is required.");
  }

  if (!String(envelope.testCommand || "").trim()) {
    errors.push("testCommand is required.");
  }

  if (!String(envelope.healthCheck || "").trim()) {
    errors.push("healthCheck is required.");
  }

  return {
    ok: errors.length === 0,
    errors,
    envelope
  };
}

function buildCompletionReport({ commit, testsPassed, healthPassed, rollbackUsed = false, log = [] }) {
  const success = Boolean(testsPassed && healthPassed && !rollbackUsed);

  return {
    protocol: PROTOCOL_VERSION,
    type: "upgrade_result",
    repository: TRUSTED_REPOSITORY,
    commit: commit || null,
    success,
    testsPassed: Boolean(testsPassed),
    healthPassed: Boolean(healthPassed),
    rollbackUsed: Boolean(rollbackUsed),
    log: Array.isArray(log) ? log : [String(log)],
    terminalMessage: success ? "GOTOVO DAVID" : "DAVID ROLLBACK"
  };
}

module.exports = {
  TRUSTED_REPOSITORY,
  PROTOCOL_VERSION,
  buildUpgradeRequest,
  validateUpgradeEnvelope,
  buildCompletionReport
};
