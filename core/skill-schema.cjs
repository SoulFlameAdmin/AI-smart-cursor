"use strict";

const ALLOWED_ACTIONS = new Set([
  "open_url",
  "open_app",
  "wait",
  "browser_open",
  "browser_wait_selector",
  "browser_click_selector",
  "browser_click_text",
  "browser_type_selector",
  "browser_press_key",
  "verify_url_contains",
  "teacher_loop",
  "soul_relay_start",
  "soul_relay_stop",
  "soul_relay_status",
  "system_click",
  "system_type",
  "notify"
]);

function assertString(value, label, maxLength = 1000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} трябва да е текст.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} е прекалено дълго.`);
  }
}

function validateSkill(skill) {
  if (!skill || typeof skill !== "object") {
    throw new Error("Невалиден skill.");
  }

  assertString(skill.skill_key, "skill_key", 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(skill.skill_key)) {
    throw new Error("skill_key съдържа неразрешени символи.");
  }

  assertString(skill.title, "title", 160);

  if (!["low", "medium", "high"].includes(skill.risk_level)) {
    throw new Error("Невалидно risk_level.");
  }

  const matcher = skill.matcher;
  if (!matcher || matcher.type !== "regex") {
    throw new Error("DAVID v1 поддържа matcher.type=regex.");
  }

  assertString(matcher.pattern, "matcher.pattern", 500);

  const flags = matcher.flags || "iu";
  if (!/^[dgimsuvy]*$/.test(flags)) {
    throw new Error("Невалидни RegExp flags.");
  }

  try {
    new RegExp(matcher.pattern, flags);
  } catch {
    throw new Error("Невалиден matcher regex.");
  }

  if (!Array.isArray(matcher.variables)) {
    throw new Error("matcher.variables трябва да е масив.");
  }

  if (!Array.isArray(skill.steps) || skill.steps.length === 0) {
    throw new Error("Skill-ът няма стъпки.");
  }

  if (skill.steps.length > 30) {
    throw new Error("Skill-ът има прекалено много стъпки.");
  }

  for (const [index, step] of skill.steps.entries()) {
    if (!step || typeof step !== "object") {
      throw new Error(`Стъпка ${index + 1} е невалидна.`);
    }

    if (!ALLOWED_ACTIONS.has(step.action)) {
      throw new Error(`Неразрешено действие: ${step.action}`);
    }
  }

  return skill;
}

module.exports = { ALLOWED_ACTIONS, validateSkill };
