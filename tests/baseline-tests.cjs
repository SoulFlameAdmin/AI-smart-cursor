"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  getBuiltInSkills,
  DAVID_TEACHER_CHAT_URL,
  DAVID_UPGRADE_REQUEST_MESSAGE
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

/* DAVID_BROWSER_WINDOW_TEST_SOURCE_BEGIN */
const browserAgentSource = fs.readFileSync(
  path.join(root, "core", "browser-agent.cjs"),
  "utf8"
);
/* DAVID_BROWSER_WINDOW_TEST_SOURCE_END */

const skills = getBuiltInSkills();

const chatSkill = skills.find(
  (item) => item.skill_key === "builtin_chatgpt_teacher_send"
);

assert.ok(chatSkill, "Built-in GPT skill is missing.");

const chatMatched = matchSkill(
  "pishi na GPT zdr2",
  skills
);

assert.ok(chatMatched, "GPT skill did not match the test command.");
assert.strictEqual(chatMatched.variables.message, "zdr2");

const chatSteps = renderTemplate(
  chatSkill.steps,
  chatMatched.variables
);

assert.ok(
  chatSteps.some(
    (step) =>
      step.action === "browser_open" &&
      step.url === DAVID_TEACHER_CHAT_URL
  ),
  "Teacher conversation URL is missing."
);

assert.ok(
  chatSteps.some(
    (step) =>
      step.action === "browser_type_selector" &&
      step.text === "zdr2"
  ),
  "GPT message typing step is missing."
);

assert.ok(
  chatSteps.some(
    (step) =>
      step.action === "wait" &&
      step.milliseconds === 5000
  ),
  "The five second wait is missing."
);

assert.ok(
  chatSteps.some(
    (step) =>
      step.action === "browser_click_selector" &&
      String(step.selector).includes("send-button")
  ),
  "Enabled Send button click is missing."
);

const upgradeSkill = skills.find(
  (item) => item.skill_key === "builtin_david_upgrade_bridge"
);

assert.ok(
  upgradeSkill,
  "Built-in DAVID upgrade bridge skill is missing."
);

const upgradeMatched = matchSkill(
  "upgreidni me - david: opravи overlay",
  skills
);

assert.ok(
  upgradeMatched,
  "DAVID upgrade bridge did not match the test command."
);

assert.strictEqual(
  upgradeMatched.skill.skill_key,
  "builtin_david_upgrade_bridge"
);

assert.strictEqual(
  upgradeMatched.variables.details,
  "opravи overlay"
);

const upgradeSteps = renderTemplate(
  upgradeSkill.steps,
  upgradeMatched.variables
);

assert.ok(
  upgradeSteps.some(
    (step) =>
      step.action === "browser_open" &&
      step.url === DAVID_TEACHER_CHAT_URL
  ),
  "Upgrade bridge does not open the DAVID Teacher conversation."
);

const upgradeMessageStep = upgradeSteps.find(
  (step) => step.action === "browser_type_selector"
);

assert.ok(
  upgradeMessageStep,
  "Upgrade bridge typing step is missing."
);

assert.ok(
  upgradeMessageStep.text.includes(
    "SoulFlameAdmin/AI-smart-cursor"
  ),
  "Upgrade request does not identify the GitHub repository."
);

assert.ok(
  upgradeMessageStep.text.includes(
    "david-cursor-v0.1.0-baseline"
  ),
  "Upgrade request does not identify the stable baseline tag."
);

assert.ok(
  upgradeMessageStep.text.includes("opravи overlay"),
  "Upgrade request does not include DAVID's additional task."
);

assert.ok(
  DAVID_UPGRADE_REQUEST_MESSAGE.includes("Supabase"),
  "Upgrade request does not mention Supabase memory."
);

const duplicateCount = (
  mainSource.match(
    /function\s+requestChatGptMessage\s*\(/g
  ) || []
).length;

assert.strictEqual(
  duplicateCount,
  1,
  "requestChatGptMessage must have exactly one definition."
);

/* DAVID_BROWSER_WINDOW_TESTS_BEGIN */
assert.ok(
  mainSource.includes('window.getTitle() || "") === "DAVID Browser"'),
  "DAVID Browser must be excluded from the overlay fullscreen patch."
);

assert.ok(
  browserAgentSource.includes("minimizable: true"),
  "DAVID Browser must be minimizable."
);

assert.ok(
  browserAgentSource.includes("maximizable: true"),
  "DAVID Browser must be maximizable."
);

assert.ok(
  browserAgentSource.includes("window.maximize()"),
  "DAVID Browser must open maximized."
);

assert.ok(
  browserAgentSource.includes("window.isMinimized()"),
  "DAVID Browser must restore after minimization."
);
/* DAVID_BROWSER_WINDOW_TESTS_END */

console.log(
  JSON.stringify({
    status: "PASS",
    teacherUrl: DAVID_TEACHER_CHAT_URL,
    upgradeBridge: "PASS",
    duplicateRequestFunctionCount: duplicateCount
  })
);

console.log("DAVID baseline tests: PASS");
