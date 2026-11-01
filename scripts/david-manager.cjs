"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {buildManagerReport,formatReport,saveReport}=require("../core/david-manager-v1.cjs");
(async()=>{
  const args=process.argv.slice(2);
  if (args.some(a=>!["--json","--save","--no-gemini"].includes(a)))
    throw Error("Usage: node scripts/david-manager.cjs [--json] [--save] [--no-gemini]");
  const root=path.resolve(__dirname,"..");
  const cfg=JSON.parse(fs.readFileSync(path.join(root,"config","manager-projects.json"),"utf8"));
  const report=await buildManagerReport(cfg,{
    token:process.env.GITHUB_TOKEN||"",
    geminiKey:args.includes("--no-gemini")?"":process.env.GEMINI_API_KEY||"",
    model:process.env.DAVID_GEMINI_MODEL||"gemini-3.5-flash-lite"
  });
  if (args.includes("--save")) {
    const dest=saveReport(path.join(root,".david-runtime","manager","latest-report.json"),report);
    console.error("Saved DAVID Manager report to "+dest);
  }
  console.log(args.includes("--json")?JSON.stringify(report,null,2):formatReport(report));
})().catch(e=>{console.error("DAVID Manager: "+e.message);process.exitCode=1;});
