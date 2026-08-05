"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { EdgeSoulBrowserAgent } = require("./edge-cdp-soul-browser.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function encodePowerShell(script) {
  return Buffer.from(String(script || ""), "utf16le").toString("base64");
}

function quotePowerShell(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function findPowerShellExecutable() {
  if (process.platform !== "win32") return "";

  const candidates = [
    process.env.SystemRoot && path.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
    process.env.WINDIR && path.join(
      process.env.WINDIR,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
    process.env.ProgramFiles && path.join(
      process.env.ProgramFiles,
      "PowerShell",
      "7",
      "pwsh.exe"
    )
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function stopDedicatedEdgeProcesses(profileDir, debugPort) {
  if (process.platform !== "win32") return 0;

  const powerShellExe = findPowerShellExecutable();
  if (!powerShellExe) return 0;

  const profile = quotePowerShell(profileDir);
  const port = Number(debugPort) || 9333;
  const script = [
    `$profile = ${profile}`,
    `$debugFlag = '--remote-debugging-port=${port}'`,
    "$matches = @(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -ErrorAction SilentlyContinue | Where-Object {",
    "  $command = [string]$_.CommandLine",
    "  $command.Contains($profile) -or $command.Contains($debugFlag)",
    "})",
    "$matches | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "Start-Sleep -Milliseconds 800",
    "$lockNames = @('SingletonCookie','SingletonLock','SingletonSocket','DevToolsActivePort')",
    "$lockNames | ForEach-Object {",
    "  $lockPath = Join-Path $profile $_",
    "  Remove-Item -LiteralPath $lockPath -Force -Recurse -ErrorAction SilentlyContinue",
    "}",
    "[Console]::Out.Write($matches.Count)"
  ].join("; ");

  const result = spawnSync(
    powerShellExe,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000
    }
  );

  if (result.error || result.status !== 0) return 0;
  const count = Number.parseInt(String(result.stdout || "0").trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

function isRecoverableConnectionError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "debugger",
    "cdp",
    "websocket",
    "connection closed",
    "could not find the chatgpt tab",
    "did not expose the david debugging port",
    "target closed",
    "session closed"
  ].some((fragment) => message.includes(fragment));
}

function resetAgentConnection(agent) {
  try {
    agent.connection?.close?.();
  } catch {}
  agent.connection = null;
  agent.targetId = null;
  agent.edgeProcess = null;
}

function installEdgeSoulRecovery() {
  const prototype = EdgeSoulBrowserAgent.prototype;
  if (prototype.__davidEdgeRecoveryInstalled) {
    return {
      version: "david-soul-edge-recovery-v1.0.3",
      installed: true,
      repeated_install: true
    };
  }

  const originalEnsureEdge = prototype.ensureEdge;
  const originalConnect = prototype.connect;

  prototype.ensureEdge = async function resilientEnsureEdge() {
    try {
      return await originalEnsureEdge.call(this);
    } catch (firstError) {
      resetAgentConnection(this);
      const stoppedProcesses = stopDedicatedEdgeProcesses(this.profileDir, this.port);

      await this.showReport(
        "edge_recovery",
        "DAVID restarts only its dedicated Microsoft Edge controller and retries once.",
        {
          stopped_processes: stoppedProcesses,
          stale_profile_locks_removed: true,
          debug_address: `127.0.0.1:${this.port}`
        },
        "warning"
      ).catch(() => {});

      await sleep(1400);

      try {
        return await originalEnsureEdge.call(this);
      } catch (secondError) {
        const combined = new Error(
          "DAVID could not recover the dedicated Edge controller after one safe retry. " +
          String(secondError?.message || secondError || firstError)
        );
        combined.cause = secondError;
        throw combined;
      }
    }
  };

  prototype.connect = async function resilientConnect() {
    try {
      return await originalConnect.call(this);
    } catch (error) {
      if (!isRecoverableConnectionError(error)) throw error;
      resetAgentConnection(this);
      await sleep(350);
      return originalConnect.call(this);
    }
  };

  Object.defineProperty(prototype, "__davidEdgeRecoveryInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  return {
    version: "david-soul-edge-recovery-v1.0.3",
    installed: true,
    dedicated_edge_only: true,
    retry_count: 1,
    path_independent_powershell: true,
    stale_profile_lock_cleanup: true
  };
}

module.exports = {
  encodePowerShell,
  findPowerShellExecutable,
  installEdgeSoulRecovery,
  isRecoverableConnectionError,
  quotePowerShell,
  stopDedicatedEdgeProcesses
};