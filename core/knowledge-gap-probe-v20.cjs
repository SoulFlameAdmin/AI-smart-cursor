"use strict";
const path = require("path");
const root = process.argv[2] || path.resolve(__dirname, "..");
const task = process.argv.slice(3).join(" ").trim();
if (!task) {
  console.error('Usage: node core\\knowledge-gap-probe-v20.cjs "<task>"');
  process.exit(2);
}
const { analyzeKnowledgeGap } = require(path.join(root, "core", "knowledge-gap-engine.cjs"));
let skills = [];
try {
  const builtins = require(path.join(root, "core", "builtin-skills.cjs"));
  if (typeof builtins.getBuiltInSkills === "function") skills = builtins.getBuiltInSkills();
} catch {}
const result = analyzeKnowledgeGap({ task, skills, memories: [] });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");

