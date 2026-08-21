"use strict";
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const need = [
  "core/teacher-loop.cjs","core/knowledge-gap-engine.cjs","core/builtin-skills.cjs",
  "core/edge-cdp-soul-browser.cjs","core/david-thinker-worker.cjs","edge-soul-main.cjs"
];
for (const rel of need) {
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`Missing ${rel}`);
}
const teacher=fs.readFileSync(path.join(root,"core/teacher-loop.cjs"),"utf8");
const browser=fs.readFileSync(path.join(root,"core/edge-cdp-soul-browser.cjs"),"utf8");
if(!teacher.includes("DAVID_KNOWLEDGE_GAP_LIVE_V20_1")) throw new Error("V20.1 marker missing");
if(!teacher.includes("syncDavidMemoryContextV172")) throw new Error("V17.2 memory integration missing");
if(!browser.includes("DAVID_SEND_RELIABILITY_V19")) throw new Error("Send V19 marker missing");
console.log("DAVID STAGE10 RECOVERY CONTRACT PASS");
