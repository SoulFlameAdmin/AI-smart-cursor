"use strict";
const assert=require("node:assert/strict");
const {buildManagerReport,githubGet,normalizeProposal,validateConfig,formatReport}=require("../core/david-manager-v1.cjs");
const config={projects:[
  {id:"DAVID_CURSOR",name:"DAVID Cursor",github_repo:"SoulFlameAdmin/AI-smart-cursor"},
  {id:"MM",name:"MM",github_repo:null}
]};
assert.equal(validateConfig(config).length,2);
assert.throws(()=>validateConfig({projects:[config.projects[0],config.projects[0]]}),/duplicate/);
assert.throws(()=>validateConfig({projects:[{id:"MM",name:"MM",github_repo:"localhost:1234"}]}),/repository/);
const github=async(url,opts)=>{
  assert.equal(new URL(url).host,"api.github.com");
  assert.equal(opts.headers.authorization,undefined);
  if(url.endsWith("/repos/SoulFlameAdmin/AI-smart-cursor"))
    return {ok:true,json:async()=>({html_url:"https://github.com/SoulFlameAdmin/AI-smart-cursor",default_branch:"main"})};
  if(url.includes("/commits?"))
    return {ok:true,json:async()=>[{sha:"aaaaaaaaaaaaaaaa",html_url:"https://github.com/SoulFlameAdmin/AI-smart-cursor/commit/aaaa",commit:{message:"baseline",committer:{date:"2026-08-01T11:44:57Z"}}}]};
  if(url.includes("/pulls?"))
    return {ok:true,json:async()=>[{number:20,title:"Orchestration",draft:true,html_url:"https://github.com/SoulFlameAdmin/AI-smart-cursor/pull/20"}]};
  throw Error("Unexpected URL "+url);
};
const gemini=async(_url,opts)=>{
  const input=JSON.parse(opts.body).contents[0].parts[0].text;
  assert.match(input,/untrusted_data/);
  assert.equal(opts.headers["x-goog-api-key"],"TEST_KEY");
  return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({tasks:[
    {project_id:"DAVID_CURSOR",title:"Deploy now",rationale:"Review PR 20",action_type:"deploy",evidence_url:"https://evil.example/claim"},
    {project_id:"MM",title:"Inspect MM",rationale:"No bridge found",action_type:"inspect"},
    {project_id:"NOT_CONFIGURED",title:"Bad",rationale:"Bad",action_type:"inspect"}
  ]})}]}}]})};
};
(async()=>{
  await assert.rejects(()=>githubGet("https://localhost/",{fetchImpl:github}),/Disallowed/);
  const report=await buildManagerReport(config,{
    fetchImpl:(url,opts)=>url.includes("generativelanguage")?gemini(url,opts):github(url,opts),
    now:new Date("2026-11-01T09:00:00Z"),geminiKey:"TEST_KEY"
  });
  assert.equal(report.projects[0].source_status,"connected");
  assert.equal(report.projects[0].open_prs.length,1);
  assert.equal(report.projects[1].source_status,"not_connected");
  assert.equal(report.mm_bridge_connected,false);
  assert.equal(report.proposed_tasks.length,2);
  assert.equal(report.proposed_tasks[0].requires_approval,true);
  assert.equal(report.proposed_tasks[0].execution_status,"proposal_only");
  assert.equal(report.proposed_tasks[0].evidence_url,"https://github.com/SoulFlameAdmin/AI-smart-cursor");
  assert.equal(report.proposed_tasks[1].requires_approval,false);
  const unknown=normalizeProposal({project_id:"DAVID_CURSOR",title:"Unknown action",rationale:"No",action_type:"unsafe_shell"},report.projects);
  assert.equal(unknown.action_type,"edit_code");
  assert.equal(unknown.requires_approval,true);
  assert.match(formatReport(report),/БЕЗ автоматични промени/);
  const rules=await buildManagerReport(config,{fetchImpl:github,now:new Date("2026-11-01T09:00:00Z")});
  assert.equal(rules.planner,"rules_only");
  assert.ok(rules.proposed_tasks.some(p=>p.project_id==="DAVID_CURSOR"));
  assert.ok(rules.proposed_tasks.some(p=>p.project_id==="MM"&&p.requires_approval));
  console.log("DAVID MANAGER V1 CONTRACT PASS");
})().catch(e=>{console.error(e);process.exitCode=1;});
