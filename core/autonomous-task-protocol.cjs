"use strict";

const AUTONOMOUS_TASK_PROTOCOL = "david_autonomous_task_v1";
const DEFAULT_MAX_ROUNDS = 40;
const DEFAULT_MAX_DURATION_MS = 12 * 60 * 60 * 1000;

const TASK_STATES = Object.freeze([
  "queued",
  "observe",
  "think",
  "act",
  "test",
  "verify",
  "learn",
  "completed",
  "blocked",
  "failed"
]);

const MANDATORY_CONFIRMATION_CATEGORIES = Object.freeze([
  "credentials",
  "destructive_delete",
  "production_write",
  "external_publish",
  "payment",
  "account_permissions"
]);

const DEFAULT_PASS_CRITERIA = Object.freeze([
  "target_tests_pass",
  "regression_tests_pass",
  "no_unapproved_mandatory_risk",
  "final_verification_pass"
]);

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function stripSfAdminPrefix(value) {
  return normalizeText(value).replace(/^@sfadmin\b[\s:,-]*/iu, "").trim();
}

function normalizeStringArray(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return [...new Set(source.map(normalizeText).filter(Boolean))];
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function createAutonomousTask(input, overrides = {}) {
  const raw = typeof input === "string" ? { goal: input } : { ...(input || {}) };
  const merged = { ...raw, ...(overrides || {}) };
  const goal = stripSfAdminPrefix(merged.goal);

  if (!goal) {
    throw new Error("DAVID autonomous task requires a non-empty goal.");
  }

  const requestedAllowed = normalizeStringArray(merged.allowed_actions, [
    "inspect_repository",
    "read_logs",
    "edit_repository_files",
    "run_local_commands",
    "run_tests",
    "git_diff",
    "git_local_checkpoint"
  ]);

  const mandatoryConfirmation = normalizeStringArray(
    merged.mandatory_confirmation_categories,
    MANDATORY_CONFIRMATION_CATEGORIES
  );

  for (const required of MANDATORY_CONFIRMATION_CATEGORIES) {
    if (!mandatoryConfirmation.includes(required)) mandatoryConfirmation.push(required);
  }

  return {
    protocol: AUTONOMOUS_TASK_PROTOCOL,
    task_id: normalizeText(merged.task_id) || null,
    state: "queued",
    goal,
    pass_criteria: normalizeStringArray(
      merged.pass_criteria,
      DEFAULT_PASS_CRITERIA
    ),
    allowed_actions: requestedAllowed,
    mandatory_confirmation_categories: mandatoryConfirmation,
    max_rounds: clampInteger(
      merged.max_rounds,
      DEFAULT_MAX_ROUNDS,
      1,
      500
    ),
    max_duration_ms: clampInteger(
      merged.max_duration_ms,
      DEFAULT_MAX_DURATION_MS,
      60_000,
      7 * 24 * 60 * 60 * 1000
    ),
    stop_on: normalizeStringArray(merged.stop_on, [
      "all_pass_criteria_satisfied",
      "mandatory_confirmation_required",
      "hard_safety_block",
      "max_rounds_reached",
      "max_duration_reached"
    ]),
    metadata: merged.metadata && typeof merged.metadata === "object"
      ? { ...merged.metadata }
      : {}
  };
}

function validateAutonomousTask(task) {
  if (!task || typeof task !== "object") {
    throw new Error("DAVID autonomous task must be an object.");
  }
  if (task.protocol !== AUTONOMOUS_TASK_PROTOCOL) {
    throw new Error(`Unsupported autonomous task protocol: ${task.protocol || "missing"}`);
  }
  if (!TASK_STATES.includes(task.state)) {
    throw new Error(`Invalid autonomous task state: ${task.state}`);
  }
  if (!normalizeText(task.goal)) {
    throw new Error("Autonomous task goal is empty.");
  }
  if (!Array.isArray(task.pass_criteria) || task.pass_criteria.length === 0) {
    throw new Error("Autonomous task requires at least one PASS criterion.");
  }
  if (!Array.isArray(task.allowed_actions)) {
    throw new Error("Autonomous task allowed_actions must be an array.");
  }
  if (!Array.isArray(task.mandatory_confirmation_categories)) {
    throw new Error("Autonomous task mandatory_confirmation_categories must be an array.");
  }
  for (const category of MANDATORY_CONFIRMATION_CATEGORIES) {
    if (!task.mandatory_confirmation_categories.includes(category)) {
      throw new Error(`Mandatory confirmation category cannot be removed: ${category}`);
    }
  }
  if (!Number.isInteger(task.max_rounds) || task.max_rounds < 1) {
    throw new Error("Autonomous task max_rounds must be a positive integer.");
  }
  if (!Number.isInteger(task.max_duration_ms) || task.max_duration_ms < 60_000) {
    throw new Error("Autonomous task max_duration_ms must be at least 60000.");
  }
  return true;
}

function transitionTask(task, nextState, evidence = null) {
  validateAutonomousTask(task);
  if (!TASK_STATES.includes(nextState)) {
    throw new Error(`Invalid autonomous task transition target: ${nextState}`);
  }
  return {
    ...task,
    state: nextState,
    last_transition_at: new Date().toISOString(),
    last_evidence: evidence == null ? null : evidence
  };
}

function requiresHumanConfirmation(category) {
  return MANDATORY_CONFIRMATION_CATEGORIES.includes(normalizeText(category));
}

module.exports = {
  AUTONOMOUS_TASK_PROTOCOL,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_PASS_CRITERIA,
  MANDATORY_CONFIRMATION_CATEGORIES,
  TASK_STATES,
  createAutonomousTask,
  normalizeText,
  requiresHumanConfirmation,
  stripSfAdminPrefix,
  transitionTask,
  validateAutonomousTask
};
