"use strict";
const { installDavidSoulTurnFinalizerV4 } = require("./core/edge-soul-turn-finalizer-v4.cjs"); // DAVID_TURN_FINALIZER_V4_REQUIRE
const { installDavidSoulAutoReconnectV11 } = require("./core/david-soul-auto-reconnect-v11.cjs"); // DAVID_SOUL_AUTO_RECONNECT_V11
const { installDavidSoulAutoReconnect } = require("./core/david-soul-auto-reconnect-v1.cjs"); // DAVID_SOUL_AUTO_RECONNECT_V1
const { installDavidSoulCompletionProof } = require("./core/david-soul-completion-proof-v1.cjs"); // DAVID_SOUL_COMPLETION_PROOF_V1
const { installDavidSoulNetworkShield } = require("./core/david-soul-network-shield-v1.cjs"); // DAVID_SOUL_NETWORK_SHIELD_V1
const { installDavidSoulWholeTurnReturn } = require("./core/david-soul-whole-turn-return-v1.cjs"); // DAVID_SOUL_WHOLE_TURN_RETURN_V1
const { installDavidSoulMasterEdge } = require("./core/david-soul-master-edge.cjs"); // DAVID_SOUL_MASTER_EDGE_V1
const { installDavidSoulAnchor2 } = require("./core/david-soul-anchor-2.cjs"); // DAVID_SOUL_ANCHOR_2_V020

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");
const { LiveSoulRelay } = require("./core/soul-relay-live.cjs");
const { EdgeSoulMultiSessionAgent } = require("./core/edge-cdp-soul-browser.cjs");
const { installDavidFastBrainIO } = require("./core/david-fast-brain-io-v1.cjs"); // DAVID_FAST_BRAIN_IO_V1_REQUIRE
const {
  installPersistentSoulSession
} = require("./core/edge-soul-persistent-session.cjs");
const {
  installReliableSoulSendConfirmation
} = require("./core/edge-soul-send-confirm-patch.cjs");
const {
  installEdgeSoulRecovery
} = require("./core/edge-soul-recovery-patch.cjs");
const {
  installCompletedSoulAnswerDetection
} = require("./core/edge-soul-answer-completion-patch.cjs"); // DAVID_SOUL_FINAL_ANSWER_V1_1
const {
  installLiveSoulRouteWatcher
} = require("./core/edge-soul-live-route-watcher.cjs"); // DAVID_SOUL_LIVE_ROUTE_WATCHER_V1
const { validateSoulChatUrl } = require("./core/soul-relay-runtime-v3.cjs");

// DAVID SOUL uses Microsoft Edge for the visible GPT session and does not need
// Electron GPU rendering. Disabling it before app readiness prevents Windows GPU
// process crash loops when multiple isolated workers run at the same time.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");

installPersistentSoulSession();
// DAVID_LEGACY_PROMPT_VERIFY_DISABLED - base CDP sender verifies the submitted turn.
installEdgeSoulRecovery();
installCompletedSoulAnswerDetection();

const davidSoulTurnFinalizerV4 = installDavidSoulTurnFinalizerV4(); // DAVID_TURN_FINALIZER_V4_CALL
console.log("[DAVID SOUL] TURN FINALIZER V4 installed", davidSoulTurnFinalizerV4);

const instanceId = String(process.env.DAVID_SOUL_INSTANCE_ID || "default")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, "-")
  .slice(0, 80) || "default";
const multiInstance = process.env.DAVID_SOUL_MULTI_INSTANCE === "1";
// DAVID_FIXED_ROUTE_ONE_TAB_V1
// Each isolated instance owns exactly one configured conversation. The former
// live route watcher registered every server route in every instance, which
// created an unbounded number of tabs during login and route synchronization.
// Dynamic route registration stays disabled; jobs use the instance's fixed URL.
const davidLiveRouteWatcher = {
  installed: false,
  fixed_route_mode: true,
  reason: "one-fixed-conversation-per-instance"
};
console.log("[DAVID SOUL] LIVE ROUTE WATCHER", davidLiveRouteWatcher);

