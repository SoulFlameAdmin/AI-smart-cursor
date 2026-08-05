"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { LiveSoulRelay } = require("./core/soul-relay-live.cjs");
const { EdgeSoulBrowserAgent } = require("./core/edge-cdp-soul-browser.cjs");
const {
  installReliableSoulSendConfirmation
} = require("./core/edge-soul-send-confirm-patch.cjs");
const {
  installEdgeSoulRecovery,
  stopDedicatedEdgeProcesses
} = require("./core/edge-soul-recovery-patch.cjs");

installReliableSoulSendConfirmation();
installEdgeSoulRecovery();

const ROOT = __dirname;
const INSTANCES_ROOT = path.join(ROOT, ".david-instances");
const BASE_ENV_FILE = path.join(ROOT, ".env");
const PID_FILE = path.join(INSTANCES_ROOT, "coordinator.pid");
const STATUS_FILE = path.join(INSTANCES_ROOT, "coordinator-status.json");
const BOOT_STAGGER_MS = 7000;
const SUPPORTED_KEYS = [
  "SUPABASE_URL",
  "DAVID_DEVICE_TOKEN",
  "DAVID_DEVICE_BRIDGE_FUNCTION",
  "DAVID_SOUL_CHAT_URL",
  "DAVID_SOUL_USER_ID",
  "DAVID_SOUL_POLL_MS",
  "DAVID_SOUL_RESPONSE_TIMEOUT_MS",
  "DAVID_SOUL_MAX_MESSAGE_CHARS",
  "DAVID_SOUL_BROWSER_VISIBLE"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;
let runtimes = [];

function readEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath));
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function preferredPort(name, index) {
  if (name === "mitko") return 9333;
  if (name === "borko") return 9444;
  return 9555 + index;
}

