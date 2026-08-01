$ErrorActionPreference = "Stop"

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
$Main = Join-Path $Project "main.cjs"
$Preload = Join-Path $Project "preload.cjs"
$RendererDir = Join-Path $Project "renderer"
$Renderer = Join-Path $RendererDir "renderer.js"
$Styles = Join-Path $RendererDir "styles.css"
$Index = Join-Path $RendererDir "index.html"

if (-not (Test-Path $Project)) {
    throw "Не намирам проекта: $Project"
}

foreach ($Required in @($Main, $Preload, $RendererDir)) {
    if (-not (Test-Path $Required)) {
        throw "Липсва: $Required"
    }
}

Set-Location $Project

Write-Host ""
Write-Host "=== DAVID OVERLAY V2: EXACT + FAST + STABLE ===" -ForegroundColor Cyan
Write-Host "Спирам старите DAVID процеси..." -ForegroundColor Yellow

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 600

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Backup = Join-Path $Project "backup-overlay-v2-$Stamp"
New-Item -ItemType Directory -Path $Backup -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Backup "renderer") -Force | Out-Null

Copy-Item $Main (Join-Path $Backup "main.cjs") -Force
Copy-Item $Preload (Join-Path $Backup "preload.cjs") -Force
if (Test-Path $Renderer) {
    Copy-Item $Renderer (Join-Path $Backup "renderer\renderer.js") -Force
}
if (Test-Path $Styles) {
    Copy-Item $Styles (Join-Path $Backup "renderer\styles.css") -Force
}
if (Test-Path $Index) {
    Copy-Item $Index (Join-Path $Backup "renderer\index.html") -Force
}

Write-Host "Backup: $Backup" -ForegroundColor DarkGray

$MainCode = @'
"use strict";

require("dotenv").config();

const path = require("path");
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  dialog,
  shell,
  Notification
} = require("electron");

// DAVID използва software rendering за стабилен прозрачен overlay.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const { loadConfig } = require("./core/config.cjs");
const { LocalStore } = require("./core/local-store.cjs");
const { ActionExecutor } = require("./core/action-executor.cjs");
const { TeacherClient } = require("./core/teacher-client.cjs");
const { SkillEngine } = require("./core/skill-engine.cjs");

const overlays = new Map();

let pointerTimer = null;
let rebuildTimer = null;
let commandPanelState = null;
let commandPanelOpen = false;
let appIsQuitting = false;
let store = null;
let teacher = null;
let skillEngine = null;

function displayKey(displayOrId) {
  return String(
    typeof displayOrId === "object" ? displayOrId.id : displayOrId
  );
}

function getOverlayForCursor() {
  if (!screen) return null;

  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  return overlays.get(displayKey(display)) || null;
}

function getPrimaryOverlay() {
  const primary = screen.getPrimaryDisplay();
  return overlays.get(displayKey(primary)) || null;
}

function safeSend(state, channel, payload) {
  if (
    !state ||
    !state.ready ||
    !state.window ||
    state.window.isDestroyed() ||
    !state.window.webContents ||
    state.window.webContents.isDestroyed()
  ) {
    return false;
  }

  try {
    state.window.webContents.send(channel, payload);
    return true;
  } catch (error) {
    state.ready = false;

    if (process.env.DAVID_DEV === "1") {
      console.warn(`DAVID safeSend skipped: ${error.message}`);
    }

    return false;
  }
}

function sendStatus(message, kind = "info") {
  const state =
    commandPanelState ||
    getOverlayForCursor() ||
    getPrimaryOverlay();

  safeSend(state, "david:status", { message, kind });
}

