"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { LiveSoulRelay } = require("./core/soul-relay-live.cjs");
const { EdgeSoulMultiSessionAgent } = require("./core/edge-cdp-soul-browser.cjs");
const { validateSoulChatUrl } = require("./core/soul-relay-runtime-v3.cjs");
const { installPersistentSoulSession } = require("./core/edge-soul-persistent-session.cjs");
const { installEdgeSoulRecovery } = require("./core/edge-soul-recovery-patch.cjs");
const { installCompletedSoulAnswerDetection } = require("./core/edge-soul-answer-completion-patch.cjs");
const { installDavidSoulTurnFinalizerV4 } = require("./core/edge-soul-turn-finalizer-v4.cjs");
const { installDavidSoulAutoReconnectV11 } = require("./core/david-soul-auto-reconnect-v11.cjs");
const { installDavidSoulAutoReconnect } = require("./core/david-soul-auto-reconnect-v1.cjs");
const { installDavidSoulNetworkShield } = require("./core/david-soul-network-shield-v1.cjs");
const { installDavidSoulWholeTurnReturn } = require("./core/david-soul-whole-turn-return-v1.cjs");
const { installDavidSoulMasterEdge } = require("./core/david-soul-master-edge.cjs");
const { installDavidSoulAnchor2 } = require("./core/david-soul-anchor-2.cjs");
const { installDavidFastBrainIO } = require("./core/david-fast-brain-io-v1.cjs");

const VERSION = "david-soul-node-main-v1";

installPersistentSoulSession();
installEdgeSoulRecovery();
installCompletedSoulAnswerDetection();

const rootDir = __dirname;
const instanceId = String(process.env.DAVID_SOUL_INSTANCE_ID || "default")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, "-")
  .slice(0, 80) || "default";

let relay = null;
let shuttingDown = false;
let lastStatus = null;

function clean(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeDetails(value) {
  if (!value || typeof value !== "object") return {};
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|authorization|chat_url/i.test(key)) continue;
    if (typeof item === "string") copy[key] = clean(item, 500);
    else if (["number", "boolean"].includes(typeof item)) copy[key] = item;
  }
  return copy;
}

function requireConfig() {
  const chatUrl = clean(process.env.DAVID_SOUL_CHAT_URL, 500);
  const deviceToken = clean(process.env.DAVID_DEVICE_TOKEN, 1000);
  const supabaseUrl = clean(process.env.SUPABASE_URL, 500);

  validateSoulChatUrl(chatUrl);
  if (!supabaseUrl) throw new Error("SUPABASE_URL is missing from .env.");
  if (!deviceToken || deviceToken.length < 32) {
    throw new Error("DAVID_DEVICE_TOKEN is missing or invalid in .env.");
  }

  process.env.DAVID_DEVICE_BRIDGE_FUNCTION =
    process.env.DAVID_DEVICE_BRIDGE_FUNCTION || "david-soul-bridge";
  process.env.DAVID_SOUL_AUTO_START = "false";

  return { chatUrl };
}

function statusFilePath() {
  return process.env.DAVID_SOUL_STATUS_FILE ||
    path.join(rootDir, ".david-system", "soul-status.json");
}

function writeStatus(state, message, kind = "info", meta = {}) {
  const file = statusFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const payload = {
    mode: "soul-node",
    runtime_version: VERSION,
    electron_used: false,
    instance_id: instanceId,
    state: clean(state, 80),
    kind: clean(kind, 40),
    message: clean(message, 1000),
    stage: clean(meta?.stage || "", 120),
    details: safeDetails(meta?.details || meta || {}),
    pid: process.pid,
    updated_at: new Date().toISOString()
  };

  const serialized = JSON.stringify(payload, null, 2);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(temporary, serialized, "utf8");
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      if (!["EPERM", "EACCES", "EEXIST"].includes(String(error?.code || ""))) {
        throw error;
      }
      fs.writeFileSync(file, serialized, "utf8");
      try { fs.unlinkSync(temporary); } catch {}
    }
  } catch {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  }

  lastStatus = payload;
  return payload;
}

