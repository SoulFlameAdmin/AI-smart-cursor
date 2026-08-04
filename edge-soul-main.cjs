"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");
const { LiveSoulRelay } = require("./core/soul-relay-live.cjs");
const { EdgeSoulBrowserAgent } = require("./core/edge-cdp-soul-browser.cjs");
const {
  installPersistentSoulSession
} = require("./core/edge-soul-persistent-session.cjs");
const {
  installReliableSoulSendConfirmation
} = require("./core/edge-soul-send-confirm-patch.cjs");
const {
  installEdgeSoulRecovery
} = require("./core/edge-soul-recovery-patch.cjs");
const { validateSoulChatUrl } = require("./core/soul-relay-runtime-v3.cjs");

installPersistentSoulSession();
installReliableSoulSendConfirmation();
installEdgeSoulRecovery();

const gotSingleInstanceLock = app.requestSingleInstanceLock({ mode: "soul" });
if (!gotSingleInstanceLock) {
  console.error("DAVID SOUL Edge worker is already running.");
  app.quit();
}

let relay = null;
let isQuitting = false;
let lastStatus = null;
let lastConsoleStatusSignature = "";
let lastConsoleStatusAt = 0;

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
    transport: "twins-supabase-edge",
    state: clean(state, 80),
    kind: clean(kind, 40),
    message: clean(message, 1000),
    stage: clean(meta?.stage || "", 120),
    details: safeDetails(meta?.details || {}),
    pid: process.pid,
    updated_at: new Date().toISOString()
  };

  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(temporary, file);
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
    console.log(`[DAVID SOUL EDGE][${normalizedKind.toUpperCase()}] ${text}`);
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
    "DAVID is switching from the local Teacher loop to SOUL mode for the Twins site.",
    "working",
    { stage: "mode_switch" }
  );

  relay = new LiveSoulRelay({ BrowserWindow, sendStatus });
  relay.browser = new EdgeSoulBrowserAgent({
    sendStatus,
    chatUrl,
    rootDir
  });

  writeStatus(
    "opening_gpt",
    "DAVID is loading the saved ChatGPT login and the one fixed SOUL session.",
    "working",
    { stage: "loading_saved_login" }
  );

  // Critical ordering: do not claim a message from Twins until GPT is ready.
  await relay.browser.openIfNeeded(chatUrl);

  writeStatus(
    "gpt_ready",
    "The saved ChatGPT login and fixed GPT session are ready. DAVID is now activating the Twins SOUL queue.",
    "ready",
    { stage: "gpt_ready" }
  );

  await relay.start();

  sendStatus(
    "DAVID SOUL mode is active: Twins -> DAVID Edge -> GPT -> Twins.",
    "ready",
    { stage: "relay_ready" }
  );
}

app.on("second-instance", () => {
  sendStatus(
    "A second SOUL start was blocked because the DAVID SOUL worker is already running.",
    "warning",
    { stage: "single_instance" }
  );
});

app.on("before-quit", () => {
  isQuitting = true;
  writeStatus(
    "stopping",
    "DAVID SOUL mode is stopping. The saved Edge login profile is kept.",
    "warning",
    { stage: "stopping" }
  );
  relay?.stop?.();
  relay?.browser?.connection?.close?.();
});

app.on("window-all-closed", () => {
  // The DAVID worker intentionally has no Electron browser window.
});

app.whenReady().then(boot).catch((error) => {
  const message = clean(error?.message || error, 4000) || "DAVID SOUL Edge relay failed to start.";
  console.error("DAVID SOUL Edge startup failed:", error);
  writeStatus(
    "error",
    message,
    "error",
    { stage: "startup_failed" }
  );

  if (process.env.DAVID_SOUL_SHOW_ERROR_DIALOG === "1") {
    dialog.showErrorBox(
      "DAVID SOUL Edge relay did not start",
      `${message}\n\nTeacher mode was not started. Check david-soul-error.log.`
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