function createOverlay(display) {
  const bounds = display.bounds;

  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    useContentSize: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    backgroundColor: "#00000000",
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  const state = {
    id: displayKey(display),
    display,
    window,
    ready: false,
    recoveryAttempts: 0
  };

  overlays.set(state.id, state);

  window.setBounds(bounds, false);
  window.setAlwaysOnTop(true, "screen-saver");
  window.setSkipTaskbar(true);
  window.setIgnoreMouseEvents(true, { forward: true });

  try {
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    });
  } catch {
    // На Windows тази настройка може да няма ефект.
  }

  window.webContents.on("did-start-loading", () => {
    state.ready = false;
  });

  window.webContents.on("did-finish-load", () => {
    state.ready = true;
    state.recoveryAttempts = 0;

    safeSend(state, "david:display", {
      id: display.id,
      bounds,
      scaleFactor: display.scaleFactor
    });

    window.setBounds(bounds, false);
    window.showInactive();
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    state.ready = false;

    console.error(
      `DAVID renderer stopped on display ${state.id}: ` +
      `${details.reason}; exitCode=${details.exitCode}`
    );

    if (
      appIsQuitting ||
      window.isDestroyed() ||
      details.reason === "clean-exit"
    ) {
      return;
    }

    state.recoveryAttempts += 1;

    if (state.recoveryAttempts > 3) {
      console.error(
        `DAVID renderer recovery limit reached on display ${state.id}.`
      );
      return;
    }

    setTimeout(() => {
      if (
        appIsQuitting ||
        window.isDestroyed() ||
        window.webContents.isDestroyed()
      ) {
        return;
      }

      window.reload();
    }, 1000);
  });

  window.on("unresponsive", () => {
    if (!appIsQuitting && !window.isDestroyed()) {
      window.reload();
    }
  });

  window.on("closed", () => {
    state.ready = false;

    if (commandPanelState === state) {
      commandPanelState = null;
      commandPanelOpen = false;
    }

    overlays.delete(state.id);
  });

  window.loadFile(path.join(__dirname, "renderer", "index.html"));

  if (process.env.DAVID_DEV === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }

  return state;
}

function destroyOverlays() {
  for (const state of overlays.values()) {
    state.ready = false;

    if (state.window && !state.window.isDestroyed()) {
      state.window.destroy();
    }
  }

  overlays.clear();
  commandPanelState = null;
  commandPanelOpen = false;
}

function buildOverlays() {
  destroyOverlays();

  for (const display of screen.getAllDisplays()) {
    createOverlay(display);
  }
}

function scheduleOverlayRebuild() {
  clearTimeout(rebuildTimer);

  rebuildTimer = setTimeout(() => {
    if (!appIsQuitting) {
      buildOverlays();
    }
  }, 350);
}

function startPointerLoop() {
  if (pointerTimer) {
    clearInterval(pointerTimer);
    pointerTimer = null;
  }

  let previousDisplayId = null;
  let previousX = Number.NaN;
  let previousY = Number.NaN;

  pointerTimer = setInterval(() => {
    if (appIsQuitting || overlays.size === 0) return;

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const state = overlays.get(displayKey(display));

    if (!state || !state.window || state.window.isDestroyed()) return;

    const bounds = state.window.getBounds();
    const localX = cursor.x - bounds.x;
    const localY = cursor.y - bounds.y;

    if (previousDisplayId !== state.id) {
      const previousState = overlays.get(previousDisplayId);

      if (previousState) {
        safeSend(previousState, "david:pointer-active", {
          active: false
        });
      }

      safeSend(state, "david:pointer-active", {
        active: true
      });

      previousDisplayId = state.id;
      previousX = Number.NaN;
      previousY = Number.NaN;
    }

    if (localX === previousX && localY === previousY) return;

    previousX = localX;
    previousY = localY;

    safeSend(state, "david:pointer", {
      x: localX,
      y: localY,
      timestamp: Date.now()
    });
  }, 8);
}

function closeCommandPanel() {
  commandPanelOpen = false;

  for (const state of overlays.values()) {
    safeSend(state, "david:command-panel", { open: false });

    if (state.window && !state.window.isDestroyed()) {
      state.window.setIgnoreMouseEvents(true, { forward: true });
      state.window.setFocusable(false);
      state.window.showInactive();
    }
  }

  commandPanelState = null;
}

function openCommandPanel() {
  closeCommandPanel();

  const state = getOverlayForCursor() || getPrimaryOverlay();
  if (!state || !state.window || state.window.isDestroyed()) return;

  commandPanelOpen = true;
  commandPanelState = state;

  state.window.setFocusable(true);
  state.window.setIgnoreMouseEvents(false);
  state.window.show();
  state.window.focus();

  safeSend(state, "david:command-panel", { open: true });
}

function toggleCommandPanel() {
  if (commandPanelOpen) {
    closeCommandPanel();
  } else {
    openCommandPanel();
  }
}

