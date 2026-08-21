"use strict";
const assert = require("assert");
const path = require("path");
const { analyzeKnowledgeGap } = require(path.join(__dirname, "..", "core", "knowledge-gap-engine.cjs"));

function log(name, result) {
  console.log(`${name}: ${result.classification} | ${result.status}`);
}

const known = analyzeKnowledgeGap({
  task: "pishi do GPT test",
  skills: [{
    skill_key: "builtin_chatgpt_teacher_send",
    title: "GPT Teacher",
    version: 1,
    status: "approved",
    source: "builtin",
    risk_level: "low",
    matcher: {
      type: "regex",
      pattern: "^(?:пиши|pishi)(?:\\s+(?:на|в|до|do))?\\s+(?:gpt|chatgpt)\\s+(.+)$",
      flags: "iu",
      variables: ["message"]
    },
    steps: []
  }],
  memories: []
});
assert.strictEqual(known.classification, "KNOWN");
assert.strictEqual(known.needs_learning, false);
assert.strictEqual(known.evidence.approved_skill_matches.length, 1);
log("KNOWN_CONTROL", known);

const unknown = analyzeKnowledgeGap({
  task: "Create procedural Blender turbine model and export GLB",
  skills: [],
  memories: []
});
assert.strictEqual(unknown.classification, "UNKNOWN");
assert.strictEqual(unknown.status, "KNOWLEDGE_GAP_DETECTED");
assert.strictEqual(unknown.needs_learning, true);
assert.strictEqual(unknown.evidence.approved_skill_matches.length, 0);
assert.strictEqual(unknown.evidence.approved_memory_matches.length, 0);
log("UNKNOWN_CONTROL", unknown);

const uncertain = analyzeKnowledgeGap({
  task: "Blender turbine model export GLB",
  skills: [],
  memories: [{
    id: 42,
    status: "active",
    is_user_confirmed: true,
    deleted_at: null,
    is_sensitive: false,
    memory_type: "fact",
    title: "Blender GLB workflow",
    content: "Blender model workflow can export turbine mesh as GLB."
  }]
});
assert.strictEqual(uncertain.classification, "UNCERTAIN");
assert.strictEqual(uncertain.status, "KNOWLEDGE_PARTIAL");
assert.strictEqual(uncertain.needs_learning, true);
assert.ok(uncertain.evidence.approved_memory_matches.length >= 1);
log("UNCERTAIN_CONTROL", uncertain);

const sensitive = analyzeKnowledgeGap({
  task: "Blender turbine model export GLB",
  skills: [],
  memories: [{
    id: 99,
    status: "active",
    is_user_confirmed: true,
    is_sensitive: true,
    memory_type: "fact",
    content: "Blender turbine model export GLB"
  }]
});
assert.strictEqual(sensitive.classification, "UNKNOWN");
assert.strictEqual(sensitive.evidence.approved_memory_matches.length, 0);
log("SENSITIVE_EXCLUDED", sensitive);

const unconfirmed = analyzeKnowledgeGap({
  task: "Blender turbine model export GLB",
  skills: [],
  memories: [{
    id: 100,
    status: "active",
    is_user_confirmed: false,
    memory_type: "fact",
    content: "Blender turbine model export GLB"
  }]
});
assert.strictEqual(unconfirmed.classification, "UNKNOWN");
assert.strictEqual(unconfirmed.evidence.approved_memory_matches.length, 0);
log("UNCONFIRMED_EXCLUDED", unconfirmed);

console.log("DAVID KNOWLEDGE GAP ENGINE V20 CONTRACT PASS");
