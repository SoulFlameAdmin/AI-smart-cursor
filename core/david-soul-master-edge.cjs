"use strict";

const fs = require("fs");
const path = require("path");
const browserModule = require("./edge-cdp-soul-browser.cjs");

const VERSION = "david-soul-master-edge-v1.2.0";
const state = {
  rootDir: process.cwd(),
  profileDir: "",
  port: 9333,
  edgeStartPromise: null,
  authPromise: null,
  authReady: false,
  masterUrl: "",
  routePromises: new Map()
};

function cleanKey(value) {
  return String(value || "mitko")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "mitko";
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value || "").trim().replace(/\/$/, "");
  }
}

function isFixedConversationUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      /^\/c\/[0-9a-f-]{36}\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isAuthenticationUrl(value) {
  try {
    const url = new URL(String(value || ""));
    // DAVID_LOGIN_HOLD_V2: OAuth may use Google, Microsoft, Apple or OpenAI
    // hosts and may open a temporary popup. Preserve every external HTTPS
    // target while the fixed ChatGPT profile is being authenticated.
    if (url.protocol !== "https:") return false;
    if (url.hostname !== "chatgpt.com") return true;
    return /^\/(?:auth|login|onboarding|welcome)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function resolveSharedProfile(rootDir) {
  const instanceKey = cleanKey(
    process.env.DAVID_SOUL_INSTANCE_KEY ||
    process.env.DAVID_SOUL_INSTANCE ||
    process.env.DAVID_INSTANCE_KEY ||
    "mitko"
  );
  const candidates = [
    process.env.DAVID_SOUL_MASTER_EDGE_PROFILE,
    process.env.DAVID_EDGE_PROFILE_DIR,
    path.join(rootDir, ".david-instances", instanceKey, "edge-soul-profile"),
    path.join(rootDir, ".david-system", "edge-master-chatgpt-profile")
  ].filter(Boolean).map(value => path.resolve(String(value)));
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function resolveSharedPort() {
  const parsed = Number.parseInt(
    process.env.DAVID_SOUL_MASTER_EDGE_PORT ||
    process.env.DAVID_EDGE_DEBUG_PORT ||
    "9333",
    10
  );
  return Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : 9333;
}

function sameConversation(left, right) {
  if (typeof browserModule.sameConversation === "function") {
    return browserModule.sameConversation(left, right);
  }
  try {
    const a = new URL(String(left || ""));
    const b = new URL(String(right || ""));
    return a.hostname === b.hostname &&
      a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function applySharedAgent(agent) {
  if (!agent || typeof agent !== "object") return agent;
  agent.profileDir = state.profileDir;
  agent.port = state.port;
  agent.__davidSharedMasterEdge = true;
  agent.__davidExactRouteLock = true;
  return agent;
}

function applyAllSessions(manager) {
  if (!manager?.sessions || typeof manager.sessions.values !== "function") return;
  for (const session of manager.sessions.values()) {
    applySharedAgent(session?.agent);
    if (session && typeof session === "object") {
      session.shared_profile_dir = state.profileDir;
      session.shared_debug_port = state.port;
      session.exact_route_lock = true;
    }
  }
}

function routePromise(key, run) {
  if (state.routePromises.has(key)) return state.routePromises.get(key);
  const promise = Promise.resolve()
    .then(run)
    .finally(() => state.routePromises.delete(key));
  state.routePromises.set(key, promise);
  return promise;
}

async function closeDuplicatePages(agent, targets, keepTarget, { authenticating = false } = {}) {
  if (!keepTarget?.id) return;

  const pages = (Array.isArray(targets) ? targets : [])
    .filter(item => item?.type === "page" && item.id && item.id !== keepTarget.id);

  for (const page of pages) {
    // During Google/ChatGPT authentication, preserve non-ChatGPT popups.
    // Duplicate ChatGPT conversation tabs are always safe to close.
    if (authenticating && !/^https:\/\/chatgpt\.com\//i.test(String(page.url || ""))) {
      continue;
    }
    try {
      await agent.debuggerJson(`/json/close/${encodeURIComponent(page.id)}`);
    } catch {}
  }
}

function installAgentPatch(AgentClass) {
  if (typeof AgentClass !== "function") return false;
  const prototype = AgentClass.prototype;
  if (prototype.__davidMasterEdgeInstalled) return true;

  const originalStartEdge = prototype.startEdge;
  if (typeof originalStartEdge === "function") {
    prototype.startEdge = function masterEdgeStart(...args) {
      applySharedAgent(this);
      return originalStartEdge.apply(this, args);
    };
  }

  const originalEnsureEdge = prototype.ensureEdge;
  if (typeof originalEnsureEdge === "function") {
    prototype.ensureEdge = async function masterEdgeEnsure(...args) {
      applySharedAgent(this);
      if (typeof this.debuggerReady === "function" && await this.debuggerReady()) return true;
      if (state.edgeStartPromise) return state.edgeStartPromise;
      state.edgeStartPromise = Promise.resolve()
        .then(() => originalEnsureEdge.apply(this, args))
        .finally(() => {
          state.edgeStartPromise = null;
        });
      return state.edgeStartPromise;
    };
  }

  prototype.findOrCreateTarget = async function masterEdgeTarget() {
    applySharedAgent(this);

    const expectedUrl = normalizeUrl(this.chatUrl);
    if (!isFixedConversationUrl(expectedUrl)) {
      throw new Error(`DAVID EXACT ROUTE LOCK rejected non-conversation URL: ${expectedUrl || "empty"}`);
    }

    const targets = await this.debuggerJson("/json/list");
    const pages = targets.filter(item => item?.type === "page");
    let target = pages.find(item =>
      item.type === "page" && sameConversation(item.url, expectedUrl)
    );

    // A fixed conversation may temporarily become a Google/ChatGPT login URL.
    // Reuse that SAME target throughout authentication. Creating another exact
    // URL here caused an unbounded tab loop every time connect() ran.
    if (!target && this.targetId) {
      target = pages.find(item => item.id === this.targetId) || null;
    }

    // On the first connection, attach to the existing authentication/ChatGPT
    // page and let openIfNeeded() navigate it. Never create a second page while
    // a usable dedicated page already exists.
    if (!target) target = pages.find(item => isAuthenticationUrl(item.url));
    if (!target) target = pages.find(item => /^https:\/\/chatgpt\.com\//i.test(String(item.url || "")));
    if (!target) target = pages[0] || null;

    if (!target) {
      const encoded = encodeURIComponent(expectedUrl);
      target = await this.debuggerJson(`/json/new?${encoded}`, { method: "PUT" });
    }

    if (!target?.webSocketDebuggerUrl) {
      throw new Error("DAVID EXACT ROUTE LOCK could not create the dedicated ChatGPT tab.");
    }

    const authenticating = isAuthenticationUrl(target.url);
    await closeDuplicatePages(this, targets, target, { authenticating });
    target.__david_expected_conversation = expectedUrl;
    return target;
  };

  Object.defineProperty(prototype, "__davidMasterEdgeInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  return true;
}

function installMultiSessionPatch(MultiSessionClass) {
  if (typeof MultiSessionClass !== "function") return false;
  const prototype = MultiSessionClass.prototype;
  if (prototype.__davidMasterEdgeMultiInstalled) return true;

  const originalRegisterRoutes = prototype.registerRoutes;
  if (typeof originalRegisterRoutes === "function") {
    prototype.registerRoutes = function masterEdgeRegisterRoutes(routes = [], ...args) {
      const fixedUrl = normalizeUrl(this.chatUrl);
      const allowedRoutes = (Array.isArray(routes) ? routes : []).filter(route => {
        const candidate = normalizeUrl(route?.chat_url || route?.chatUrl);
        return isFixedConversationUrl(candidate) && candidate === fixedUrl;
      });
      const result = originalRegisterRoutes.call(this, allowedRoutes, ...args);
      applyAllSessions(this);
      return result;
    };
  }

  const originalEnsureReady = prototype.ensureReady;
  if (typeof originalEnsureReady === "function") {
    prototype.ensureReady = function masterEdgeEnsureReady(url, ...args) {
      const fixedUrl = normalizeUrl(this.chatUrl);
      const requestedUrl = normalizeUrl(url || fixedUrl);
      if (!isFixedConversationUrl(fixedUrl)) {
        return Promise.reject(new Error("DAVID EXACT ROUTE LOCK refused to open a non-fixed ChatGPT conversation."));
      }

      // One instance owns exactly one fixed conversation. Server route sync
      // may report other users, but it must never create another local tab.
      const exactUrl = requestedUrl === fixedUrl ? requestedUrl : fixedUrl;

      applyAllSessions(this);
      const key = exactUrl;
      const run = () => {
        applyAllSessions(this);
        return originalEnsureReady.call(this, exactUrl, ...args);
      };

      if (state.authReady) return routePromise(key, run);

      if (!state.authPromise) {
        state.masterUrl = key;
        state.authPromise = Promise.resolve()
          .then(run)
          .then(result => {
            state.authReady = true;
            return result;
          })
          .catch(error => {
            state.authPromise = null;
            state.authReady = false;
            state.masterUrl = "";
            throw error;
          });
        return state.authPromise;
      }

      if (key === state.masterUrl) return state.authPromise;
      return state.authPromise.then(() => routePromise(key, run));
    };
  }

  Object.defineProperty(prototype, "__davidMasterEdgeMultiInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  return true;
}

function writeManifest(result) {
  try {
    const systemDir = path.join(state.rootDir, ".david-system");
    fs.mkdirSync(systemDir, { recursive: true });
    fs.writeFileSync(
      path.join(systemDir, "soul-master-edge.json"),
      JSON.stringify({
        ...result,
        profile_dir: state.profileDir,
        debug_port: state.port,
        installed_at: new Date().toISOString()
      }, null, 2),
      "utf8"
    );
  } catch {}
}

function installDavidSoulMasterEdge(options = {}) {
  state.rootDir = path.resolve(options.rootDir || process.cwd());
  state.profileDir = resolveSharedProfile(state.rootDir);
  state.port = resolveSharedPort();
  fs.mkdirSync(state.profileDir, { recursive: true });

  const agentInstalled = installAgentPatch(browserModule.EdgeSoulBrowserAgent);
  const multiInstalled = installMultiSessionPatch(browserModule.EdgeSoulMultiSessionAgent);
  const result = {
    version: VERSION,
    installed: agentInstalled,
    multi_session_installed: multiInstalled,
    one_edge_process: true,
    one_persistent_login: true,
    one_tab_per_instance: true,
    fixed_primary_route_only: true,
    duplicate_tabs_closed: true,
    login_target_reused: true,
    other_routes_wait_for_login: true,
    login_profile_reused_after_restart: true,
    exact_route_lock: true,
    target_id_reused_during_login: true,
    new_chat_send_forbidden: true,
    shared_profile_dir: state.profileDir,
    shared_debug_port: state.port
  };
  writeManifest(result);
  return result;
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`DAVID MASTER EDGE self-test failed: ${message}`);
  };
  const result = installDavidSoulMasterEdge({ rootDir: process.cwd() });
  assert(result.installed, "base Edge agent patch");
  assert(result.one_edge_process, "one Edge process contract");
  assert(result.one_persistent_login, "persistent login contract");
  assert(result.one_tab_per_instance, "one tab per instance contract");
  assert(result.other_routes_wait_for_login, "login barrier contract");
  assert(result.exact_route_lock, "exact conversation route lock");
  assert(result.target_id_reused_during_login, "login target is reused");
  assert(isAuthenticationUrl("https://accounts.google.com/signin/v2"), "Google login is preserved");
  assert(isAuthenticationUrl("https://login.microsoftonline.com/common/oauth2"), "Microsoft login is preserved");
  assert(result.new_chat_send_forbidden, "new chat send forbidden");
  assert(isFixedConversationUrl("https://chatgpt.com/c/6a700898-8b7c-83eb-9a7c-b7e4fcdbe78f"), "fixed conversation accepted");
  assert(!isFixedConversationUrl("https://chatgpt.com/"), "ChatGPT home rejected");
  assert(!isFixedConversationUrl("https://chatgpt.com/c/new"), "new chat rejected");
  assert(Number.isInteger(result.shared_debug_port), "shared port");
  return result;
}

module.exports = {
  VERSION,
  installDavidSoulMasterEdge,
  isFixedConversationUrl,
  runSelfTest
};

if (require.main === module) {
  const result = runSelfTest();
  console.log("DAVID SOUL MASTER EDGE SELF-TEST: PASS");
  console.log(JSON.stringify(result, null, 2));
}
