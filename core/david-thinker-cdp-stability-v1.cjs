"use strict";

const {
  CdpConnection
} = require("./edge-cdp-soul-browser.cjs");

const VERSION = "david-thinker-cdp-stability-v1";
const OPTIONAL_COMMANDS = new Set([
  "Runtime.enable",
  "Page.enable",
  "Page.bringToFront"
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

    return originalSend.call(this, method, params, timeoutMs);
  };

  return {
    version: VERSION,
    installed: true,
    optional_commands_skipped: [...OPTIONAL_COMMANDS]
  };
}

const installation = installDavidThinkerCdpStabilityV1();

module.exports = {
  VERSION,
  OPTIONAL_COMMANDS,
  installation,
  installDavidThinkerCdpStabilityV1,
  isThinkerProcess
};
