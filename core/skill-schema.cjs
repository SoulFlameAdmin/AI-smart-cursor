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

function assertOptionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${label} трябва да е true/false.`);
  }
}

function assertHttpUrlTemplate(value, label) {
  assertString(value, label, 2048);
  if (!/^https?:\/\//i.test(value.trim())) {
    throw new Error(`${label} трябва да започва с http:// или https://.`);
  }
}

function assertFiniteNumber(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} е извън разрешения диапазон.`);
  }
}

function validateStep(step, index) {
  const label = `Стъпка ${index + 1}`;

  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new Error(`${label} е невалидна.`);
  }

  if (!ALLOWED_ACTIONS.has(step.action)) {
    throw new Error(`Неразрешено действие: ${step.action}`);
  }

  assertOptionalBoolean(step.allow_fail, `${label}.allow_fail`);

  switch (step.action) {
    case "open_url":
    case "browser_open":
      assertHttpUrlTemplate(step.url, `${label}.url`);
      break;

    case "open_app":
      assertString(step.app, `${label}.app`, 160);
      if (/[\r\n;&|<>]/.test(step.app)) {
        throw new Error(`${label}.app съдържа неразрешени символи.`);
      }
      break;

    case "wait":
      assertFiniteNumber(
        step.milliseconds === undefined ? 500 : step.milliseconds,
        `${label}.milliseconds`,
        0,
        30000
      );
      break;

    case "browser_wait_selector":
      assertString(step.selector, `${label}.selector`, 1200);
      assertFiniteNumber(
        step.timeout_ms === undefined ? 15000 : step.timeout_ms,
        `${label}.timeout_ms`,
        250,
        60000
      );
      break;

    case "browser_click_selector":
      assertString(step.selector, `${label}.selector`, 1200);
      break;

    case "browser_click_text":
      assertString(step.text, `${label}.text`, 300);
      break;

    case "browser_type_selector":
      assertString(step.selector, `${label}.selector`, 1200);
      assertString(step.text, `${label}.text`, 10000);
      break;

    case "browser_press_key":
      assertString(step.key, `${label}.key`, 60);
      break;

    case "verify_url_contains":
      assertString(step.value, `${label}.value`, 500);
      break;

    case "system_click":
      assertFiniteNumber(step.x, `${label}.x`, -50000, 50000);
      assertFiniteNumber(step.y, `${label}.y`, -50000, 50000);
      break;

    case "system_type":
      assertString(step.text, `${label}.text`, 10000);
      break;

    case "notify":
      if (step.title !== undefined) {
        assertString(step.title, `${label}.title`, 160);
      }
      assertString(step.text, `${label}.text`, 1000);
      break;

    default:
      throw new Error(`Неподдържано действие: ${step.action}`);
  }
}

function validateSkill(skill) {
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
    throw new Error("Невалиден skill.");
  }

  assertString(skill.skill_key, "skill_key", 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(skill.skill_key)) {
    throw new Error("skill_key съдържа неразрешени символи.");
  }

  assertString(skill.title, "title", 160);

  if (skill.description !== undefined) {
    assertString(skill.description, "description", 1000);
  }

  if (!["low", "medium", "high"].includes(skill.risk_level)) {
    throw new Error("Невалидно risk_level.");
  }

  if (!Number.isInteger(Number(skill.version)) || Number(skill.version) < 1) {
    throw new Error("version трябва да е цяло положително число.");
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

  for (const [index, variable] of matcher.variables.entries()) {
    assertString(variable, `matcher.variables[${index}]`, 80);
  }

  if (!Array.isArray(skill.steps) || skill.steps.length === 0) {
    throw new Error("Skill-ът няма стъпки.");
  }

  if (skill.steps.length > 30) {
    throw new Error("Skill-ът има прекалено много стъпки.");
  }

  skill.steps.forEach(validateStep);

  return skill;
}

module.exports = {
  ALLOWED_ACTIONS,
  validateSkill,
  validateStep
};