async function confirmAction(details) {
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "DAVID иска разрешение",
    message: details.title || "Разрешаваш ли това действие?",
    detail: details.detail || "",
    buttons: ["Откажи", "Разреши"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });

  return result.response === 1;
}

function getRuntimeContext(config) {
  return {
    platform: process.platform,
    electron_version: process.versions.electron,
    locale: app.getLocale(),
    native_actions_enabled: config.nativeActionsEnabled,
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      scale_factor: display.scaleFactor,
      rotation: display.rotation
    }))
  };
}

async function bootstrap() {
  const config = loadConfig();

  store = new LocalStore(app.getPath("userData"));

  const executor = new ActionExecutor({
    BrowserWindow,
    shell,
    Notification,
    confirmAction,
    nativeActionsEnabled: config.nativeActionsEnabled,
    sendStatus
  });

  teacher = new TeacherClient({
    config,
    store,
    sendStatus
  });

  skillEngine = new SkillEngine({
    store,
    teacher,
    executor,
    maxAttempts: config.maxTrainingAttempts,
    sendStatus,
    contextProvider: () => getRuntimeContext(config)
  });

  await teacher.initialize(async ({ job, skill }) => {
    await skillEngine.executeRemoteJob(job, skill);
  });

  const remoteSkills = await teacher.fetchVerifiedSkills();

  for (const skill of remoteSkills) {
    store.upsertSkill(skill);
  }

  buildOverlays();
  startPointerLoop();

  screen.on("display-added", scheduleOverlayRebuild);
  screen.on("display-removed", scheduleOverlayRebuild);
  screen.on("display-metrics-changed", scheduleOverlayRebuild);

  const shortcutRegistered = globalShortcut.register(
    "CommandOrControl+Shift+D",
    toggleCommandPanel
  );

  if (!shortcutRegistered) {
    sendStatus(
      "Ctrl+Shift+D е заета от друга програма.",
      "warning"
    );
  }

  ipcMain.handle("david:submit-command", async (_event, command) => {
    const text = String(command || "").trim();

    if (!text) {
      return { ok: false, message: "Напиши команда." };
    }

    closeCommandPanel();

    try {
      return await skillEngine.handleCommand(text);
    } catch (error) {
      sendStatus(`Грешка: ${error.message}`, "error");
      return { ok: false, message: error.message };
    }
  });

  ipcMain.on("david:hide-command-panel", closeCommandPanel);

  ipcMain.handle("david:get-info", () => ({
    mode: teacher.isConnected()
      ? "supabase-teacher"
      : "local-demo",
    hotkey: "Ctrl+Shift+D",
    nativeActionsEnabled: config.nativeActionsEnabled,
    overlayVersion: "2.0-exact"
  }));

  sendStatus(
    "DAVID Overlay v2 е активен · Ctrl+Shift+D",
    "ready"
  );
}

app.whenReady().then(bootstrap).catch((error) => {
  console.error(error);
  dialog.showErrorBox(
    "DAVID не можа да стартира",
    error.stack || error.message
  );
  app.quit();
});

app.on("will-quit", () => {
  appIsQuitting = true;

  clearTimeout(rebuildTimer);

  if (pointerTimer) {
    clearInterval(pointerTimer);
    pointerTimer = null;
  }

  globalShortcut.unregisterAll();

  if (teacher) {
    teacher.dispose();
  }

  destroyOverlays();
});

app.on("window-all-closed", () => {
  if (!appIsQuitting) {
    app.quit();
  }
});
'@

$PreloadCode = @'
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);

  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("david", {
  submitCommand: (command) =>
    ipcRenderer.invoke("david:submit-command", command),

  getInfo: () =>
    ipcRenderer.invoke("david:get-info"),

  hideCommandPanel: () =>
    ipcRenderer.send("david:hide-command-panel"),

  onPointer: (callback) =>
    subscribe("david:pointer", callback),

  onPointerActive: (callback) =>
    subscribe("david:pointer-active", callback),

  onDisplay: (callback) =>
    subscribe("david:display", callback),

  onStatus: (callback) =>
    subscribe("david:status", callback),

  onCommandPanel: (callback) =>
    subscribe("david:command-panel", callback)
});
'@

