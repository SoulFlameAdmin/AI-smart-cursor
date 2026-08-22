"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { EdgeSoulBrowserAgent } = require("./edge-cdp-soul-browser.cjs");

const rootDir = path.resolve(process.env.DAVID_REPOSITORY_ROOT || path.resolve(__dirname, ".."));
const chatUrl = process.env.DAVID_TEACHER_CHAT_URL ||
  "https://chatgpt.com/c/6a81285a-3e38-83ed-965a-b221453fb742";
const port = Number(process.env.DAVID_TEACHER_EDGE_PORT || 9444);
const profileDir = process.env.DAVID_THINKER_PROFILE_DIR ||
  path.join(rootDir, ".david-instances", "david", "edge-soul-profile");
const statusFile = process.env.DAVID_THINKER_STATUS_FILE ||
  path.join(rootDir, ".david-instances", "david", "thinker-node-status.json");
const singletonFile = process.env.DAVID_THINKER_SINGLETON_FILE ||
  path.join(rootDir, ".david-instances", "david", "thinker-node.singleton.json");

let browser = null;
let stopping = false;
let booting = false;
let singletonOwned = false;

function clean(value, max = 1500) {
  return String(value ?? "").trim().slice(0, max);
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function readSingleton() {
  try {
    if (!fs.existsSync(singletonFile)) return null;
    return JSON.parse(fs.readFileSync(singletonFile, "utf8"));
  } catch {
    return null;
  }
}

function acquireSingleton() {
  // DAVID_THINKER_KEEPER_SINGLETON_V1
  // Only one keeper may supervise the fixed 9444 Thinker profile. A brief
  // port outage must not create additional keeper processes racing over the
  // same ChatGPT tab/profile.
  fs.mkdirSync(path.dirname(singletonFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(singletonFile, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({
          runtime: "david_thinker_node_keeper_v1",
          singleton: "DAVID_THINKER_KEEPER_SINGLETON_V1",
          pid: process.pid,
          port,
          profile_dir: profileDir,
          started_at: new Date().toISOString()
        }, null, 2), "utf8");
      } finally {
        fs.closeSync(fd);
      }
      singletonOwned = true;
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      const owner = readSingleton();
      if (processAlive(owner?.pid)) {
        console.log(
          `[DAVID THINKER NODE][READY] keeper singleton already owned by PID ${owner.pid}; duplicate exits.`
        );
        return false;
      }

      // Stale lock from a dead keeper. Remove only this repository-local
      // singleton file, then retry one atomic create.
      try { fs.unlinkSync(singletonFile); } catch {}
    }
  }

  throw new Error("DAVID Thinker keeper could not acquire singleton ownership.");
}

function releaseSingleton() {
  if (!singletonOwned) return;
  try {
    const owner = readSingleton();
    if (Number(owner?.pid) === process.pid && fs.existsSync(singletonFile)) {
      fs.unlinkSync(singletonFile);
    }
  } catch {}
  singletonOwned = false;
}

function writeStatus(state, message, kind = "working", meta = {}) {
  const payload = {
    runtime: "david_thinker_node_keeper_v1",
    state: clean(state, 80),
    kind: clean(kind, 40),
    message: clean(message, 1000),
    stage: clean(meta?.stage || "", 120),
    port,
    pid: process.pid,
    updated_at: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  const temporary = `${statusFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(temporary, statusFile);
  } catch {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }
  return payload;
}

function sendStatus(message, kind = "working", meta = {}) {
  const text = clean(message, 1000);
  let state = "working";
  const signature = `${meta?.stage || ""} ${text}`.toLowerCase();
  if (kind === "error") state = "error";
  else if (signature.includes("login_required") || signature.includes("log in to chatgpt") || signature.includes("login hold")) {
    state = "login_required";
  } else if (signature.includes("ready") || signature.includes("fixed soul conversation is ready")) {
    state = "ready";
  }
  console.log(`[DAVID THINKER NODE][${String(kind).toUpperCase()}] ${text}`);
  return writeStatus(state, text, kind, meta);
}

async function boot() {
  if (stopping || booting) return;
  booting = true;
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    browser = new EdgeSoulBrowserAgent({
      sendStatus,
      chatUrl,
      rootDir,
      port,
      profileDir,
      sessionKey: "david-thinker-node",
      sessionLabel: "DAVID THINKER NODE"
    });

    writeStatus(
      "starting",
      `DAVID Thinker Node is opening the fixed GPT route on port ${port}.`,
      "working",
      { stage: "thinker_node_start" }
    );

    await browser.openIfNeeded(chatUrl);
    browser.connection?.close?.();
    browser.connection = null;
    browser.targetId = null;

    writeStatus(
      "ready",
      `DAVID Thinker Node is ready on port ${port}.`,
      "ready",
      { stage: "thinker_node_ready" }
    );
    console.log(`[DAVID THINKER NODE][READY] port=${port}`);
  } catch (error) {
    const message = clean(error?.stack || error?.message || error, 4000);
    console.error("[DAVID THINKER NODE][ERROR]", message);
    writeStatus("error", message, "error", { stage: "thinker_node_failed" });
    throw error;
  } finally {
    booting = false;
  }
}

async function healthLoop() {
  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (stopping) break;
    const ready = await browser?.debuggerReady?.().catch(() => false);
    if (ready) continue;

    writeStatus(
      "reconnecting",
      `DAVID Thinker Node lost port ${port}; reopening the same persistent Thinker profile.`,
      "warning",
      { stage: "thinker_node_reconnect" }
    );
    try {
      browser?.connection?.close?.();
      browser = null;
      await boot();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  writeStatus(
    "stopping",
    `DAVID Thinker Node is stopping (${signal}). Persistent Edge profile is kept.`,
    "warning",
    { stage: "thinker_node_stopping" }
  );
  try { browser?.connection?.close?.(); } catch {}
  releaseSingleton();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("exit", releaseSingleton);

if (require.main === module) {
  if (!acquireSingleton()) {
    process.exit(0);
  } else {
    boot()
      .then(() => healthLoop())
      .catch(() => {
        process.exitCode = 1;
      });
  }
}

module.exports = {
  acquireSingleton,
  boot,
  chatUrl,
  port,
  profileDir,
  processAlive,
  releaseSingleton,
  sendStatus,
  singletonFile,
  statusFile,
  writeStatus
};
