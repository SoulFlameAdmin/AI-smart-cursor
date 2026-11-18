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


const {
  getBuiltInSkills,
  createVercelOpenSkill,
  VERCEL_HOME_URL
} = require("../core/builtin-skills.cjs");
const { BrowserAgent } = require("../core/browser-agent.cjs");

const vercel = createVercelOpenSkill();
assert.doesNotThrow(() => validateSkill(vercel));
assert.strictEqual(VERCEL_HOME_URL, "https://vercel.com/");
assert.ok(getBuiltInSkills().some((x) => x.skill_key === vercel.skill_key));

for (const phrase of ["отвори Vercel", "otvori vercel.com", "open vercel", "отвори верцел"]) {
  const found = matchSkill(phrase, getBuiltInSkills());
  assert.strictEqual(found?.skill.skill_key, "builtin_open_vercel", phrase);
}
for (const phrase of ["отвори vercel.com.evil.test", "open vercel and deploy", "отвори https://evil.test"]) {
  assert.strictEqual(matchSkill(phrase, [vercel]), null, phrase);
}
assert.deepStrictEqual(renderTemplate(vercel.steps, {}), [
  { action: "browser_open", url: "https://vercel.com/" },
  { action: "verify_url_exact", value: "https://vercel.com/" }
]);

let current = "https://vercel.com/";
const browser = new BrowserAgent({ BrowserWindow: function FakeWindow() {}, sendStatus() {} });
browser.window = { isDestroyed: () => false, webContents: { getURL: () => current } };
assert.strictEqual(browser.verifyUrlExact(VERCEL_HOME_URL), true);
for (const badUrl of [
  "https://vercel.com.evil.test/",
  "https://evil.test/?next=https://vercel.com/",
  "http://vercel.com/",
  "https://vercel.com/login"
]) {
  current = badUrl;
  assert.throws(() => browser.verifyUrlExact(VERCEL_HOME_URL), /Проверката/);
}

console.log("DAVID tests: PASS");
