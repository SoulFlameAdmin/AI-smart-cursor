"use strict";
const {getStatus}=require("../src/status.cjs");
getStatus().then(result=>process.stdout.write(JSON.stringify(result,null,2)+"\n"),error=>{
  process.stderr.write(String(error.message||error)+"\n");process.exitCode=1;
});
