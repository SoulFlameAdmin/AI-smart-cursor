"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const keeperFile = path.join(root, "core", "david-thinker-node-keeper.cjs");
const source = fs.readFileSync(keeperFile, "utf8");

assert.match(source, /DAVID_THINKER_KEEPER_SINGLETON_V1/u);
assert.match(source, /fs\.openSync\(singletonFile,\s*"wx"\)/u);
assert.match(source, /process\.kill\(numeric,\s*0\)/u);
assert.match(source, /duplicate exits/u);
assert.match(source, /process\.once\("exit",\s*releaseSingleton\)/u);
assert.match(source, /releaseSingleton\(\);\s*\n\s*process\.exit\(0\)/u);

console.log("DAVID THINKER KEEPER SINGLETON V1 CONTRACT PASS");
