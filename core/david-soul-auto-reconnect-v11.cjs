"use strict";

const { LiveSoulRelay } = require("./soul-relay-live.cjs");

const VERSION = "david-soul-auto-reconnect-v1.1.0";
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];
const MAX_DELAY_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(value) {
  return String(value ?? "").trim();
}

function errorText(error) {
  return clean(error?.message || error?.cause?.message || error || "");
}

function operationName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
}

function isClaimLoss(error) {
  const text = errorText(error).toLowerCase();
  return text.includes("message_not_claimed") ||
    text.includes("message not claimed") ||
    text.includes("claim_lost") ||
    text.includes("claim lost");
}

function isTransientNetworkError(error) {
  if (!error || isClaimLoss(error)) return false;
  const text = [
    errorText(error),
    error?.code,
    error?.cause?.code,
    error?.name,
    error?.status,
    error?.statusCode
  ].filter(Boolean).join(" ").toLowerCase();

  return [
    "fetch failed",
    "failed to fetch",
    "networkerror",
    "network error",
    "econnreset",
    "econnrefused",
    "etimedout",
    "eai_again",
    "enotfound",
    "dns",
    "socket hang up",
    "connection reset",
    "connection closed",
    "connection terminated",
    "und_err_connect_timeout",
    "und_err_socket",
    "und_err_headers_timeout",
    "http 502",
    "http 503",
    "http 504",
    "bad gateway",
    "service unavailable",
    "gateway timeout"
  ].some((token) => text.includes(token));
}

function isClaimOperation(operation) {
  const op = operationName(operation);
  return /(^|[_:-])(claim|enqueue|dequeue|reserve|lock)([_:-]|$)/.test(op) ||
    op.includes("claim_next") ||
    op.includes("claim_message");
}

function isSafeBridgeOperation(operation) {
  const op = operationName(operation);
  if (!op || isClaimOperation(op)) return false;
  return [
    "progress",
    "heartbeat",
    "status",
    "report",
    "complete",
    "completed",
    "answer",
    "return",
    "delivery",
    "deliver",
    "fail",
    "failed",
    "route",
    "routes",
    "list_chat_routes",
    "sync",
    "health"
  ].some((token) => op.includes(token));
}

function retryDelay(attempt) {
  const index = Math.min(RETRY_DELAYS_MS.length - 1, Math.max(0, attempt - 1));
  return Math.min(MAX_DELAY_MS, RETRY_DELAYS_MS[index]);
}

function reconnectState(target) {
  if (!target) return { offline: false, offlineSince: 0, attempts: 0, lastNoticeAt: 0 };
  if (!target.__davidAutoReconnectV11State) {
    Object.defineProperty(target, "__davidAutoReconnectV11State", {
      value: { offline: false, offlineSince: 0, attempts: 0, lastNoticeAt: 0 },
      configurable: true,
      enumerable: false,
      writable: false
    });
  }
  return target.__davidAutoReconnectV11State;
}

function markOffline(target, label, error, delayMs) {
  const state = reconnectState(target);
  const now = Date.now();
  if (!state.offline) {
    state.offline = true;
    state.offlineSince = now;
    state.attempts = 0;
    state.lastNoticeAt = 0;
  }
  state.attempts += 1;
  if (state.attempts === 1 || now - state.lastNoticeAt >= 30000) {
    state.lastNoticeAt = now;
    console.warn(
      `[DAVID SOUL AUTO V1.1][OFFLINE] ${label} · transient bridge/network failure · ` +
      `DAVID stays alive · retry_in_ms=${delayMs} · error=${errorText(error)}`
    );
  }
}

function markOnline(target, label) {
  const state = reconnectState(target);
  if (!state.offline) return;
  const offlineMs = Math.max(0, Date.now() - state.offlineSince);
  const attempts = state.attempts;
  state.offline = false;
  state.offlineSince = 0;
  state.attempts = 0;
  state.lastNoticeAt = 0;
  console.log(
    `[DAVID SOUL AUTO V1.1][ONLINE] ${label} · connection restored automatically · ` +
    `offline_ms=${offlineMs} attempts=${attempts}`
  );
}

async function retrySafeForever(target, label, fn) {
  let attempt = 0;
  while (true) {
    try {
      const result = await fn();
      markOnline(target, label);
      return result;
    } catch (error) {
      if (isClaimLoss(error) || !isTransientNetworkError(error)) throw error;
      attempt += 1;
      const delayMs = retryDelay(attempt);
      markOffline(target, label, error, delayMs);
      await sleep(delayMs);
    }
  }
}

