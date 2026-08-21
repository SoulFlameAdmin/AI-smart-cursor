"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  EdgeSoulBrowserAgent,
  buildChatGptLoginUrl,
  isChatGptUrl,
  sameConversation
} = require("./edge-cdp-soul-browser.cjs");
const { validateSoulChatUrl } = require("./soul-relay-runtime-v3.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeSessionState(agent, state, details = {}) {
  try {
    const systemDir = path.join(agent.rootDir, ".david-system");
    fs.mkdirSync(systemDir, { recursive: true });
    const sessionKey = String(agent.sessionKey || "default")
      .trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 80) || "default";
    const file = path.join(systemDir, `soul-login-state-${sessionKey}.json`);
    const payload = {
      state,
      profile_dir: agent.profileDir,
      session_key: sessionKey,
      session_label: agent.sessionLabel || sessionKey,
      debug_port: agent.port,
      fixed_chat_url: agent.chatUrl,
      updated_at: new Date().toISOString(),
      ...details
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  } catch {}
}

function installPersistentSoulSession() {
  EdgeSoulBrowserAgent.prototype.startEdge = function startPersistentEdge() {
    fs.mkdirSync(this.profileDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${this.port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profileDir}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-guest-mode",
      "--disable-features=msEdgeSidebarV2",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--process-per-site",
      // DAVID_BACKGROUND_EDGE_V1: keep the dedicated DAVID browser alive without a visible window.
      "--new-window",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
      this.chatUrl
    ];

    this.edgeProcess = spawn(this.edgeExe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    this.edgeProcess.unref();

    writeSessionState(this, "edge_started", {
      debug_address: `127.0.0.1:${this.port}`,
      session_key: this.sessionKey
    });
  };

  EdgeSoulBrowserAgent.prototype.diagnostics = async function persistentDiagnostics() {
    const value = await this.evaluate(`(() => {
      const clean = (value) => String(value || '').trim();
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0 && rect.width >= 120 && rect.height >= 20 &&
          rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      };
      const selectors = [
        '#prompt-textarea', '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"][data-virtualkeyboard]',
        '[contenteditable="true"].ProseMirror', 'form [contenteditable="true"]',
        'textarea[data-id="root"]', 'textarea[placeholder]', 'textarea'
      ];
      const prompts = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .filter((element, index, all) => all.indexOf(element) === index)
        .filter((element) => visible(element) && !element.matches('[disabled], [aria-disabled="true"]'));
      const body = clean(document.body?.innerText || '');
      const pathname = String(location.pathname || '');
      const explicitLoginControl = Array.from(document.querySelectorAll('a,button')).some((element) => {
        const text = clean([
          element.innerText,
          element.textContent,
          element.getAttribute('aria-label'),
          element.getAttribute('href')
        ].filter(Boolean).join(' ')).toLowerCase();
        return /(^|\\s)(log in|sign in|вход|влизане)(\\s|$)/i.test(text) ||
          /\\/auth\\/login|\\/login/.test(text);
      });
      return {
        url: location.href,
        title: document.title,
        promptCount: prompts.length,
        bodyLength: body.length,
        authPage: /\\/auth\\/|\\/login|\\/onboarding|\\/welcome/i.test(pathname),
        explicitLoginControl,
        readyState: document.readyState
      };
    })()`);
    this.lastDiagnostics = value;
    return value;
  };

  EdgeSoulBrowserAgent.prototype.openIfNeeded = async function openPersistentFixedChat(
    url = this.chatUrl
  ) {
    const target = validateSoulChatUrl(url);
    const loginUrl = buildChatGptLoginUrl(target);
    await this.connect();

    const started = Date.now();
    let lastNavigate = 0;
    let lastReport = 0;
    let loginNavigationAttempted = false;
    let targetNavigationAttempted = false;
    let loginHold = false; // DAVID_LOGIN_HOLD_V3

    writeSessionState(this, "checking_saved_login");

    while (Date.now() - started < 10 * 60 * 1000) {
      const info = await this.diagnostics().catch(() => null);
      const current = info?.url || "";
      const now = Date.now();
      const promptReady = Number(info?.promptCount || 0) > 0;
      const explicitlySignedOut = Boolean(
        info?.authPage || info?.explicitLoginControl
      );

      // DAVID_LOGIN_HOLD_V3:
      // OAuth may temporarily leave chatgpt.com.
      // Keep the SAME tab untouched until ChatGPT prompt returns.
      if (explicitlySignedOut) loginHold = true;
      if (promptReady) loginHold = false;

      if (sameConversation(current, target) && promptReady) {
        writeSessionState(this, "authenticated", {
          current_url: current,
          title: info?.title || ""
        });
        await this.showReport(
          "saved_login_ready",
          "Saved ChatGPT login is active. The fixed SOUL conversation is ready.",
          { ...info, profile_dir: this.profileDir },
          "ready"
        );
        return true;
      }

      if (promptReady && !sameConversation(current, target) && now - lastNavigate > 2500) {
        lastNavigate = now;
        targetNavigationAttempted = true;
        await this.showReport(
          "opening_fixed_chat",
          "Saved ChatGPT login is active. DAVID opens the one fixed SOUL conversation.",
          info || {},
          "working"
        );
        await this.navigate(target);
        await sleep(1500);
        continue;
      }

      if (!loginHold && !isChatGptUrl(current) && now - lastNavigate > 3000) {
        lastNavigate = now;
        targetNavigationAttempted = true;
        await this.navigate(target);
        await sleep(1500);
        continue;
      }

      if (
        explicitlySignedOut &&
        isChatGptUrl(current) &&
        !info?.authPage &&
        !loginNavigationAttempted &&
        now - lastNavigate > 2500
      ) {
        loginNavigationAttempted = true;
        lastNavigate = now;
        writeSessionState(this, "login_required", {
          current_url: current
        });
        await this.showReport(
          "login_required",
          "The saved ChatGPT session has expired. Log in once; DAVID will save it and continue automatically.",
          { ...info, profile_dir: this.profileDir },
          "login_required"
        );
        await this.navigate(loginUrl);
        await sleep(1500);
        continue;
      }

      if (info?.authPage) {
        writeSessionState(this, "login_required", {
          current_url: current
        });
      } else if (
        isChatGptUrl(current) &&
        !promptReady &&
        !targetNavigationAttempted &&
        now - started > 12000 &&
        now - lastNavigate > 3000
      ) {
        // A slow/blank ChatGPT render is not treated as logout. Retry the fixed
        // conversation once and keep waiting; never force the login page.
        targetNavigationAttempted = true;
        lastNavigate = now;
        await this.navigate(target);
        await sleep(1500);
        continue;
      }

      if (now - lastReport > 2500) {
        lastReport = now;
        await this.showReport(
          (loginHold || explicitlySignedOut) ? "login_required" : "loading_saved_session",
          (loginHold || explicitlySignedOut)
            ? "LOGIN HOLD: finish signing in. DAVID will not navigate or replace the authentication tab."
            : "DAVID is loading the saved ChatGPT session and the fixed SOUL conversation.",
          { ...info, profile_dir: this.profileDir },
          (loginHold || explicitlySignedOut) ? "login_required" : "working"
        );
      }

      await sleep(750);
    }

    writeSessionState(this, "timeout", {
      last_diagnostics: this.lastDiagnostics || null
    });
    throw new Error(
      "DAVID waited 10 minutes for the saved ChatGPT session. " +
      "Log in once in the dedicated DAVID Edge profile, then leave that profile intact."
    );
  };

  return {
    profile_mode: "persistent-default",
    login_policy: "only-explicit-signout",
    fixed_chat_only: true
  };
}

module.exports = {
  installPersistentSoulSession,
  writeSessionState
};
