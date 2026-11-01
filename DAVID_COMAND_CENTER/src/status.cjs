"use strict";
// Passive DAVID status adapter. Never starts, stops, or writes to a worker.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ROLES = Object.freeze({
  SYSTEM: ".david-enchev-state.json",
  DESIGN: ".david-enchev-design-state.json",
  APP2: ".david-app2-state-6aac2dbb.json",
  APK: ".david-apk-state.json",
  CONTROL: ".david-control-state.json",
  FREE_A: ".david-free-talk-a-state.json",
  FREE_B: ".david-free-talk-b-state.json",
  SCIENTIST: ".sf-scientist-state.json"
});
const MAX_STATE_BYTES = 512 * 1024;
function rootFromEnv(env = process.env) {
  return path.resolve(env.DAVID_ENCHEV_ROOT || (process.platform === "win32" ? "D:\\ASI\\enchev-auctions" : path.join(process.cwd(), "enchev-auctions")));
}
function readSafeStatus(file, now = Date.now()) {
  try {
    const info = fs.statSync(file);
    if (!info.isFile() || info.size > MAX_STATE_BYTES) return {status:"unreadable"};
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {status:"unreadable"};
    const timestamp = [obj.updatedAt,obj.updated_at,obj.lastHeartbeatAt,obj.timestamp].find(v=>typeof v === "string");
    const parsed = timestamp ? Date.parse(timestamp) : NaN;
    const ageMs = Number.isFinite(parsed) ? Math.max(0, now-parsed) : null;
    // Whitelist only diagnostics; NEVER return prompts, URLs, tokens or project data.
    const stage = [obj.watchdog,obj.status,obj.phase].find(v=>typeof v === "string" && v.length <= 64) || "unknown";
    return {status:"snapshot",stage,updatedAt:Number.isFinite(parsed)?new Date(parsed).toISOString():null,
      stale:ageMs === null ? null : ageMs > 90000};
  } catch(e) {
    return {status:e && e.code === "ENOENT" ? "not_found" : "unreadable"};
  }
}
function readWorkers({root=rootFromEnv(),now=Date.now()}={}) {
  const directory=path.join(root,"tools","david");
  return Object.fromEntries(Object.entries(ROLES).map(([name,file])=>[
    name,readSafeStatus(path.join(directory,file),now)
  ]));
}
function probeLocalCdp({port,timeoutMs=1200}={}) {
  if (!Number.isInteger(port) || port<1024 || port>65535) return Promise.resolve({status:"invalid_port"});
  return new Promise(resolve=>{
    let settled=false;
    const done=value=>{if(!settled){settled=true;resolve(value);}};
    const req=http.get({hostname:"127.0.0.1",port,path:"/json/version",timeout:timeoutMs,agent:false},res=>{
      let body="";
      res.on("data",chunk=>{if(body.length<4096)body+=chunk.toString();});
      res.on("end",()=>{
        if(res.statusCode!==200)return done({status:"unavailable"});
        try{let d=JSON.parse(body);done({status:typeof d.Browser==="string" ? "listening":"unknown"});}
        catch{done({status:"unknown"});}
      });
    });
    req.on("timeout",()=>req.destroy());
    req.on("error",()=>done({status:"unavailable"}));
  });
}
async function getStatus({root=rootFromEnv(),now=Date.now()}={}) {
  const [matrix,scientist]=await Promise.all([probeLocalCdp({port:9444}),probeLocalCdp({port:9555})]);
  return {mode:"read_only",source:"local_snapshot_not_verified_live_work",rootExists:fs.existsSync(root),
    workers:readWorkers({root,now}),cdps:{matrix9444:matrix,scientist9555:scientist},
    caution:"CDP port listening does not prove workers are generating or that a task is complete"};
}
module.exports={ROLES,rootFromEnv,readSafeStatus,readWorkers,probeLocalCdp,getStatus};
