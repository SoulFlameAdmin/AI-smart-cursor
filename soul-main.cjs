"use strict";

require("dotenv").config();

const { app, BrowserWindow, dialog } = require("electron");
const { LiveSoulRelay } = require("./core/soul-relay-live.cjs");
const { validateSoulChatUrl } = require("./core/soul-relay-runtime-v3.cjs");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

let relay = null;
let isQuitting = false;

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function requireSoulConfig() {
  const chatUrl = clean(process.env.DAVID_SOUL_CHAT_URL, 500);
  const deviceToken = clean(process.env.DAVID_DEVICE_TOKEN, 1000);
  const supabaseUrl = clean(process.env.SUPABASE_URL, 500);

  if (!chatUrl || /PASTE|private-chat-id|<.+>/i.test(chatUrl)) {
    throw new Error(
      "Липсва реалният DAVID_SOUL_CHAT_URL в локалния .env файл. " +
      "Трябва да е частен адрес от вида https://chatgpt.com/c/..."
    );
  }

  validateSoulChatUrl(chatUrl);

  if (!supabaseUrl) {
    throw new Error("Липсва SUPABASE_URL в локалния .env файл.");
  }

  if (!deviceToken || deviceToken.length < 32) {
    throw new Error("Липсва валиден DAVID_DEVICE_TOKEN в локалния .env файл.");
  }

  process.env.DAVID_DEVICE_BRIDGE_FUNCTION =
    process.env.DAVID_DEVICE_BRIDGE_FUNCTION || "david-soul-bridge";
  process.env.DAVID_SOUL_BROWSER_VISIBLE = "true";
  process.env.DAVID_SOUL_AUTO_START = "false";

  return { chatUrl };
}

function sendStatus(message, kind = "info") {
  const text = clean(message, 2000);
  const label = String(kind || "info").toUpperCase();
  console.log(`[DAVID SOUL][${label}] ${text}`);
}

async function focusSoulWindow() {
  const window = relay?.browser?.window;
  if (!window || window.isDestroyed()) return false;
  window.show();
  window.focus();
  return true;
}

async function bootSoulOnly() {
  const { chatUrl } = requireSoulConfig();

  relay = new LiveSoulRelay({
    BrowserWindow,
    sendStatus
  });

  await relay.start();
  await relay.browser.openIfNeeded(chatUrl);
  await relay.browser.showReport(
    "waiting",
    "DAVID Electron е в точната GPT сесия и чака въпрос от Soul.",
    { route: "Soul → DAVID Electron → GPT → Soul" },
    "ready"
  ).catch(() => {});

  sendStatus(
    "Точната GPT сесия е отворена. DAVID чака съобщения от Soul.",
    "ready"
  );
}

app.on("second-instance", () => {
  focusSoulWindow().catch(() => {});
});

app.on("window-all-closed", () => {
  // SOUL worker остава активен. При ново съобщение прозорецът се отваря отново.
});

app.on("before-quit", () => {
  isQuitting = true;
  relay?.stop?.();
});

app.whenReady().then(bootSoulOnly).catch((error) => {
  const message = clean(error?.message || error, 4000) || "DAVID SOUL не успя да стартира.";
  console.error("DAVID SOUL startup failed:", error);
  dialog.showErrorBox(
    "DAVID SOUL не стартира",
    `${message}\n\nПровери локалния .env файл. Teacher режимът не е стартиран.`
  );
  if (!isQuitting) app.exit(1);
});