function validateInstance(name, config) {
  if (!config.SUPABASE_URL) throw new Error(`${name}: SUPABASE_URL липсва.`);
  if (!config.DAVID_DEVICE_TOKEN || config.DAVID_DEVICE_TOKEN.length < 32) {
    throw new Error(`${name}: DAVID_DEVICE_TOKEN липсва или е невалиден.`);
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(String(config.DAVID_SOUL_USER_ID || ""))) {
    throw new Error(`${name}: DAVID_SOUL_USER_ID не е валиден UUID.`);
  }
  if (!/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+(?:[/?#].*)?$/.test(
    String(config.DAVID_SOUL_CHAT_URL || "")
  )) {
    throw new Error(`${name}: фиксираният ChatGPT адрес липсва или е невалиден.`);
  }
}

function discoverInstanceSpecs() {
  const base = readEnvFile(BASE_ENV_FILE);
  const specs = [];

  specs.push({
    name: "mitko",
    config: { ...base },
    envFile: BASE_ENV_FILE,
    source: "primary"
  });

  if (fs.existsSync(INSTANCES_ROOT)) {
    const directories = fs.readdirSync(INSTANCES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.toLowerCase())
      .filter((name) => name !== "mitko")
      .sort();

    for (const name of directories) {
      if (!/^[a-z0-9_-]+$/.test(name)) continue;
      const envFile = path.join(INSTANCES_ROOT, name, "instance.env");
      if (!fs.existsSync(envFile)) continue;
      const local = readEnvFile(envFile);
      if (!parseBoolean(local.DAVID_SOUL_ENABLED, true)) continue;
      specs.push({
        name,
        config: { ...base, ...local },
        envFile,
        source: "instance"
      });
    }
  }

  return specs;
}

function withTemporaryEnvironment(values, factory) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined || value === null || value === "") delete process.env[name];
    else process.env[name] = String(value);
  }

  try {
    return factory();
  } finally {
    for (const [name, value] of previous.entries()) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function safeError(error) {
  return String(error?.message || error || "unknown error").slice(0, 1000);
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

function publicRuntimeState(runtime) {
  return {
    instance: runtime.name,
    state: runtime.state,
    port: runtime.port,
    profile_dir: runtime.profileDir,
    worker_active: Boolean(runtime.relay?.active),
    busy: Boolean(runtime.relay?.busy),
    retry_count: runtime.retryCount,
    retry_at: runtime.retryAt ? new Date(runtime.retryAt).toISOString() : null,
    last_message: runtime.lastMessage || "",
    last_error: runtime.lastError || null,
    updated_at: new Date().toISOString()
  };
}

function writeCoordinatorStatus() {
  writeJsonAtomic(STATUS_FILE, {
    mode: "node-multi-session",
    pid: process.pid,
    state: stopping ? "stopping" : "running",
    electron_used: false,
    instance_count: runtimes.length,
    instances: runtimes.map(publicRuntimeState),
    updated_at: new Date().toISOString()
  });
}

function createRuntime(spec, index) {
  const name = spec.name;
  const config = spec.config;
  validateInstance(name, config);

  const instanceRoot = path.join(INSTANCES_ROOT, name);
  const profileDir = path.join(instanceRoot, "edge-soul-profile");
  const statusFile = path.join(instanceRoot, "coordinator-instance-status.json");
  const configuredPort = Number.parseInt(config.DAVID_EDGE_DEBUG_PORT, 10);
  const port = Number.isFinite(configuredPort) && configuredPort >= 1024
    ? configuredPort
    : preferredPort(name, index);

  fs.mkdirSync(profileDir, { recursive: true });

  let runtime = null;
  const sendStatus = (message, kind = "info", meta = {}) => {
    if (!runtime) return;
    runtime.lastMessage = String(message || "").slice(0, 1000);
    if (kind === "error") runtime.lastError = runtime.lastMessage;
    const label = name.toUpperCase();
    console.log(`[${label}][${String(kind).toUpperCase()}] ${runtime.lastMessage}`);
    writeJsonAtomic(statusFile, {
      ...publicRuntimeState(runtime),
      kind,
      stage: String(meta?.stage || ""),
      details: meta?.details && typeof meta.details === "object"
        ? Object.fromEntries(Object.entries(meta.details).filter(([key]) =>
          !/token|secret|password|authorization|chat_url/i.test(key)
        ))
        : {}
    });
    writeCoordinatorStatus();
  };

  const environment = {};
  for (const key of SUPPORTED_KEYS) {
    if (config[key] !== undefined) environment[key] = config[key];
  }
  Object.assign(environment, {
    DAVID_SOUL_INSTANCE_ID: name,
    DAVID_SOUL_MULTI_INSTANCE: "1",
    DAVID_SOUL_AUTO_START: "false",
    DAVID_EDGE_DEBUG_PORT: String(port),
    DAVID_EDGE_PROFILE_DIR: profileDir
  });

  const constructed = withTemporaryEnvironment(environment, () => {
    const relay = new LiveSoulRelay({ BrowserWindow: null, sendStatus });
    const browser = new EdgeSoulBrowserAgent({
      sendStatus,
      chatUrl: config.DAVID_SOUL_CHAT_URL,
      rootDir: ROOT
    });
    relay.browser = browser;
    return { relay, browser };
  });

  runtime = {
    name,
    source: spec.source,
    envFile: spec.envFile,
    config,
    port,
    profileDir,
    statusFile,
    relay: constructed.relay,
    browser: constructed.browser,
    state: "created",
    booting: false,
    retryCount: 0,
    retryAt: 0,
    lastMessage: "",
    lastError: null
  };

  return runtime;
}

async function bootRuntime(runtime) {
  if (stopping || runtime.booting || runtime.relay.active) return;
  runtime.booting = true;
  runtime.state = "starting";
  runtime.lastError = null;
  writeCoordinatorStatus();

  try {
    console.log(`\n[${runtime.name.toUpperCase()}] Стартирам отделната Edge сесия на порт ${runtime.port}.`);
    await runtime.browser.openIfNeeded(runtime.config.DAVID_SOUL_CHAT_URL);
    await runtime.relay.start();
    runtime.state = "ready";
    runtime.retryCount = 0;
    runtime.retryAt = 0;
    runtime.lastMessage = "DAVID SOUL сесията е активна и чака съобщения.";
    writeCoordinatorStatus();
  } catch (error) {
    runtime.state = "error";
    runtime.lastError = safeError(error);
    runtime.retryCount += 1;
    const retryDelay = Math.min(60000, 10000 * runtime.retryCount);
    runtime.retryAt = Date.now() + retryDelay;
    console.error(`[${runtime.name.toUpperCase()}][ERROR] ${runtime.lastError}`);
    writeCoordinatorStatus();
  } finally {
    runtime.booting = false;
  }
}

async function shutdown(reason = "stop") {
  if (stopping) return;
  stopping = true;
  console.log(`\n[DAVID] Спирам координатора: ${reason}`);

  for (const runtime of runtimes) {
    try { runtime.relay.stop(); } catch {}
    try { runtime.browser.connection?.close?.(); } catch {}
    try { stopDedicatedEdgeProcesses(runtime.profileDir, runtime.port); } catch {}
    runtime.state = "stopped";
  }

  writeCoordinatorStatus();
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
}

async function main() {
  if (typeof fetch !== "function" || typeof WebSocket !== "function") {
    throw new Error("DAVID Node coordinator изисква Node.js 22 или по-нова версия.");
  }
  if (!fs.existsSync(BASE_ENV_FILE)) throw new Error("Липсва основният .env файл.");

  fs.mkdirSync(INSTANCES_ROOT, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), "ascii");

  const specs = discoverInstanceSpecs();
  runtimes = specs.map(createRuntime);
  if (runtimes.length === 0) throw new Error("Няма конфигурирани DAVID SOUL сесии.");

  console.log("============================================================");
  console.log("  DAVID SOUL LIGHT COORDINATOR");
  console.log("============================================================");
  console.log(`  Process       : Node PID ${process.pid}`);
  console.log("  Electron      : disabled / not used");
  console.log(`  Sessions      : ${runtimes.map((item) => item.name.toUpperCase()).join(", ")}`);
  console.log("  Isolation     : separate owner, token, Edge profile, port and fixed chat");
  console.log("  Startup       : staggered to reduce CPU/RAM spikes");
  console.log("============================================================");
  writeCoordinatorStatus();

  for (const runtime of runtimes) {
    void bootRuntime(runtime);
    await sleep(BOOT_STAGGER_MS);
  }

  while (!stopping) {
    const now = Date.now();
    for (const runtime of runtimes) {
      if (
        runtime.state === "error" &&
        !runtime.booting &&
        !runtime.relay.active &&
        runtime.retryAt > 0 &&
        runtime.retryAt <= now
      ) {
        void bootRuntime(runtime);
      }
    }
    writeCoordinatorStatus();
    await sleep(2000);
  }
}

process.on("SIGINT", () => { void shutdown("Ctrl+C").then(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdown("SIGTERM").then(() => process.exit(0)); });
process.on("uncaughtException", (error) => {
  console.error(`[DAVID][FATAL] ${safeError(error)}`);
  void shutdown("uncaughtException").then(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  console.error(`[DAVID][FATAL] ${safeError(error)}`);
  void shutdown("unhandledRejection").then(() => process.exit(1));
});

main().catch(async (error) => {
  console.error(`[DAVID][FATAL] ${safeError(error)}`);
  await shutdown("startup_failed");
  process.exit(1);
});