function inferState(message, kind, meta = {}) {
  const text = `${meta?.stage || ""} ${message || ""}`.toLowerCase();
  if (kind === "error") return "error";
  if (text.includes("login_required") || text.includes("log in to chatgpt")) {
    return "login_required";
  }
  if (
    text.includes("prompt_ready") ||
    text.includes("saved_login_ready") ||
    text.includes("fixed soul conversation is ready") ||
    text.includes("fixed chatgpt session is open")
  ) {
    return "gpt_ready";
  }
  if (text.includes("waiting for soul") || text.includes("soul mode is active")) {
    return "ready";
  }
  return "working";
}

function sendStatus(message, kind = "info", meta = {}) {
  const text = clean(message);
  const normalizedKind = clean(kind, 40) || "info";
  const state = inferState(text, normalizedKind, meta);
  console.log(`[DAVID SOUL NODE][${instanceId.toUpperCase()}][${normalizedKind.toUpperCase()}] ${text}`);
  return writeStatus(state, text, normalizedKind, meta);
}

function installRuntimePatches() {
  const installed = {
    turn_finalizer: installDavidSoulTurnFinalizerV4(),
    anchor_2: installDavidSoulAnchor2({ rootDir }),
    master_edge: installDavidSoulMasterEdge({ rootDir }),
    whole_turn: installDavidSoulWholeTurnReturn({ rootDir }),
    network_shield: installDavidSoulNetworkShield(),
    auto_reconnect: installDavidSoulAutoReconnect(),
    auto_reconnect_v11: installDavidSoulAutoReconnectV11(),
    fast_brain_io: installDavidFastBrainIO()
  };

  console.log("[DAVID SOUL NODE] runtime patches installed", {
    version: VERSION,
    electron_used: false,
    patch_count: Object.keys(installed).length
  });

  return installed;
}

async function boot() {
  const { chatUrl } = requireConfig();
  installRuntimePatches();

  writeStatus(
    "starting",
    `DAVID Node instance '${instanceId}' is starting without Electron.`,
    "working",
    { stage: "node_runtime_start" }
  );

  relay = new LiveSoulRelay({ BrowserWindow: null, sendStatus });
  relay.browser = new EdgeSoulMultiSessionAgent({
    sendStatus,
    chatUrl,
    rootDir
  });

  writeStatus(
    "opening_gpt",
    `DAVID Node instance '${instanceId}' is loading the saved ChatGPT login and fixed SOUL route.`,
    "working",
    { stage: "loading_saved_login" }
  );

  await relay.browser.openIfNeeded(chatUrl);

  writeStatus(
    "gpt_ready",
    `DAVID Node instance '${instanceId}' has its saved ChatGPT route ready.`,
    "ready",
    { stage: "gpt_ready" }
  );

  await relay.start();
  sendStatus(
    `DAVID SOUL Node instance '${instanceId}' is active: Soul -> Thinker -> Worker -> Soul.`,
    "ready",
    { stage: "relay_ready", electron_used: false }
  );

  return {
    ok: true,
    version: VERSION,
    electron_used: false,
    status: lastStatus
  };
}

async function shutdown(signal = "shutdown") {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    writeStatus(
      "stopping",
      `DAVID Node instance '${instanceId}' is stopping (${signal}). Saved Edge profile is kept.`,
      "warning",
      { stage: "stopping" }
    );
    relay?.stop?.();
    await Promise.resolve(relay?.browser?.close?.()).catch(() => {});
  } finally {
    process.exit(0);
  }
}

function installProcessHandlers() {
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("uncaughtException", (error) => {
    const message = clean(error?.stack || error?.message || error, 4000);
    console.error("[DAVID SOUL NODE] uncaughtException", message);
    writeStatus("error", message, "error", { stage: "uncaught_exception" });
    process.exitCode = 1;
  });

  process.on("unhandledRejection", (error) => {
    const message = clean(error?.stack || error?.message || error, 4000);
    console.error("[DAVID SOUL NODE] unhandledRejection", message);
    writeStatus("error", message, "error", { stage: "unhandled_rejection" });
    process.exitCode = 1;
  });
}

if (require.main === module) {
  installProcessHandlers();
  boot().catch((error) => {
    const message = clean(error?.stack || error?.message || error, 4000);
    console.error("[DAVID SOUL NODE] startup failed", message);
    writeStatus("error", message, "error", { stage: "startup_failed" });
    process.exit(1);
  });
}

module.exports = {
  VERSION,
  boot,
  clean,
  inferState,
  installProcessHandlers,
  installRuntimePatches,
  requireConfig,
  safeDetails,
  sendStatus,
  shutdown,
  statusFilePath,
  writeStatus
};
