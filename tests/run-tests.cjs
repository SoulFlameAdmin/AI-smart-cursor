"use strict";

const assert = require("assert");
const {
  buildYouTubeSkill,
  extractYouTubeQuery
} = require("../core/demo-teacher.cjs");
const {
  createTeacherUpgradeLoopSkill,
  createSoulRelayStartSkill,
  createSoulRelayStopSkill,
  createSoulRelayStatusSkill
} = require("../core/builtin-skills.cjs");
const {
  matchSkill,
  renderTemplate
} = require("../core/skill-matcher.cjs");
const { validateSkill } = require("../core/skill-schema.cjs");
const {
  PROTOCOL,
  classifyPowerShellRisk,
  parseTeacherResponse
} = require("../core/teacher-loop.cjs");
const {
  buildSoulPrompt,
  normalizeClaimedMessage,
  validateSoulChatUrl
} = require("../core/soul-relay.cjs");

const command = "otvori yt i pusni 2pac";
const skill = buildYouTubeSkill();

assert.strictEqual(extractYouTubeQuery(command), "2pac");
assert.doesNotThrow(() => validateSkill(skill));

const matched = matchSkill(command, [skill]);
assert.ok(matched, "Skill should match the YouTube command.");
assert.strictEqual(matched.variables.query, "2pac");

const rendered = renderTemplate(skill.steps, matched.variables);
assert.strictEqual(
  rendered[0].url,
  "https://www.youtube.com/results?search_query=2pac"
);

const teacherSkill = createTeacherUpgradeLoopSkill();
assert.doesNotThrow(() => validateSkill(teacherSkill));

const teacherMatch = matchSkill("мисли провери тестовете", [teacherSkill]);
assert.ok(teacherMatch, "Teacher Loop skill should match 'мисли'.");
assert.strictEqual(teacherMatch.variables.goal, "провери тестовете");
assert.ok(matchSkill("Мисли.", [teacherSkill]));

const teacherRendered = renderTemplate(
  teacherSkill.steps,
  teacherMatch.variables
);
assert.strictEqual(teacherRendered[0].action, "teacher_loop");
assert.strictEqual(teacherRendered[0].goal, "провери тестовете");

const soulStartSkill = createSoulRelayStartSkill();
const soulStopSkill = createSoulRelayStopSkill();
const soulStatusSkill = createSoulRelayStatusSkill();

assert.doesNotThrow(() => validateSkill(soulStartSkill));
assert.doesNotThrow(() => validateSkill(soulStopSkill));
assert.doesNotThrow(() => validateSkill(soulStatusSkill));
assert.strictEqual(
  matchSkill("twins", [soulStartSkill]).skill.steps[0].action,
  "soul_relay_start"
);
assert.ok(matchSkill("близнаци", [soulStartSkill]));
assert.ok(matchSkill("спри soul", [soulStopSkill]));
assert.ok(matchSkill("soul status", [soulStatusSkill]));

assert.strictEqual(
  validateSoulChatUrl("https://chatgpt.com/c/test-session"),
  "https://chatgpt.com/c/test-session"
);
assert.throws(
  () => validateSoulChatUrl("https://chatgpt.com/share/test-session"),
  /реалen|реален|ChatGPT/u
);

const claimedSoulMessage = normalizeClaimedMessage({
  message: {
    id: "message-1",
    user_id: "user-1",
    conversation_id: "conversation-1",
    text: "Как си?"
  }
});
assert.strictEqual(claimedSoulMessage.id, "message-1");
assert.strictEqual(claimedSoulMessage.userId, "user-1");
assert.strictEqual(claimedSoulMessage.text, "Как си?");

const soulPrompt = buildSoulPrompt({
  contextText: "USER: Здравей\nSOUL: Здравей!",
  messages: [],
  text: "Как си?"
});
assert.match(soulPrompt, /USER: Здравей/);
assert.match(soulPrompt, /Как си\?/);

const protocolResponse = parseTeacherResponse(JSON.stringify({
  protocol: PROTOCOL,
  job_id: "job-1",
  round: 1,
  status: "action",
  summary: "Run diagnostics",
  actions: [
    {
      action: "run_powershell_upgrade",
      action_id: "test-1",
      requires_confirmation: false,
      timeout_ms: 60000,
      expected_tests: ["npm test"],
      script: "$ErrorActionPreference = 'Stop'\nnpm test"
    }
  ]
}));

assert.strictEqual(protocolResponse.status, "action");
assert.strictEqual(protocolResponse.actions.length, 1);
assert.match(protocolResponse.actions[0].script, /npm test/);

const fencedResponse = parseTeacherResponse(
  "```powershell\nWrite-Output 'PASS'\n```"
);
assert.strictEqual(fencedResponse.status, "action");
assert.match(fencedResponse.actions[0].script, /Write-Output/);

const safeRisk = classifyPowerShellRisk(
  "git status\nnpm test",
  "E:\\david-cursor-v1"
);
assert.strictEqual(safeRisk.blocked, false);
assert.strictEqual(safeRisk.level, "low");

const mediumRisk = classifyPowerShellRisk(
  "Set-Content -Path .\\diagnostic.txt -Value 'ok'",
  "E:\\david-cursor-v1"
);
assert.strictEqual(mediumRisk.blocked, false);
assert.strictEqual(mediumRisk.level, "medium");

const blockedRisk = classifyPowerShellRisk(
  "Format-Volume -DriveLetter C",
  "E:\\david-cursor-v1"
);
assert.strictEqual(blockedRisk.blocked, true);
assert.strictEqual(blockedRisk.level, "blocked");

console.log("DAVID tests: PASS");
