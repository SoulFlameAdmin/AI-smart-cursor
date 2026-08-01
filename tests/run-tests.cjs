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

console.log("DAVID tests: PASS");
