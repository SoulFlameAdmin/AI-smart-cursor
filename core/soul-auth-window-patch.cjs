"use strict";

const { SoulBrowserAgent } = require("./soul-relay-runtime-v3.cjs");

const DEFAULT_PARTITION = "persist:david-soul-v2";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/142.0.0.0 Safari/537.36";

const AUTH_HOST_SUFFIXES = Object.freeze([
  "chatgpt.com",
  "openai.com",
  "google.com",
  "apple.com",
  "live.com",
  "microsoftonline.com"
]);

function isAllowedSoulAuthUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return AUTH_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

function installSoulAuthWindowPatch({
  partition = process.env.DAVID_SOUL_PARTITION || DEFAULT_PARTITION,
  userAgent = DEFAULT_USER_AGENT
} = {}) {
  SoulBrowserAgent.prototype.ensureWindow = function ensureSoulWindowWithAuth() {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const parent = new this.BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      title: "DAVID SOUL",
      show: true,
      backgroundColor: "#111111",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        autoplayPolicy: "no-user-gesture-required",
        backgroundThrottling: false,
        partition
      }
    });

    this.window = parent;
    parent.__davidSkipFullScreenPatch = true;
    parent.webContents.setUserAgent(userAgent);
    parent.webContents.session.setUserAgent(userAgent);

    const authWindows = new Set();

    parent.webContents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedSoulAuthUrl(url)) {
        console.warn(`[DAVID SOUL AUTH] blocked popup: ${String(url || "")}`);
        return { action: "deny" };
      }

      console.log(`[DAVID SOUL AUTH] allowing login popup: ${url}`);
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 560,
          height: 760,
          minWidth: 420,
          minHeight: 600,
          title: "DAVID SOUL LOGIN",
          parent,
          modal: false,
          show: true,
          autoHideMenuBar: false,
          backgroundColor: "#ffffff",
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            backgroundThrottling: false,
            partition
          }
        }
      };
    });

    parent.webContents.on("did-create-window", (child, details) => {
      authWindows.add(child);
      child.setTitle("DAVID SOUL LOGIN");
      child.setMenuBarVisibility(true);
      child.webContents.setUserAgent(userAgent);
      child.webContents.session.setUserAgent(userAgent);

      console.log(`[DAVID SOUL AUTH] login window created: ${details?.url || ""}`);

      child.once("ready-to-show", () => {
        if (child.isDestroyed()) return;
        child.show();
        child.focus();
      });

      child.on("closed", () => {
        authWindows.delete(child);
        if (parent.isDestroyed()) return;
        parent.show();
        parent.focus();
        setTimeout(() => {
          if (!parent.isDestroyed()) parent.reload();
        }, 700);
      });
    });

    parent.webContents.on("did-finish-load", () => {
      this.renderReport().catch(() => {});
    });

    parent.on("closed", () => {
      for (const child of authWindows) {
        if (!child.isDestroyed()) child.close();
      }
      authWindows.clear();
      this.window = null;
    });

    return parent;
  };

  return {
    partition,
    auth_hosts: [...AUTH_HOST_SUFFIXES]
  };
}

module.exports = {
  AUTH_HOST_SUFFIXES,
  DEFAULT_PARTITION,
  DEFAULT_USER_AGENT,
  installSoulAuthWindowPatch,
  isAllowedSoulAuthUrl
};