const davidSoulAnchor2 = installDavidSoulAnchor2({ rootDir: __dirname });
console.log("[DAVID SOUL] Anchor 2 candidate installed", davidSoulAnchor2);
const davidSoulMasterEdge = installDavidSoulMasterEdge({ rootDir: __dirname });
console.log("[DAVID SOUL] MASTER EDGE installed", davidSoulMasterEdge);
const davidSoulWholeTurnReturn = installDavidSoulWholeTurnReturn({ rootDir: __dirname });
console.log("[DAVID SOUL] WHOLE TURN RETURN installed", davidSoulWholeTurnReturn);
const davidSoulNetworkShield = installDavidSoulNetworkShield();
console.log("[DAVID SOUL] NETWORK SHIELD installed", davidSoulNetworkShield);
const davidSoulCompletionProof = { version: "disabled-stable-v4", installed: false, reason: "V4 + WholeTurn are authoritative" };
console.log("[DAVID SOUL] COMPLETION PROOF installed", davidSoulCompletionProof);
const davidSoulAutoReconnect = installDavidSoulAutoReconnect();
console.log("[DAVID SOUL] AUTO RECONNECT installed", davidSoulAutoReconnect);
const davidSoulAutoReconnectV11 = installDavidSoulAutoReconnectV11();
console.log("[DAVID SOUL] AUTO RECONNECT v1.1 installed", davidSoulAutoReconnectV11);
const gotSingleInstanceLock = multiInstance
  ? true
  : app.requestSingleInstanceLock({ mode: "soul", instance_id: instanceId });

if (!gotSingleInstanceLock) {
  console.error(`DAVID SOUL Edge worker '${instanceId}' is already running.`);
  app.quit();
}

let relay = null;
let isQuitting = false;
let lastStatus = null;
let lastConsoleStatusSignature = "";
let lastConsoleStatusAt = 0;

const davidFastBrainIO = installDavidFastBrainIO(); // DAVID_FAST_BRAIN_IO_V1_CALL
console.log("[DAVID SOUL] FAST BRAIN I/O installed", davidFastBrainIO);
function clean(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
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
    path.join(__dirname, ".david-system", "soul-status.json");
}

function safeDetails(value) {
  if (!value || typeof value !== "object") return {};
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|authorization/i.test(key)) continue;
    if (typeof item === "string") copy[key] = clean(item, 500);
    else if (["number", "boolean"].includes(typeof item)) copy[key] = item;
  }
  return copy;
}

function writeStatus(state, message, kind = "info", meta = {}) {
  const file = statusFilePath();
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });

  const payload = {
    mode: "soul",
    instance_id: instanceId,
    multi_instance: multiInstance,
    transport: "twins-supabase-edge",
    state: clean(state, 80),
    kind: clean(kind, 40),
    message: clean(message, 1000),
    stage: clean(meta?.stage || "", 120),
    details: safeDetails(meta?.details || {}),
    pid: process.pid,
    updated_at: new Date().toISOString()
  };

  // DAVID_STATUS_WRITE_SAFE_V1
  //
  // Status persistence must NEVER kill a GPT route.
  // Use a unique temp filename and tolerate Windows rename races.

  const serialized = JSON.stringify(payload, null, 2);

  const temporary =
    `${file}.${process.pid}.${Date.now()}.` +
    `${Math.random().toString(16).slice(2)}.tmp`;

  try {
    fs.writeFileSync(temporary, serialized, "utf8");

    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      const code = String(error?.code || "");

      if (!["EPERM", "EACCES", "EEXIST"].includes(code)) {
        throw error;
      }

      // Windows may temporarily lock the destination.
      // The in-memory status remains authoritative.
      try {
        fs.writeFileSync(file, serialized, "utf8");
      } catch {}

      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  } catch (error) {
    // A status-file problem is telemetry only.
    // It must never interrupt SOUL -> GPT -> SOUL.
    try {
      if (fs.existsSync(temporary)) {
        fs.unlinkSync(temporary);
      }
    } catch {}
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
  const signature = `${normalizedKind}\u0000${text}`;
  const now = Date.now();

  if (signature !== lastConsoleStatusSignature || now - lastConsoleStatusAt > 750) {
    console.log(`[DAVID SOUL EDGE][${instanceId.toUpperCase()}][${normalizedKind.toUpperCase()}] ${text}`);
    lastConsoleStatusSignature = signature;
    lastConsoleStatusAt = now;
  }

  writeStatus(state, text, normalizedKind, meta);
}

