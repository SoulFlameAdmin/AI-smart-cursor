"use strict";

require("dotenv").config();

const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");
const { LiveSoulRelay } = require("./core/soul-relay-live.cjs");
const { EdgeSoulBrowserAgent } = require("./core/edge-cdp-soul-browser.cjs");
const { validateSoulChatUrl } = require("./core/soul-relay-runtime-v3.cjs");

let relay = null;
let isQuitting = false;

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

function sendStatus(message, kind = "info") {
  console.log(`[DAVID SOUL EDGE][${String(kind).toUpperCase()}] ${clean(message)}`);
}

async function boot() {
  const { chatUrl } = requireConfig();
  const rootDir = __dirname;

  relay = new LiveSoulRelay({ BrowserWindow, sendStatus });
  relay.browser = new EdgeSoulBrowserAgent({
    sendStatus,
    chatUrl,
    rootDir
  });

  await relay.start();
  await relay.browser.openIfNeeded(chatUrl);
  sendStatus("DAVID is connected to the fixed ChatGPT tab in Microsoft Edge and is waiting for SOUL.", "ready");
}

app.on("before-quit", () => {
  isQuitting = true;
  relay?.stop?.();
  relay?.browser?.connection?.close?.();
});

app.on("window-all-closed", () => {
  // The DAVID worker intentionally has no Electron browser window.
});

app.whenReady().then(boot).catch((error) => {
  const message = clean(error?.message || error, 4000) || "DAVID SOUL Edge relay failed to start.";
  console.error("DAVID SOUL Edge startup failed:", error);
  dialog.showErrorBox(
    "DAVID SOUL Edge relay did not start",
    `${message}\n\nTeacher mode was not started. Check david-soul-error.log.`
  );
  if (!isQuitting) app.exit(1);
});
