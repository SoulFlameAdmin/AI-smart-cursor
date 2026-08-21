"use strict";

const { LiveSoulRelay } = require("./soul-relay-live.cjs");

const VERSION = "david-soul-network-shield-v1.0.0";
const MAX_ATTEMPTS = 7;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(value) {
  return String(value ?? "").trim();
}

function operationName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
}

function isClaimOperation(operation) {
  const op = operationName(operation);
  return /(^|[_:-])(claim|enqueue|dequeue|reserve|lock)([_:-]|$)/.test(op) ||
    op.includes("claim_next") ||
    op.includes("claim_message");
}

function isRetryableOperation(operation) {
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

function errorText(error) {
  return clean(error?.message || error?.cause?.message || error || "");
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
    "socket hang up",
    "connection reset",
    "connection closed",
    "connection terminated",
    "und_err_connect_timeout",
    "und_err_socket"
  ].some((token) => text.includes(token));
}

function retryDelay(attempt) {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 180);
  return exponential + jitter;
}

function wrapBridge(relay) {
  const bridge = relay?.bridge;
  if (!bridge || typeof bridge.request !== "function") return false;
  if (bridge.__davidNetworkShieldV1) return true;

  const originalRequest = bridge.request.bind(bridge);

  bridge.request = async function davidNetworkShieldRequest(operation, payload, ...rest) {
    if (!isRetryableOperation(operation)) {
      return originalRequest(operation, payload, ...rest);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await originalRequest(operation, payload, ...rest);
      } catch (error) {
        lastError = error;
        if (isClaimLoss(error) || !isTransientNetworkError(error) || attempt >= MAX_ATTEMPTS) {
          throw error;
        }

        const delayMs = retryDelay(attempt);
        console.warn(
          `[DAVID SOUL NETWORK][RETRY] op=${operationName(operation) || "unknown"} ` +
          `attempt=${attempt}/${MAX_ATTEMPTS} delay_ms=${delayMs} error=${errorText(error)}`
        );
        await sleep(delayMs);
      }
    }

    throw lastError || new Error("DAVID network shield exhausted without a response.");
  };

  Object.defineProperty(bridge, "__davidNetworkShieldV1", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  return true;
}

function installDavidSoulNetworkShield() {
  if (typeof LiveSoulRelay !== "function") {
    throw new Error("DAVID Network Shield could not find LiveSoulRelay.");
  }

  const prototype = LiveSoulRelay.prototype;
  if (prototype.__davidSoulNetworkShieldV1Installed) {
    return { version: VERSION, installed: true, repeated_install: true };
  }

  const originalStart = prototype.start;
  if (typeof originalStart !== "function") {
    throw new Error("DAVID Network Shield requires LiveSoulRelay.start().");
  }

  prototype.start = async function davidNetworkShieldStart(...args) {
    wrapBridge(this);
    const result = await originalStart.apply(this, args);
    wrapBridge(this);
    return {
      ...(result && typeof result === "object" ? result : {}),
      network_shield: VERSION
    };
  };

  Object.defineProperty(prototype, "__davidSoulNetworkShieldV1Installed", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  return {
    version: VERSION,
    installed: true,
    retryable_safe_operations_only: true,
    claim_retry_forbidden: true,
    max_attempts: MAX_ATTEMPTS,
    max_delay_ms: MAX_DELAY_MS,
    transient_fetch_failure_nonfatal_within_retry_budget: true
  };
}

function runSelfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`DAVID Network Shield self-test failed: ${message}`);
  };

  assert(isClaimOperation("claim_message"), "claim operation detected");
  assert(!isRetryableOperation("claim_message"), "claim retry forbidden");
  assert(isRetryableOperation("progress_soul_message"), "progress retry enabled");
  assert(isRetryableOperation("heartbeat"), "heartbeat retry enabled");
  assert(isRetryableOperation("complete_message"), "completion retry enabled");
  assert(isRetryableOperation("list_chat_routes"), "route sync retry enabled");
  assert(isTransientNetworkError(new TypeError("fetch failed")), "fetch failure detected");
  assert(!isTransientNetworkError(new Error("message_not_claimed")), "claim loss is not network retry");

  const result = installDavidSoulNetworkShield();
  assert(result.claim_retry_forbidden, "claim protection exported");
  return result;
}

module.exports = {
  VERSION,
  MAX_ATTEMPTS,
  isClaimLoss,
  isClaimOperation,
  isRetryableOperation,
  isTransientNetworkError,
  installDavidSoulNetworkShield,
  retryDelay,
  runSelfTest,
  wrapBridge
};

if (require.main === module) {
  const result = runSelfTest();
  console.log("DAVID SOUL NETWORK SHIELD V1 SELF-TEST: PASS");
  console.log(JSON.stringify(result, null, 2));
}
