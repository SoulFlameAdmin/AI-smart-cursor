"use strict";

require("dotenv").config();

const { app, BrowserWindow, dialog, session } = require("electron");
const { LiveSoulRelay } = require("./core/soul-relay-live.cjs");
const { validateSoulChatUrl } = require("./core/soul-relay-runtime-v3.cjs");

const SOUL_PARTITION = process.env.DAVID_SOUL_PARTITION || "persist:david-soul-v2";
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/142.0.0.0 Safari/537.36";

app.userAgentFallback = CHROME_USER_AGENT;
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let relay = null;
let isQuitting = false;

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isChatGptLocation(value) {
  try {
    return new URL(String(value || "")).hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

function dataPage(title, message, detail = "") {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>
  html,body{height:100%;margin:0;background:#0f1115;color:#f5f7fb;font-family:Segoe UI,Arial,sans-serif}
  main{min-height:100%;display:grid;place-items:center;padding:32px;box-sizing:border-box}
  section{max-width:760px;width:100%;border:1px solid #303744;border-radius:18px;padding:24px;background:#171b22;box-shadow:0 22px 70px rgba(0,0,0,.38)}
  h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:1.55;margin:8px 0;color:#d8deea}
  pre{white-space:pre-wrap;word-break:break-word;background:#0d1015;border-radius:12px;padding:14px;color:#b9c4d8}
  .pulse{display:inline-block;width:10px;height:10px;border-radius:50%;background:#4ade80;margin-right:9px;animation:pulse 1.2s infinite}
  @keyframes pulse{50%{opacity:.25}}
</style></head><body><main><section>
<h1><span class="pulse"></span>${htmlEscape(title)}</h1>
<p>${htmlEscape(message)}</p>${detail ? `<pre>${htmlEscape(detail)}</pre>` : ""}
</section></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function requireSoulConfig() {
  const chatUrl = clean(process.env.DAVID_SOUL_CHAT_URL, 500);
  const deviceToken = clean(process.env.DAVID_DEVICE_TOKEN, 1000);
  const supabaseUrl = clean(process.env.SUPABASE_URL, 500);

  if (!chatUrl || /PASTE|private-chat-id|<.+>/i.test(chatUrl)) {
    throw new Error(
      "DAVID_SOUL_CHAT_URL is missing from the local .env file. " +
      "Use a private URL such as https://chatgpt.com/c/..."
    );
  }

  validateSoulChatUrl(chatUrl);
  if (!supabaseUrl) throw new Error("SUPABASE_URL is missing from the local .env file.");
  if (!deviceToken || deviceToken.length < 32) {
    throw new Error("DAVID_DEVICE_TOKEN is missing or invalid in the local .env file.");
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

class DavidSoulBrowserWindow extends BrowserWindow {
  constructor(options = {}) {
    const webPreferences = {
      ...(options.webPreferences || {}),
      partition: SOUL_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      backgroundThrottling: false
    };

    super({
      ...options,
      show: true,
      title: "DAVID SOUL",
      backgroundColor: "#0f1115",
      webPreferences
    });

    this.setMenuBarVisibility(true);
    this.webContents.setUserAgent(CHROME_USER_AGENT);
    this.webContents.session.setUserAgent(CHROME_USER_AGENT);

    const wc = this.webContents;
    const log = (event, details = "") => {
      console.log(`[DAVID SOUL WINDOW] ${event}${details ? ` | ${details}` : ""}`);
    };

    wc.on("did-start-loading", () => log("did-start-loading", wc.getURL()));
    wc.on("dom-ready", () => log("dom-ready", wc.getURL()));
    wc.on("did-finish-load", () => {
      log("did-finish-load", `${wc.getURL()} | ${wc.getTitle()}`);
    });
    wc.on("did-stop-loading", () => log("did-stop-loading", wc.getURL()));
    wc.on("render-process-gone", (_event, details) => {
      console.error(
        `[DAVID SOUL WINDOW] render-process-gone | ${details.reason} | ${details.exitCode}`
      );
    });
    wc.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        const currentURL = wc.isDestroyed() ? "" : wc.getURL();
        const currentTitle = wc.isDestroyed() ? "" : wc.getTitle();
        console.error(
          `[DAVID SOUL WINDOW] did-fail-load | code=${errorCode} | ` +
          `${errorDescription} | main=${isMainFrame} | ${validatedURL} | ` +
          `current=${currentURL} | title=${currentTitle}`
        );

        if (!isMainFrame || wc.isDestroyed()) return;

        const chatGptNavigation =
          isChatGptLocation(validatedURL) ||
          isChatGptLocation(currentURL) ||
          /chatgpt/i.test(currentTitle);
        const redirectOrCancelled = errorCode === -2 || errorCode === -3;

        if (chatGptNavigation && redirectOrCancelled) {
          log(
            "soft-navigation-error-ignored",
            `code=${errorCode} | current=${currentURL} | title=${currentTitle}`
          );
          return;
        }

        const detail = [
          `Error code: ${errorCode}`,
          `Description: ${errorDescription}`,
          `URL: ${validatedURL}`,
          `Current URL: ${currentURL}`,
          `Title: ${currentTitle}`,
          "See .david-system/logs/david-soul-error.log for details."
        ].join("\n");
        wc.loadURL(
          dataPage(
            "DAVID SOUL could not load ChatGPT",
            "The relay process is running, but Chromium failed to load the private chat.",
            detail
          )
        ).catch(() => {});
      }
    );

    this.on("unresponsive", () => {
      console.error("[DAVID SOUL WINDOW] unresponsive");
    });

    wc.loadURL(
      dataPage(
        "DAVID SOUL is starting",
        "Opening the fixed ChatGPT session and connecting to the SOUL queue..."
      )
    ).catch(() => {});
  }
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

  const soulSession = session.fromPartition(SOUL_PARTITION, { cache: true });
  soulSession.setUserAgent(CHROME_USER_AGENT);
  await soulSession.clearCache().catch(() => {});

  relay = new LiveSoulRelay({
    BrowserWindow: DavidSoulBrowserWindow,
    sendStatus
  });

  await relay.start();
  await relay.browser.openIfNeeded(chatUrl);

  await relay.browser.showReport(
    "waiting",
    "DAVID Electron is in the fixed GPT session and is waiting for SOUL.",
    { route: "Soul -> DAVID Electron -> GPT -> Soul" },
    "ready"
  ).catch(() => {});

  sendStatus(
    "The fixed GPT session is open. DAVID is waiting for SOUL messages.",
    "ready"
  );
}

app.on("second-instance", () => {
  focusSoulWindow().catch(() => {});
});

app.on("window-all-closed", () => {
  // Keep the SOUL worker alive. The window can be recreated for a new message.
});

app.on("before-quit", () => {
  isQuitting = true;
  relay?.stop?.();
});

app.whenReady().then(bootSoulOnly).catch((error) => {
  const message = clean(error?.message || error, 4000) || "DAVID SOUL failed to start.";
  console.error("DAVID SOUL startup failed:", error);
  dialog.showErrorBox(
    "DAVID SOUL did not start",
    `${message}\n\nTeacher mode was not started. Check david-soul-error.log.`
  );
  if (!isQuitting) app.exit(1);
});