$IndexCode = @'
<!DOCTYPE html>
<html lang="bg">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0, maximum-scale=1.0"
  >
  <title>DAVID Smart Cursor</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <canvas id="trail"></canvas>

  <div id="status" class="status status--hidden">
    <span class="status__dot"></span>
    <span id="statusText">DAVID е активен</span>
  </div>

  <section
    id="commandPanel"
    class="command-panel command-panel--hidden"
  >
    <div class="command-panel__label">DAVID COMMAND</div>

    <form id="commandForm">
      <input
        id="commandInput"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="Кажи какво да направя..."
      >
      <button type="submit">Изпълни</button>
    </form>

    <div id="modeText" class="command-panel__hint">
      Зареждане...
    </div>

    <div class="command-panel__hint">
      Esc за затваряне · Ctrl+Shift+D за отваряне
    </div>
  </section>

  <script src="./renderer.js"></script>
</body>
</html>
'@

$StylesCode = @'
:root {
  color-scheme: dark;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

* {
  box-sizing: border-box;
}

html,
body {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  min-width: 100vw;
  min-height: 100vh;
  padding: 0;
  margin: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: transparent !important;
  user-select: none;
}

body {
  isolation: isolate;
}

#trail {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: block;
  width: 100vw;
  height: 100vh;
  margin: 0;
  padding: 0;
  opacity: 1;
  background: transparent !important;
  pointer-events: none;
  transition: opacity 60ms linear;
}

#trail[data-active="false"] {
  opacity: 0;
}

.status {
  position: fixed;
  z-index: 2147483600;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: min(720px, calc(100vw - 40px));
  padding: 10px 15px;
  border: 1px solid rgba(255, 255, 255, 0.17);
  border-radius: 999px;
  color: rgba(255, 255, 255, 0.96);
  background: rgba(10, 12, 18, 0.76);
  box-shadow: 0 12px 35px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(18px);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.01em;
  pointer-events: none;
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.status--hidden {
  opacity: 0;
  transform: translate(-50%, -10px);
}

.status__dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
  background: #7cf7ae;
  box-shadow: 0 0 14px currentColor;
}

.status[data-kind="error"] .status__dot {
  background: #ff7272;
}

.status[data-kind="warning"] .status__dot {
  background: #ffd66d;
}

.status[data-kind="training"] .status__dot,
.status[data-kind="working"] .status__dot {
  background: #7dc7ff;
  animation: pulse 900ms infinite alternate;
}

