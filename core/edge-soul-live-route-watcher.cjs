"use strict";

const { LiveSoulRelay } = require("./soul-relay-live.cjs");

const VERSION = "david-soul-live-route-watcher-v1.0.0";
const DEFAULT_SYNC_MS = 5000;

function parseInterval(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SYNC_MS;
  return Math.max(2000, Math.min(60000, parsed));
}

function normalizeRoute(route) {
  if (!route || typeof route !== "object") return null;
  const chatUrl = String(route.chat_url || route.chatUrl || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{36}$/i.test(chatUrl)) return null;
  const userId = String(route.user_id || route.userId || "").trim();
  return {
    ...route,
    user_id: userId || null,
    chat_url: chatUrl,
    route_label: String(route.route_label || route.routeLabel || "Personal Soul chat").trim().slice(0, 120),
    session_key: userId || String(route.route_id || route.id || chatUrl)
  };
}

function installLiveSoulRouteWatcher() {
  const prototype = LiveSoulRelay.prototype;
  if (prototype.__davidLiveRouteWatcherInstalled) {
    return { version: VERSION, installed: true, repeated_install: true };
  }

  const originalStart = prototype.start;
  const originalStop = prototype.stop;

  prototype.syncLiveRoutes = async function syncLiveRoutes({ silent = false } = {}) {
    if (!this.active || this.routeSyncBusy) return { ok: true, skipped: true };
    if (!this.bridge?.request) return { ok: false, skipped: true, reason: "bridge_missing" };
    if (!this.browser?.registerRoutes || !this.browser?.ensureReady || !this.browser?.sessions) {
      if (!this.routeWatcherCompatibilityReported) {
        this.routeWatcherCompatibilityReported = true;
        this.sendStatus?.(
          "DAVID live route watcher С‡Р°РєР° multi-session Edge РјРѕРґСѓР»Р°.",
          "warning"
        );
      }
      return { ok: false, skipped: true, reason: "multi_session_browser_missing" };
    }

    this.routeSyncBusy = true;
    try {
      const response = await this.bridge.request("list_chat_routes", {
        worker: VERSION
      });
      const routes = (Array.isArray(response?.routes) ? response.routes : [])
        .map(normalizeRoute)
        .filter(Boolean);

      const activeOwnerIds = new Set(routes.map((route) => route.user_id).filter(Boolean));

      for (const [key, session] of this.browser.sessions.entries()) {
        const ownerId = String(session?.route?.user_id || "").trim();
        if (!ownerId || !activeOwnerIds.has(ownerId)) continue;
        const next = routes.find((route) => route.user_id === ownerId);
        if (!next || String(session.url) === next.chat_url) continue;
        try { session.agent?.connection?.close?.(); } catch {}
        this.browser.readyPromises?.delete?.(key);
        this.browser.sessions.delete(key);
      }

      const beforeKeys = new Set(this.browser.sessions.keys());
      const registered = this.browser.registerRoutes(routes);
      const newSessions = registered.filter((session) => !beforeKeys.has(session.key));

      for (const session of newSessions) {
        Promise.resolve(this.browser.ensureReady(session.url))
          .then(() => {
            this.sendStatus?.(
              `DAVID РѕС‚РІРѕСЂРё РѕС‚РґРµР»РµРЅ Edge Р·Р° ${session.route?.route_label || session.sessionKey}.`,
              "ready"
            );
          })
          .catch((error) => {
            this.sendStatus?.(
              `РќРѕРІРёСЏС‚ Edge РјР°СЂС€СЂСѓС‚ ${session.route?.route_label || session.sessionKey} С‡Р°РєР° РІС…РѕРґ: ${error.message}`,
              "warning"
            );
          });
      }

      const signature = routes
        .map((route) => `${route.user_id || ""}|${route.chat_url}|${route.route_label}`)
        .sort()
        .join("\n");

      if (!silent && signature !== this.lastRouteSignature) {
        this.sendStatus?.(
          `DAVID СЃРёРЅС…СЂРѕРЅРёР·РёСЂР° ${routes.length} Р°РєС‚РёРІРЅРё GPT РјР°СЂС€СЂСѓС‚Р° В· ${newSessions.length} РЅРѕРІРё Edge РїСЂРѕС„РёР»Р°.`,
          "ready"
        );
      }
      this.lastRouteSignature = signature;
      this.lastRouteSyncAt = new Date().toISOString();

      return {
        ok: true,
        route_count: routes.length,
        new_session_count: newSessions.length,
        synced_at: this.lastRouteSyncAt
      };
    } catch (error) {
      if (!silent) {
        this.sendStatus?.(
          `DAVID РЅРµ СѓСЃРїСЏ РґР° СЃРёРЅС…СЂРѕРЅРёР·РёСЂР° РЅРѕРІРёС‚Рµ GPT РјР°СЂС€СЂСѓС‚Рё: ${error.message}`,
          "warning"
        );
      }
      return { ok: false, error: error.message };
    } finally {
      this.routeSyncBusy = false;
    }
  };

  prototype.startLiveRouteWatcher = function startLiveRouteWatcher() {
    if (this.routeWatcherTimer) return;
    this.routeWatcherIntervalMs = parseInterval(
      process.env.DAVID_SOUL_ROUTE_SYNC_MS
    );

    this.syncLiveRoutes({ silent: false }).catch(() => {});
    this.routeWatcherTimer = setInterval(() => {
      this.syncLiveRoutes({ silent: true }).catch(() => {});
    }, this.routeWatcherIntervalMs);
    this.routeWatcherTimer.unref?.();
  };

  prototype.stopLiveRouteWatcher = function stopLiveRouteWatcher() {
    clearInterval(this.routeWatcherTimer);
    this.routeWatcherTimer = null;
    this.routeSyncBusy = false;
  };

  prototype.start = async function startWithLiveRoutes(...args) {
    const result = await originalStart.apply(this, args);
    this.startLiveRouteWatcher();
    return {
      ...result,
      live_route_watcher: true,
      route_sync_ms: this.routeWatcherIntervalMs
    };
  };

  prototype.stop = function stopWithLiveRoutes(...args) {
    this.stopLiveRouteWatcher();
    return originalStop.apply(this, args);
  };

  Object.defineProperty(prototype, "__davidLiveRouteWatcherInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  return {
    version: VERSION,
    installed: true,
    sync_ms: parseInterval(process.env.DAVID_SOUL_ROUTE_SYNC_MS),
    hot_add_without_server_restart: true
  };
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`DAVID live route watcher self-test failed: ${message}`);
  };

  const valid = normalizeRoute({
    user_id: "6c22b881-f89f-4df5-9426-603d44569a93",
    chat_url: "https://chatgpt.com/c/6a740d71-3a64-83eb-8afd-bbf1fd114108",
    route_label: "MamaChat"
  });
  assert(valid?.session_key === "6c22b881-f89f-4df5-9426-603d44569a93", "stable owner session key");
  assert(valid?.route_label === "MamaChat", "route label preserved");
  assert(!normalizeRoute({ chat_url: "https://example.com/not-chatgpt" }), "invalid URL rejected");
  const installed = installLiveSoulRouteWatcher();
  assert(installed.installed, "watcher installs");
  assert(typeof LiveSoulRelay.prototype.syncLiveRoutes === "function", "sync method installed");
  return true;
}

module.exports = {
  DEFAULT_SYNC_MS,
  VERSION,
  installLiveSoulRouteWatcher,
  normalizeRoute,
  parseInterval,
  runSelfTest
};

if (require.main === module) {
  runSelfTest();
  console.log("DAVID LIVE ROUTE WATCHER SELF-TEST: PASS");
}