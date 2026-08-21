"use strict";

const {
  CdpConnection
} = require("./edge-cdp-soul-browser.cjs");

const VERSION = "david-thinker-cdp-stability-v1.1";
const OPTIONAL_COMMANDS = new Set([
  "Runtime.enable",
  "Page.enable",
  "Page.bringToFront"
]);
const MIN_COMMAND_TIMEOUT_MS = new Map([
  ["Runtime.evaluate", 60000]
]);

function isThinkerProcess(argv = process.argv) {
  return argv.some((value) =>
    /david-thinker-(?:worker|node-keeper)\.cjs$/iu.test(String(value || "").replace(/\\/g, "/"))
  );
}

function installDavidThinkerCdpStabilityV1() {
  if (!isThinkerProcess()) {
    return {
      version: VERSION,
      installed: false,
      reason: "not-a-thinker-process"
    };
  }

  if (CdpConnection.prototype.__davidThinkerCdpStabilityV1) {
    return {
      version: VERSION,
      installed: true,
      reused: true
    };
  }

  const originalSend = CdpConnection.prototype.send;

  Object.defineProperty(
    CdpConnection.prototype,
    "__davidThinkerCdpStabilityV1",
    {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    }
  );

  CdpConnection.prototype.send = function davidThinkerStableSend(
    method,
    params = {},
    timeoutMs = 15000
  ) {
    const name = String(method || "");

    // DAVID_THINKER_CDP_STABILITY_V1
    // Runtime.enable, Page.enable and Page.bringToFront are convenience/event
    // commands. The Teacher path uses direct Runtime.evaluate, Input.* and
    // Page.navigate commands and does not require these domains to be enabled.
    // On a heavy ChatGPT page Page.enable can stall long enough for the generic
    // watchdog to close the CDP websocket, which then kills the entire Teacher
    // round before Send. Skip only these optional commands in Thinker worker
    // processes; every state-changing/verification command still uses the real
    // CDP transport and keeps its timeout/error semantics.
    if (OPTIONAL_COMMANDS.has(name)) {
      return Promise.resolve({
        david_optional_cdp_skipped: true,
        method: name
      });
    }

    // DAVID_THINKER_RUNTIME_EVALUATE_TIMEOUT_V1
    // ChatGPT's page can be temporarily busy enough that a valid
    // Runtime.evaluate response arrives after the generic 15 second watchdog.
    // Do NOT retry Runtime.evaluate because some expressions can intentionally
    // mutate the composer or press Send. Only extend the single real command's
    // deadline so DAVID never duplicates a state-changing evaluation.
    const minimumTimeout = MIN_COMMAND_TIMEOUT_MS.get(name) || 0;
    const effectiveTimeoutMs = Math.max(
      Number(timeoutMs) || 15000,
      minimumTimeout
    );

    return originalSend.call(this, method, params, effectiveTimeoutMs);
  };

  return {
    version: VERSION,
    installed: true,
    optional_commands_skipped: [...OPTIONAL_COMMANDS],
    minimum_command_timeouts_ms: Object.fromEntries(MIN_COMMAND_TIMEOUT_MS)
  };
}

const installation = installDavidThinkerCdpStabilityV1();

module.exports = {
  VERSION,
  OPTIONAL_COMMANDS,
  MIN_COMMAND_TIMEOUT_MS,
  installation,
  installDavidThinkerCdpStabilityV1,
  isThinkerProcess
};
