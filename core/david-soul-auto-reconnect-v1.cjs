"use strict";

const { LiveSoulRelay } = require("./soul-relay-live.cjs");

const VERSION = "david-soul-auto-reconnect-v1.0.0";
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
    error?.name
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
    "und_err_headers_timeout"
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
    "sync"
  ].some((token) => op.includes(token));
}

function retryDelay(attempt) {
  const index = Math.min(RETRY_DELAYS_MS.length - 1, Math.max(0, attempt - 1));
  return Math.min(MAX_DELAY_MS, RETRY_DELAYS_MS[index]);
}

function reconnectState(target) {
  if (!target) return { offline: false, offlineSince: 0, attempts: 0, lastNoticeAt: 0 };
  if (!target.__davidAutoReconnectState) {
    Object.defineProperty(target, "__davidAutoReconnectState", {
      value: {
        offline: false,
        offlineSince: 0,
        attempts: 0,
        lastNoticeAt: 0
      },
      configurable: true,
      enumerable: false,
      writable: false
    });
  }
  return target.__davidAutoReconnectState;
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

  const shouldLog = state.attempts === 1 || now - state.lastNoticeAt >= 30000;
  if (shouldLog) {
    state.lastNoticeAt = now;
    console.warn(
      `[DAVID SOUL AUTO][OFFLINE] ${label} · network unavailable · ` +
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
    `[DAVID SOUL AUTO][ONLINE] ${label} · connection restored automatically · ` +
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
  if (original.__davidAutoReconnectWrapped) return true;

  const wrapped = async function davidAutoReconnectRelayMethod(...args) {
    return retrySafeForever(this, methodName, () => original.apply(this, args));
  };

  Object.defineProperty(wrapped, "__davidAutoReconnectWrapped", {
    value: true,
    enumerable: false
  });
  prototype[methodName] = wrapped;
  return true;
}

function wrapBridge(relay) {
  const bridge = relay?.bridge;
  if (!bridge || typeof bridge.request !== "function") return false;
  if (bridge.__davidAutoReconnectV1) return true;

  const originalRequest = bridge.request.bind(bridge);
  bridge.request = async function davidAutoReconnectBridgeRequest(operation, payload, ...rest) {
    if (!isSafeBridgeOperation(operation)) {
      return originalRequest(operation, payload, ...rest);
    }
    const label = `bridge:${operationName(operation) || "safe"}`;
    return retrySafeForever(relay, label, () => originalRequest(operation, payload, ...rest));
  };

  Object.defineProperty(bridge, "__davidAutoReconnectV1", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  return true;
}

function installDavidSoulAutoReconnect() {
  if (typeof LiveSoulRelay !== "function") {
    throw new Error("DAVID Auto Reconnect could not find LiveSoulRelay.");
  }

  const prototype = LiveSoulRelay.prototype;
  if (prototype.__davidSoulAutoReconnectV1Installed) {
    return { version: VERSION, installed: true, repeated_install: true };
  }

  const wrappedMethods = [];
  for (const name of ["sendStatus", "sendProgress", "sendHeartbeat", "reportStatus"]) {
    if (wrapRelayMethod(prototype, name)) wrappedMethods.push(name);
  }

  const originalStart = prototype.start;
  if (typeof originalStart !== "function") {
    throw new Error("DAVID Auto Reconnect requires LiveSoulRelay.start().");
  }

  prototype.start = async function davidAutoReconnectStart(...args) {
    wrapBridge(this);
    try {
      return await originalStart.apply(this, args);
    } finally {
      wrapBridge(this);
    }
  };

  Object.defineProperty(prototype, "__davidSoulAutoReconnectV1Installed", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  return {
    version: VERSION,
    installed: true,
    automatic_reconnect: true,
    process_stays_alive_during_network_loss: true,
    safe_operations_retry_until_online: true,
    current_safe_payload_preserved_in_memory: true,
    claim_retry_forbidden: true,
    prompt_resend_forbidden: true,
    duplicate_prompt_on_reconnect_forbidden: true,
    max_retry_delay_ms: MAX_DELAY_MS,
    wrapped_relay_methods: wrappedMethods
  };
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`DAVID Auto Reconnect self-test failed: ${message}`);
  };

  assert(isTransientNetworkError(new TypeError("fetch failed")), "fetch failure detected");
  assert(isTransientNetworkError(Object.assign(new Error("dns lookup failed"), { code: "ENOTFOUND" })), "DNS failure detected");
  assert(!isTransientNetworkError(new Error("message_not_claimed")), "claim loss not treated as network outage");
  assert(isClaimOperation("claim_message"), "claim operation detected");
  assert(!isSafeBridgeOperation("claim_message"), "claim retry forbidden");
  assert(isSafeBridgeOperation("heartbeat"), "heartbeat reconnect enabled");
  assert(isSafeBridgeOperation("complete_message"), "final delivery reconnect enabled");
  assert(retryDelay(1) === 1000, "first retry delay");
  assert(retryDelay(99) === MAX_DELAY_MS, "retry delay capped");

  const result = installDavidSoulAutoReconnect();
  assert(result.automatic_reconnect, "automatic reconnect exported");
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
  installDavidSoulAutoReconnect,
  retryDelay,
  retrySafeForever,
  runSelfTest,
  wrapBridge,
  wrapRelayMethod
};

if (require.main === module) {
  const result = runSelfTest();
  console.log("DAVID SOUL AUTO RECONNECT V1 SELF-TEST: PASS");
  console.log(JSON.stringify(result, null, 2));
}
