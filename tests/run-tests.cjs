"use strict";

const assert = require("assert");
const {
  buildYouTubeSkill,
  extractYouTubeQuery
} = require("../core/demo-teacher.cjs");
const {
  matchSkill,
  renderTemplate
} = require("../core/skill-matcher.cjs");
const { validateSkill } = require("../core/skill-schema.cjs");
const {
  extractBalancedJson,
  normalizeTeacherSkill
} = require("../core/electron-chat-teacher.cjs");

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

const teacherPayload = extractBalancedJson(`
Планът е:
\`\`\`json
{
  "skill": {
    "skill_key": "open_notepad_test",
    "title": "Отвори Notepad",
    "description": "Тестов skill",
    "version": 1,
    "risk_level": "low",
    "matcher": {
      "type": "regex",
      "pattern": "^otvori notepad$",
      "flags": "iu",
      "variables": []
    },
    "steps": [
      { "action": "open_app", "app": "notepad.exe" }
    ]
  }
}
\`\`\`
`);

const teacherSkill = normalizeTeacherSkill(teacherPayload);
assert.strictEqual(teacherSkill.source, "electron_chat_teacher");
assert.strictEqual(teacherSkill.status, "candidate");
assert.strictEqual(teacherSkill.steps[0].action, "open_app");

assert.throws(
  () =>
    normalizeTeacherSkill({
      skill_key: "dangerous",
      title: "Dangerous",
      version: 1,
      risk_level: "high",
      matcher: {
        type: "regex",
        pattern: ".*",
        flags: "u",
        variables: []
      },
      steps: [{ action: "run_shell", command: "format c:" }]
    }),
  /Неразрешено действие/
);

console.log("DAVID tests: PASS");