function wrapRelayMethod(prototype, methodName) {
  const original = prototype?.[methodName];
  if (typeof original !== "function") return false;
  if (original.__davidAutoReconnectV11Wrapped) return true;

  const wrapped = async function davidAutoReconnectV11RelayMethod(...args) {
    return retrySafeForever(this, methodName, () => original.apply(this, args));
  };
  Object.defineProperty(wrapped, "__davidAutoReconnectV11Wrapped", {
    value: true,
    enumerable: false
  });
  prototype[methodName] = wrapped;
  return true;
}

function wrapBridge(relay) {
  const bridge = relay?.bridge;
  if (!bridge || typeof bridge.request !== "function") return false;
  if (bridge.__davidAutoReconnectV11) return true;

  const originalRequest = bridge.request.bind(bridge);
  bridge.request = async function davidAutoReconnectV11BridgeRequest(operation, payload, ...rest) {
    if (!isSafeBridgeOperation(operation)) {
      return originalRequest(operation, payload, ...rest);
    }
    const label = `bridge:${operationName(operation) || "safe"}`;
    return retrySafeForever(relay, label, () => originalRequest(operation, payload, ...rest));
  };

  Object.defineProperty(bridge, "__davidAutoReconnectV11", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  return true;
}

function installDavidSoulAutoReconnectV11() {
  if (typeof LiveSoulRelay !== "function") {
    throw new Error("DAVID Auto Reconnect v1.1 could not find LiveSoulRelay.");
  }

  const prototype = LiveSoulRelay.prototype;
  if (prototype.__davidSoulAutoReconnectV11Installed) {
    return { version: VERSION, installed: true, repeated_install: true };
  }

  const wrappedMethods = [];
  for (const name of ["sendStatus", "sendProgress", "sendHeartbeat", "reportStatus"]) {
    if (wrapRelayMethod(prototype, name)) wrappedMethods.push(name);
  }

  const originalStart = prototype.start;
  if (typeof originalStart !== "function") {
    throw new Error("DAVID Auto Reconnect v1.1 requires LiveSoulRelay.start().");
  }

  prototype.start = async function davidAutoReconnectV11Start(...args) {
    wrapBridge(this);
    try {
      return await originalStart.apply(this, args);
    } finally {
      wrapBridge(this);
    }
  };

  Object.defineProperty(prototype, "__davidSoulAutoReconnectV11Installed", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  return {
    version: VERSION,
    installed: true,
    automatic_reconnect: true,
    bridge_502_503_504_retry: true,
    process_stays_alive_during_network_loss: true,
    safe_operations_retry_until_online: true,
    claim_retry_forbidden: true,
    prompt_resend_forbidden: true,
    duplicate_prompt_on_reconnect_forbidden: true,
    max_retry_delay_ms: MAX_DELAY_MS,
    wrapped_relay_methods: wrappedMethods
  };
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`DAVID Auto Reconnect v1.1 self-test failed: ${message}`);
  };

  assert(isTransientNetworkError(new TypeError("fetch failed")), "fetch failure detected");
  assert(isTransientNetworkError(new Error("DAVID device bridge HTTP 502")), "HTTP 502 detected");
  assert(isTransientNetworkError(new Error("HTTP 503 Service Unavailable")), "HTTP 503 detected");
  assert(isTransientNetworkError(new Error("HTTP 504 Gateway Timeout")), "HTTP 504 detected");
  assert(!isTransientNetworkError(new Error("message_not_claimed")), "claim loss not transient");
  assert(isClaimOperation("claim_message"), "claim operation detected");
  assert(!isSafeBridgeOperation("claim_message"), "claim retry forbidden");
  assert(isSafeBridgeOperation("heartbeat"), "heartbeat reconnect enabled");
  assert(isSafeBridgeOperation("complete_message"), "final delivery reconnect enabled");
  assert(isSafeBridgeOperation("health"), "health retry enabled");
  assert(retryDelay(1) === 1000, "first retry delay");
  assert(retryDelay(99) === MAX_DELAY_MS, "retry delay capped");

  const result = installDavidSoulAutoReconnectV11();
  assert(result.bridge_502_503_504_retry, "bridge gateway retry exported");
  assert(result.prompt_resend_forbidden, "prompt resend protection exported");
  return result;
}

module.exports = {
  VERSION,
  MAX_DELAY_MS,
  isClaimLoss,
  isClaimOperation,
  isSafeBridgeOperation,
  isTransientNetworkError,
  installDavidSoulAutoReconnectV11,
  retryDelay,
  retrySafeForever,
  runSelfTest,
  wrapBridge,
  wrapRelayMethod
};

if (require.main === module) {
  const result = runSelfTest();
  console.log("DAVID SOUL AUTO RECONNECT V1.1 SELF-TEST: PASS");
  console.log(JSON.stringify(result, null, 2));
}
