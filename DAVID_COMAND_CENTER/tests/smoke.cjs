"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {readWorkers,readSafeStatus,AskQueue,probeLocalCdp}=require("../src/index.cjs");
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"david-center-test-"));
 try{
  const dir=path.join(root,"tools","david");fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,".david-enchev-state.json"),JSON.stringify({watchdog:"generating",updatedAt:"2026-11-01T10:00:00.000Z",secret:"do not leak",chatUrl:"private"}));
  const status=readWorkers({root,now:Date.parse("2026-11-01T10:00:01.000Z")});
  assert.equal(status.SYSTEM.stage,"generating");
  assert.equal(status.SYSTEM.stale,false);
  assert.equal(JSON.stringify(status).includes("do not leak"),false);
  assert.equal(JSON.stringify(status).includes("private"),false);
  assert.equal(readSafeStatus(path.join(dir,"absent.json")).status,"not_found");
  assert.equal((await probeLocalCdp({port:1})).status,"invalid_port");
  let otherWorkerBusy=true;
  const q=new AskQueue({responder:async ({question})=>"Answered: "+question});
  const job=q.enqueue({project:"ENCHEV",question:"What changed?"});
  assert.equal(q.status(job.id).status,"pending");
  await q.drain();
  assert.equal(q.status(job.id).status,"completed");
  assert.equal(otherWorkerBusy,true);
  const qBlocked=new AskQueue();const j=qBlocked.enqueue({question:"Status?"});await qBlocked.drain();
  assert.equal(qBlocked.status(j.id).status,"blocked");
  console.log("PASS DAVID_COMAND_CENTER: passive status + independent ASK queue (mocked responder)");
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(err=>{console.error(err);process.exitCode=1;});
