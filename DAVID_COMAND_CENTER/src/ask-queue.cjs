"use strict";
// ASK lane is independent from any Enchev worker or browser tab.
const { randomUUID } = require("node:crypto");
class AskQueue {
  constructor({responder,maxPending=20,timeoutMs=45000}={}){
    this.responder=typeof responder === "function" ? responder : null;
    this.maxPending=maxPending;
    this.timeoutMs=timeoutMs;
    this.pending=[];
    this.results=new Map();
    this.processing=false;
  }
  enqueue({project="GENERAL",question}={}) {
    if(typeof question!=="string" || !question.trim() || question.length>2000) throw new Error("Question must be 1–2000 characters");
    if(!/^[A-Za-z0-9_-]{2,40}$/.test(project)) throw new Error("Invalid project code");
    if(this.pending.length >= this.maxPending) throw new Error("ASK queue full");
    const id=randomUUID(),job={id,project,question:question.trim(),status:"pending",createdAt:new Date().toISOString()};
    this.pending.push(job);
    this.results.set(id,{id,project,status:"pending",createdAt:job.createdAt});
    return {id,status:"pending"};
  }
  status(id){return this.results.get(id)||{id,status:"not_found"};}
  async drain() {
    if(this.processing) return;
    this.processing=true;
    try{
      while(this.pending.length){
        const job=this.pending.shift();
        if(!this.responder){this.results.set(job.id,{id:job.id,project:job.project,status:"blocked",reason:"No approved independent ASK responder is configured"});continue;}
        this.results.set(job.id,{id:job.id,project:job.project,status:"running"});
        const abort=new AbortController();
        const timer=setTimeout(()=>abort.abort(),this.timeoutMs);
        try{
          const answer=await this.responder({project:job.project,question:job.question,signal:abort.signal});
          if(abort.signal.aborted) throw new Error("ASK timed out");
          if(typeof answer!=="string" || !answer.trim()) throw new Error("ASK returned no answer");
          this.results.set(job.id,{id:job.id,project:job.project,status:"completed",answer:answer.slice(0,8000)});
        }catch(e){this.results.set(job.id,{id:job.id,project:job.project,status:"failed",reason:String(e.message||e).slice(0,200)});}
        finally{clearTimeout(timer);}
      }
    } finally{this.processing=false;}
  }
}
module.exports={AskQueue};