.command-panel {
  position: fixed;
  z-index: 2147483640;
  top: 50%;
  left: 50%;
  width: min(720px, calc(100vw - 48px));
  transform: translate(-50%, -50%);
  padding: 22px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 25px;
  background:
    radial-gradient(
      circle at 50% 0%,
      rgba(61, 122, 255, 0.22),
      transparent 52%
    ),
    rgba(8, 10, 16, 0.91);
  box-shadow:
    0 25px 90px rgba(0, 0, 0, 0.55),
    inset 0 1px rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(28px);
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.command-panel--hidden {
  opacity: 0;
  pointer-events: none;
  transform:
    translate(-50%, calc(-50% + 20px))
    scale(0.97);
}

.command-panel__label {
  margin: 0 0 11px 5px;
  color: rgba(255, 255, 255, 0.58);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.17em;
}

form {
  display: flex;
  gap: 10px;
}

input {
  min-width: 0;
  flex: 1;
  padding: 16px 17px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  outline: none;
  color: white;
  background: rgba(255, 255, 255, 0.075);
  font: inherit;
  font-size: 17px;
  user-select: text;
}

input:focus {
  border-color: rgba(117, 178, 255, 0.7);
  box-shadow: 0 0 0 4px rgba(74, 142, 255, 0.12);
}

button {
  padding: 0 21px;
  border: 0;
  border-radius: 16px;
  color: #06111c;
  background: #a9d4ff;
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}

button:hover {
  filter: brightness(1.08);
}

.command-panel__hint {
  margin: 11px 5px 0;
  color: rgba(255, 255, 255, 0.46);
  font-size: 12px;
}

@keyframes pulse {
  from {
    transform: scale(0.82);
    opacity: 0.65;
  }

  to {
    transform: scale(1.18);
    opacity: 1;
  }
}
'@

$RendererCode = @'
"use strict";

const canvas = document.querySelector("#trail");
const context = canvas.getContext("2d", {
  alpha: true,
  desynchronized: true
});

const statusElement = document.querySelector("#status");
const statusText = document.querySelector("#statusText");
const commandPanel = document.querySelector("#commandPanel");
const commandForm = document.querySelector("#commandForm");
const commandInput = document.querySelector("#commandInput");
const modeText = document.querySelector("#modeText");

const pointer = {
  x: window.innerWidth * 0.5,
  y: window.innerHeight * 0.5
};

const previousPointer = {
  x: pointer.x,
  y: pointer.y
};

// По-къса и бърза следа: главата е 1:1 върху курсора.
const parameters = {
  pointsNumber: 22,
  headWidth: 11.5,
  minimumWidth: 0.7,
  followStart: 0.74,
  followFalloff: 0.012
};

const trail = Array.from(
  { length: parameters.pointsNumber },
  () => ({
    x: pointer.x,
    y: pointer.y
  })
);

let pointerActive = true;
let receivedFirstPointer = false;
let statusTimer = null;
let animationFrame = null;
let lastFrameTime = performance.now();

function resetTrail(x = pointer.x, y = pointer.y) {
  for (const point of trail) {
    point.x = x;
    point.y = y;
  }
}

function setupCanvas() {
  const ratio = Math.max(
    1,
    Math.min(window.devicePixelRatio || 1, 2)
  );

  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  if (!receivedFirstPointer) {
    pointer.x = width * 0.5;
    pointer.y = height * 0.5;
    resetTrail();
  }
}

function updateTrail(frameTime) {
  animationFrame = window.requestAnimationFrame(updateTrail);

  if (!pointerActive) {
    context.clearRect(
      0,
      0,
      window.innerWidth,
      window.innerHeight
    );
    return;
  }

  const elapsed = Math.min(
    2,
    Math.max(0.5, (frameTime - lastFrameTime) / 16.667)
  );

  lastFrameTime = frameTime;

  context.clearRect(
    0,
    0,
    window.innerWidth,
    window.innerHeight
  );

  // Главата никога не използва smoothing.
  trail[0].x = pointer.x;
  trail[0].y = pointer.y;

  for (let index = 1; index < trail.length; index += 1) {
    const point = trail[index];
    const previous = trail[index - 1];

    const follow = Math.max(
      0.43,
      parameters.followStart -
      index * parameters.followFalloff
    );

    const frameFollow = 1 - Math.pow(1 - follow, elapsed);

    point.x += (previous.x - point.x) * frameFollow;
    point.y += (previous.y - point.y) * frameFollow;
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(12, 12, 16, 0.94)";
  context.shadowColor = "rgba(255, 255, 255, 0.30)";
  context.shadowBlur = 1.8;

  context.beginPath();
  context.moveTo(trail[0].x, trail[0].y);

  for (let index = 1; index < trail.length - 1; index += 1) {
    const centerX =
      0.5 * (trail[index].x + trail[index + 1].x);

    const centerY =
      0.5 * (trail[index].y + trail[index + 1].y);

    context.quadraticCurveTo(
      trail[index].x,
      trail[index].y,
      centerX,
      centerY
    );

    const progress = index / (trail.length - 1);

    context.lineWidth =
      parameters.minimumWidth +
      parameters.headWidth * (1 - progress);

    context.stroke();
  }

  context.lineTo(
    trail[trail.length - 1].x,
    trail[trail.length - 1].y
  );

  context.lineWidth = parameters.minimumWidth;
  context.stroke();
  context.restore();

  previousPointer.x = pointer.x;
  previousPointer.y = pointer.y;
}

function showStatus(message, kind = "info") {
  statusText.textContent = message;
  statusElement.dataset.kind = kind;
  statusElement.classList.remove("status--hidden");

  clearTimeout(statusTimer);

  const persistent = [
    "working",
    "training",
    "error"
  ].includes(kind);

  statusTimer = setTimeout(
    () => statusElement.classList.add("status--hidden"),
    persistent ? 8500 : 3500
  );
}

window.david.onPointer((position) => {
  const x = Number(position.x);
  const y = Number(position.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  pointer.x = x;
  pointer.y = y;

  if (!receivedFirstPointer) {
    receivedFirstPointer = true;
    resetTrail(x, y);
  }
});

window.david.onPointerActive(({ active }) => {
  pointerActive = Boolean(active);
  canvas.dataset.active = String(pointerActive);

  if (pointerActive) {
    resetTrail(pointer.x, pointer.y);
  }
});

window.david.onDisplay(() => {
  setupCanvas();
});

window.david.onStatus(({ message, kind }) => {
  showStatus(message, kind);
});

window.david.onCommandPanel(({ open }) => {
  commandPanel.classList.toggle(
    "command-panel--hidden",
    !open
  );

  if (open) {
    setTimeout(() => commandInput.focus(), 40);
  } else {
    commandInput.blur();
  }
});

commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const command = commandInput.value.trim();
  if (!command) return;

  commandInput.value = "";
  showStatus("DAVID обработва командата...", "working");

  const result = await window.david.submitCommand(command);

  if (!result.ok) {
    showStatus(
      result.message || "Командата не беше изпълнена.",
      "error"
    );
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.david.hideCommandPanel();
  }
});

window.addEventListener("resize", setupCanvas);

window.addEventListener("beforeunload", () => {
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
});

window.david.getInfo().then((info) => {
  const mode =
    info.mode === "supabase-teacher"
      ? "Supabase + GPT Teacher"
      : "Local demo teacher";

  modeText.textContent =
    `${mode} · Overlay ${info.overlayVersion || "v1"} · ` +
    `Native actions: ${info.nativeActionsEnabled ? "ON" : "OFF"}`;
});

setupCanvas();
animationFrame = window.requestAnimationFrame(updateTrail);
'@

Set-Content $Main $MainCode -Encoding UTF8
Set-Content $Preload $PreloadCode -Encoding UTF8
Set-Content $Index $IndexCode -Encoding UTF8
Set-Content $Styles $StylesCode -Encoding UTF8
Set-Content $Renderer $RendererCode -Encoding UTF8

$StartCode = @'
$ErrorActionPreference = "Stop"

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
Set-Location $Project

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500

if (-not (Test-Path ".\node_modules\electron\dist\electron.exe")) {
    throw "Electron binary липсва."
}

if (-not (Test-Path ".\node_modules\dotenv\package.json")) {
    throw "dotenv липсва. Изпълни npm install."
}

$env:NODE_OPTIONS = "--max-old-space-size=2048"

& node.exe --check ".\main.cjs"
if ($LASTEXITCODE -ne 0) {
    throw "main.cjs има синтактична грешка."
}

& node.exe --check ".\preload.cjs"
if ($LASTEXITCODE -ne 0) {
    throw "preload.cjs има синтактична грешка."
}

& node.exe --check ".\renderer\renderer.js"
if ($LASTEXITCODE -ne 0) {
    throw "renderer.js има синтактична грешка."
}

& npm.cmd test
if ($LASTEXITCODE -ne 0) {
    throw "DAVID tests се провалиха."
}

Write-Host ""
Write-Host "DAVID Overlay v2 стартира..." -ForegroundColor Green
Write-Host "Ctrl+Shift+D за команда." -ForegroundColor Cyan
Write-Host ""

& npm.cmd start
'@

$StartPath = Join-Path $Project "START-DAVID-V2.ps1"
Set-Content $StartPath $StartCode -Encoding UTF8

Write-Host ""
Write-Host "Проверявам JavaScript синтаксиса..." -ForegroundColor Cyan

& node.exe --check $Main
if ($LASTEXITCODE -ne 0) {
    throw "main.cjs има синтактична грешка."
}

& node.exe --check $Preload
if ($LASTEXITCODE -ne 0) {
    throw "preload.cjs има синтактична грешка."
}

& node.exe --check $Renderer
if ($LASTEXITCODE -ne 0) {
    throw "renderer.js има синтактична грешка."
}

Write-Host "Синтаксис: OK" -ForegroundColor Green

& npm.cmd test
if ($LASTEXITCODE -ne 0) {
    throw "DAVID tests се провалиха."
}

Write-Host ""
Write-Host "DAVID OVERLAY V2 Е ИНСТАЛИРАН." -ForegroundColor Green
Write-Host "Стартирам чисто..." -ForegroundColor Cyan
Write-Host ""

Set-ExecutionPolicy -Scope Process Bypass -Force
& $StartPath
