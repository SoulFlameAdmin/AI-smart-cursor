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

const {
  DAVID_TEACHER_SYNC_PROTOCOL,
  parseTeacherPacket
} = require("../core/teacher-sync-protocol.cjs");

const {
  DAVID_UPGRADE_PROTOCOL,
  parseUpgradePacket,
  inspectPowerShellScript
} = require("../core/upgrade-protocol.cjs");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(
  path.join(root, "main.cjs"),
  "utf8"
);
const browserAgentSource = fs.readFileSync(
  path.join(root, "core", "browser-agent.cjs"),
  "utf8"
);
const actionExecutorSource = fs.readFileSync(
  path.join(root, "core", "action-executor.cjs"),
  "utf8"
);
const powerShellSessionSource = fs.readFileSync(
  path.join(root, "core", "powershell-session.cjs"),
  "utf8"
);

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
      step.action === "browser_mark_teacher_state"
  ),
  "Teacher response baseline is not marked before sending."
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
  DAVID_UPGRADE_REQUEST_MESSAGE.includes(DAVID_UPGRADE_PROTOCOL),
  "Upgrade request does not activate the Upgrade Loop protocol."
);

assert.ok(
  DAVID_UPGRADE_REQUEST_MESSAGE.includes("не променяй main/master"),
  "Upgrade request does not protect main/master."
);

assert.ok(
  DAVID_UPGRADE_REQUEST_MESSAGE.includes("requires_confirmation"),
  "Upgrade request does not require human confirmation."
);

assert.ok(
  upgradeSteps.some(
    (step) =>
      step.action === "browser_upgrade_loop" &&
      step.max_rounds === 6
  ),
  "Upgrade bridge does not start the controlled Upgrade Loop."
);

const parsedPacket = parseTeacherPacket(`
  \`\`\`json
  {
    "protocol": "david_teacher_sync_v1",
    "status": "action",
    "summary": "Safe test",
    "actions": [
      { "action": "wait", "milliseconds": 500 },
      { "action": "notify", "title": "DAVID", "text": "PASS" }
    ]
  }
  \`\`\`
`);

assert.strictEqual(parsedPacket.status, "action");
assert.strictEqual(parsedPacket.actions.length, 2);
assert.strictEqual(parsedPacket.actions[0].milliseconds, 500);

assert.throws(
  () => parseTeacherPacket(JSON.stringify({
    protocol: DAVID_TEACHER_SYNC_PROTOCOL,
    status: "action",
    summary: "Unsafe",
    actions: [
      { action: "open_app", app: "powershell.exe" }
    ]
  })),
  /не е разрешено/iu,
  "Teacher Sync accepted an unsafe action."
);

const upgradePacket = parseUpgradePacket(JSON.stringify({
  protocol: DAVID_UPGRADE_PROTOCOL,
  job_id: "upgrade-test-001",
  round: 1,
  status: "action",
  summary: "Run safe local checks",
  actions: [
    {
      action: "run_powershell_upgrade",
      action_id: "upgrade-test-001-action-1",
      branch: "candidate/david-upgrade-test-001",
      requires_confirmation: true,
      timeout_ms: 120000,
      expected_tests: [
        "npm test",
        "node tests/baseline-tests.cjs"
      ],
      script: [
        '$ErrorActionPreference = "Stop"',
        'git status --short',
        'node --check .\\main.cjs'
      ].join("\n")
    }
  ]
}));

assert.strictEqual(upgradePacket.status, "action");
assert.strictEqual(upgradePacket.round, 1);
assert.strictEqual(upgradePacket.actions.length, 1);
assert.strictEqual(
  upgradePacket.actions[0].branch,
  "candidate/david-upgrade-test-001"
);
assert.strictEqual(
  upgradePacket.actions[0].script_sha256.length,
  64
);

assert.throws(
  () => inspectPowerShellScript("git reset --hard HEAD"),
  /блокиран/iu,
  "Upgrade protocol accepted git reset --hard."
);

assert.throws(
  () => inspectPowerShellScript("gh pr merge 7"),
  /блокиран/iu,
  "Upgrade protocol accepted automatic PR merge."
);

assert.throws(
  () => parseUpgradePacket(JSON.stringify({
    protocol: DAVID_UPGRADE_PROTOCOL,
    job_id: "unsafe-main",
    round: 1,
    status: "action",
    summary: "Unsafe branch",
    actions: [
      {
        action: "run_powershell_upgrade",
        action_id: "unsafe-main-1",
        branch: "feature/main",
        requires_confirmation: true,
        timeout_ms: 120000,
        expected_tests: [],
        script: "git status"
      }
    ]
  })),
  /main\/master/iu,
  "Upgrade protocol accepted a main-like branch."
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

assert.ok(
  browserAgentSource.includes("waitForTeacherResponse"),
  "DAVID Browser cannot wait for a GPT response."
);

assert.ok(
  browserAgentSource.includes("data-message-author-role='assistant'"),
  "DAVID Browser cannot read the last GPT assistant message."
);

assert.ok(
  actionExecutorSource.includes("runTeacherSync"),
  "DAVID ActionExecutor does not implement the Teacher Sync loop."
);

assert.ok(
  actionExecutorSource.includes("runUpgradeLoop"),
  "DAVID ActionExecutor does not implement the Upgrade Loop."
);

assert.ok(
  actionExecutorSource.includes("PowerShellSession"),
  "DAVID ActionExecutor does not use the controlled PowerShell session."
);

assert.ok(
  powerShellSessionSource.includes("backup/david-upgrade-"),
  "PowerShell session does not create a backup branch."
);

assert.ok(
  powerShellSessionSource.includes("git diff --check"),
  "PowerShell session does not run fixed Git validation."
);

assert.ok(
  powerShellSessionSource.includes("redactSecrets"),
  "PowerShell session does not redact secrets from output."
);

console.log(
  JSON.stringify({
    status: "PASS",
    teacherUrl: DAVID_TEACHER_CHAT_URL,
    upgradeBridge: "PASS",
    teacherSync: "PASS",
    upgradeLoop: "PASS",
    duplicateRequestFunctionCount: duplicateCount
  })
);

console.log("DAVID baseline tests: PASS");
