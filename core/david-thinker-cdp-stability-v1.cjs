"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  CdpConnection
} = require("./edge-cdp-soul-browser.cjs");

const VERSION = "david-thinker-cdp-stability-v1.2";
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

function normalizeWindowsCliScript(source, platform = process.platform) {
  const text = String(source || "");
  if (platform !== "win32" || !text) return text;

  let normalized = text;

  // DAVID_WINDOWS_CLI_NORMALIZATION_V1
  // PowerShell can resolve npm/npx differently depending on PATHEXT and how a
  // GPT-authored script invokes Start-Process. On Windows the actual launchers
  // installed by Node are npm.cmd and npx.cmd. Rewrite only command positions,
  // never arbitrary string contents, so Windows cannot open the "choose an app
  // to open npm" dialog during an unattended autonomous round.
  normalized = normalized.replace(
    /(\bStart-Process\s+(?:-FilePath\s+)?)(["']?)(npm|npx)\2(?=\s|$)/giu,
    (_match, prefix, quote, command) => `${prefix}${quote}${command}.cmd${quote}`
  );

  normalized = normalized.replace(
    /(^|[;{}\r\n]\s*)(&\s*)?(["']?)(npm|npx)\3(?=\s|$)/gimu,
    (_match, prefix, callOperator, quote, command) =>
      `${prefix}${callOperator || ""}${quote}${command}.cmd${quote}`
  );

  return normalized;
}

function isPowerShellCommand(command) {
  const base = path.basename(String(command || "")).toLowerCase();
  return new Set(["powershell.exe", "powershell", "pwsh.exe", "pwsh"]).has(base);
}

function installWindowsCliSpawnPatch() {
  if (process.platform !== "win32" || !isThinkerProcess()) {
    return {
      version: VERSION,
      installed: false,
      reason: "not-a-windows-thinker-process"
    };
  }

  if (childProcess.__davidWindowsCliSpawnPatchV1) {
    return {
      version: VERSION,
      installed: true,
      reused: true
    };
  }

  const originalSpawn = childProcess.spawn;
  Object.defineProperty(childProcess, "__davidWindowsCliSpawnPatchV1", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  childProcess.spawn = function davidWindowsCliSafeSpawn(command, args = [], options = {}) {
    try {
      if (isPowerShellCommand(command) && Array.isArray(args)) {
        const fileIndex = args.findIndex((value) => /^-file$/iu.test(String(value || "")));
        const scriptPath = fileIndex >= 0 ? String(args[fileIndex + 1] || "") : "";
        if (scriptPath && /\.ps1$/iu.test(scriptPath) && fs.existsSync(scriptPath)) {
          const before = fs.readFileSync(scriptPath, "utf8");
          const after = normalizeWindowsCliScript(before, "win32");
          if (after !== before) {
            fs.writeFileSync(scriptPath, after, "utf8");
          }
        }
      }
    } catch {
      // Never make the safety shim itself a new failure mode. The underlying
      // PowerShell process still runs and reports its real stdout/stderr/exit.
    }
    return originalSpawn.call(this, command, args, options);
  };

  return {
    version: VERSION,
    installed: true,
    normalized_commands: ["npm", "npx"]
  };
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
    if (OPTIONAL_COMMANDS.has(name)) {
      return Promise.resolve({
        david_optional_cdp_skipped: true,
        method: name
      });
    }

    // DAVID_THINKER_RUNTIME_EVALUATE_TIMEOUT_V1
    // Do not retry Runtime.evaluate because some expressions can intentionally
    // mutate the composer or press Send. Extend only the one real command.
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

const cliInstallation = installWindowsCliSpawnPatch();
const installation = installDavidThinkerCdpStabilityV1();

module.exports = {
  VERSION,
  OPTIONAL_COMMANDS,
  MIN_COMMAND_TIMEOUT_MS,
  cliInstallation,
  installation,
  installDavidThinkerCdpStabilityV1,
  installWindowsCliSpawnPatch,
  isPowerShellCommand,
  isThinkerProcess,
  normalizeWindowsCliScript
};