async function boot() {
  const { chatUrl } = requireConfig();
  const rootDir = __dirname;

  writeStatus(
    "starting",
    `DAVID instance '${instanceId}' is switching to SOUL mode.`,
    "working",
    { stage: "mode_switch" }
  );

  relay = new LiveSoulRelay({ BrowserWindow, sendStatus });
  relay.browser = new EdgeSoulMultiSessionAgent({
    sendStatus,
    chatUrl,
    rootDir
  });

  writeStatus(
    "opening_gpt",
    `DAVID instance '${instanceId}' is loading its saved ChatGPT login and multi-session router.`,
    "working",
    { stage: "loading_saved_login" }
  );

  await relay.browser.openIfNeeded(chatUrl);

  writeStatus(
    "gpt_ready",
    `DAVID instance '${instanceId}' has its primary saved login and GPT route ready.`,
    "ready",
    { stage: "gpt_ready" }
  );

  // DAVID_THINKER_WORKER_V1
  // MITKO 9333 is the only Soul queue consumer. DAVID 9444 remains attached
  // to the fixed Thinker conversation and is driven by the isolated local
  // Teacher/PowerShell worker. This prevents both ports from racing to claim
  // the same Soul message.
  const thinkerOnly = instanceId === "david" ||
    process.env.DAVID_THINKER_ONLY === "1";

  if (thinkerOnly) {
    sendStatus(
      `DAVID instance '${instanceId}' is ready as the fixed Thinker + PowerShell Worker on port 9444.`,
      "ready",
      { stage: "thinker_worker_ready" }
    );
  } else {
    await relay.start();
    sendStatus(
      `DAVID SOUL instance '${instanceId}' is active: Soul -> Thinker -> Worker -> Soul.`,
      "ready",
      { stage: "relay_ready" }
    );
  }
}

if (!multiInstance) {
  app.on("second-instance", () => {
    sendStatus(
      "A second SOUL start was blocked because this DAVID SOUL worker is already running.",
      "warning",
      { stage: "single_instance" }
    );
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  writeStatus(
    "stopping",
    `DAVID instance '${instanceId}' is stopping. Its saved Edge profile is kept.`,
    "warning",
    { stage: "stopping" }
  );
  relay?.stop?.();
  relay?.browser?.close?.();
});

app.on("window-all-closed", () => {
  // The DAVID worker intentionally has no Electron browser window.
});

app.whenReady().then(boot).catch((error) => {
  const message = clean(error?.message || error, 4000) || "DAVID SOUL Edge relay failed to start.";
  console.error(`DAVID SOUL Edge startup failed for '${instanceId}':`, error);
  writeStatus(
    "error",
    message,
    "error",
    { stage: "startup_failed" }
  );

  if (process.env.DAVID_SOUL_SHOW_ERROR_DIALOG === "1") {
    dialog.showErrorBox(
      `DAVID SOUL '${instanceId}' did not start`,
      `${message}\n\nCheck the isolated instance error log.`
    );
  }

  if (!isQuitting) app.exit(1);
});

process.on("uncaughtException", (error) => {
  const message = clean(error?.stack || error?.message || error, 4000);
  console.error(message);
  writeStatus("error", message, "error", { stage: "uncaught_exception" });
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const message = clean(reason?.stack || reason?.message || reason, 4000);
  console.error(message);
  writeStatus("error", message, "error", { stage: "unhandled_rejection" });
  app.exit(1);
});
