"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  getBuiltInSkills,
  DAVID_TEACHER_CHAT_URL
} = require("../core/builtin-skills.cjs");

const {
  matchSkill,
  renderTemplate
} = require("../core/skill-matcher.cjs");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(
  path.join(root, "main.cjs"),
  "utf8"
);

const skills = getBuiltInSkills();
const skill = skills.find(
  (item) => item.skill_key === "builtin_chatgpt_teacher_send"
);

assert.ok(skill, "Built-in GPT skill is missing.");

const matched = matchSkill(
  "pishi na GPT zdr2",
  skills
);

assert.ok(matched, "GPT skill did not match the test command.");
assert.strictEqual(matched.variables.message, "zdr2");

const steps = renderTemplate(
  skill.steps,
  matched.variables
);

assert.ok(
  steps.some(
    (step) =>
      step.action === "browser_open" &&
      step.url === DAVID_TEACHER_CHAT_URL
  ),
  "Teacher conversation URL is missing."
);

assert.ok(
  steps.some(
    (step) =>
      step.action === "browser_type_selector" &&
      step.text === "zdr2"
  ),
  "GPT message typing step is missing."
);

assert.ok(
  steps.some(
    (step) =>
      step.action === "wait" &&
      step.milliseconds === 5000
  ),
  "The five second wait is missing."
);

assert.ok(
  steps.some(
    (step) =>
      step.action === "browser_click_selector" &&
      String(step.selector).includes("send-button")
  ),
  "Enabled Send button click is missing."
);

const duplicateCount = (
  mainSource.match(
    /function\s+requestChatGptMessage\s*\(/g
  ) || []
).length;

console.log(
  JSON.stringify({
    status: "PASS",
    teacherUrl: DAVID_TEACHER_CHAT_URL,
    duplicateRequestFunctionCount: duplicateCount
  })
);

console.log("DAVID baseline tests: PASS");
