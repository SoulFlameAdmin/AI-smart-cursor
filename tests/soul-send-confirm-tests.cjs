"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  installReliableSoulSendConfirmation,
  normalizePromptText,
  promptContainsExpected
} = require("../core/edge-soul-send-confirm-patch.cjs");

assert.strictEqual(typeof installReliableSoulSendConfirmation, "function");
assert.strictEqual(normalizePromptText("  A\r\n\r\n\r\nB  "), "A\n\nB");
assert.strictEqual(promptContainsExpected("prefix TEST 0.1.2", "TEST 0.1.2"), true);
assert.strictEqual(promptContainsExpected("different text", "TEST 0.1.2"), false);
assert.strictEqual(promptContainsExpected("", ""), true);

const source = fs.readFileSync(
  path.join(__dirname, "..", "core", "edge-soul-send-confirm-patch.cjs"),
  "utf8"
);

assert.match(source, /const isVisible = \(element\)/u);
assert.match(source, /promptVisible/u);
assert.match(source, /promptContainsExpected/u);
assert.match(source, /visible_prompt_only: true/u);
assert.match(source, /Input\.insertText/u);
assert.match(source, /document\.execCommand\('insertText'/u);
assert.match(source, /Input\.dispatchKeyEvent/u);
assert.match(source, /Date\.now\(\) - started < 20000/u);
assert.match(source, /duplicate_submit_retry: false/u);
assert.doesNotMatch(source, /duplicate_submit_retry: true/u);

console.log("DAVID SOUL visible-prompt and single-submit tests: PASS");
