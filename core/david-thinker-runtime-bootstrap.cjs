"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_THINKER_PORT = 9444;
const DEFAULT_THINKER_URL = "https://chatgpt.com/c/6a81285a-3e38-83ed-965a-b221453fb742";
const READY_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 750;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(value, max = 1500) {
  return String(value ?? "").trim().slice(0, max);
}

function thinkerPaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const runtimeRoot = path.join(root, ".david-instances", "david");
  const logsRoot = path.join(runtimeRoot, "logs");
  return {
    root,
    runtimeRoot,
    profileDir: path.join(runtimeRoot, "edge-soul-profile"),
    statusFile: path.join(runtimeRoot, "thinker-node-status.json"),
    pidFile: path.join(runtimeRoot, "thinker-node.pid"),
    stdoutLog: path.join(logsRoot, "thinker-node-out.log"),
    stderrLog: path.join(logsRoot, "thinker-node-error.log"),
    keeperFile: path.join(__dirname, "david-thinker-node-keeper.cjs")
  };
}

async function debuggerJson(port, pathname = "/json/list") {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    signal: AbortSignal.timeout(2500)
  });
  if (!response.ok) throw new Error(`Thinker debugger HTTP ${response.status}.`);
  return response.json();
}

function sameConversation(current, target) {
  try {
    const left = new URL(String(current || ""));
    const right = new URL(String(target || ""));
    return left.hostname === right.hostname &&
      left.pathname.replace(/\/$/, "") === right.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

async function thinkerReady({ port, chatUrl }) {
  try {
    const targets = await debuggerJson(port, "/json/list");
    return Array.isArray(targets) && targets.some((item) =>
      item?.type === "page" && sameConversation(item?.url, chatUrl)
    );
  } catch {
    return false;
  }
}

function readStatus(statusFile) {
  try {
    if (!fs.existsSync(statusFile)) return null;
    return JSON.parse(fs.readFileSync(statusFile, "utf8"));
  } catch {
    return null;
  }
}

function safeTail(filePath, maxChars = 4000) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const value = fs.readFileSync(filePath, "utf8");
    return value.slice(-maxChars)
      .replace(/(?i)(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/g, "$1=[REDACTED]");
  } catch {
    return "";
  }
}

function startKeeper({ projectRoot, nodeExecutable, chatUrl, port }) {
  const paths = thinkerPaths(projectRoot);
  for (const directory of [paths.runtimeRoot, paths.profileDir, path.dirname(paths.stdoutLog)]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const outFd = fs.openSync(paths.stdoutLog, "a");
  const errFd = fs.openSync(paths.stderrLog, "a");
  const child = spawn(nodeExecutable || process.execPath, [paths.keeperFile], {
    cwd: paths.root,
    detached: true,
    windowsHide: false,
    stdio: ["ignore", outFd, errFd],
    env: {
      ...process.env,
      DAVID_REPOSITORY_ROOT: paths.root,
      DAVID_TEACHER_CHAT_URL: chatUrl,
      DAVID_TEACHER_EDGE_PORT: String(port),
      DAVID_THINKER_PROFILE_DIR: paths.profileDir,
      DAVID_THINKER_STATUS_FILE: paths.statusFile
    }
  });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  fs.writeFileSync(paths.pidFile, String(child.pid), "ascii");
  return { child, paths };
}

async function ensureThinkerRuntime({
  projectRoot,
  sendStatus,
  nodeExecutable = process.env.DAVID_NODE_EXE || process.execPath,
  chatUrl = process.env.DAVID_TEACHER_CHAT_URL || DEFAULT_THINKER_URL,
  port = Number(process.env.DAVID_TEACHER_EDGE_PORT || DEFAULT_THINKER_PORT),
  timeoutMs = READY_TIMEOUT_MS
} = {}) {
  const root = path.resolve(projectRoot || path.resolve(__dirname, ".."));
  const normalizedPort = Number.isFinite(Number(port)) ? Number(port) : DEFAULT_THINKER_PORT;
  const paths = thinkerPaths(root);

  if (await thinkerReady({ port: normalizedPort, chatUrl })) {
    sendStatus?.(
      `DAVID Thinker ${normalizedPort} is already ready.`,
      "ready",
      { stage: "thinker_runtime_ready", port: normalizedPort }
    );
    return { ok: true, reused: true, port: normalizedPort, chat_url: chatUrl };
  }

  sendStatus?.(
    `DAVID starts the dedicated Thinker Node runtime on port ${normalizedPort}.`,
    "training",
    { stage: "thinker_runtime_starting", port: normalizedPort }
  );

  startKeeper({
    projectRoot: root,
    nodeExecutable,
    chatUrl,
    port: normalizedPort
  });

  const deadline = Date.now() + Math.max(30000, Number(timeoutMs) || READY_TIMEOUT_MS);
  let lastMessage = "";
  let lastState = "starting";

  while (Date.now() < deadline) {
    if (await thinkerReady({ port: normalizedPort, chatUrl })) {
      sendStatus?.(
        `DAVID Thinker ${normalizedPort} is ready for autonomous GPT rounds.`,
        "ready",
        { stage: "thinker_runtime_ready", port: normalizedPort }
      );
      return { ok: true, reused: false, port: normalizedPort, chat_url: chatUrl };
    }

    const status = readStatus(paths.statusFile);
    const state = clean(status?.state || "starting", 80);
    const message = clean(status?.message || "", 1000);
    if ((state !== lastState || message !== lastMessage) && message) {
      sendStatus?.(
        message,
        state === "error" ? "error" : state === "login_required" ? "warning" : "working",
        { stage: `thinker_${state}`, port: normalizedPort }
      );
      lastState = state;
      lastMessage = message;
    }
    if (state === "error") {
      throw new Error(`DAVID Thinker runtime failed: ${message || "unknown error"}`);
    }
    await sleep(POLL_MS);
  }

  const status = readStatus(paths.statusFile);
  const stderr = safeTail(paths.stderrLog, 3000);
  throw new Error(
    `DAVID Thinker ${normalizedPort} did not become ready within ${Math.round(timeoutMs / 1000)}s. ` +
    `state=${clean(status?.state || "unknown", 80)} ` +
    `message=${clean(status?.message || "", 1000)} ` +
    (stderr ? `stderr_tail=${stderr}` : "")
  );
}

module.exports = {
  DEFAULT_THINKER_PORT,
  DEFAULT_THINKER_URL,
  READY_TIMEOUT_MS,
  ensureThinkerRuntime,
  sameConversation,
  thinkerPaths,
  thinkerReady
};
