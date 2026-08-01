/* DAVID_FULL_SCREEN_PATCH_BEGIN */
const __davidElectronFullScreen = require("electron");

__davidElectronFullScreen.app.on(
  "browser-window-created",
  (_event, window) => {
    /* DAVID_BROWSER_NORMAL_WINDOW_BEGIN */
    // GPT is a normal work window. Do not apply the transparent
    // desktop-overlay rules to it.
    if (String(window.getTitle() || "") === "DAVID Browser") {
      return;
    }
    /* DAVID_BROWSER_NORMAL_WINDOW_END */

    const forceDavidFullScreen = () => {
      try {
        if (window.isDestroyed()) {
          return;
        }

        const display =
          __davidElectronFullScreen.screen.getDisplayMatching(
            window.getBounds()
          );

        const bounds = display.bounds;

        window.setFullScreen(false);

        window.setBounds(
          {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height
          },
          false
        );

        window.setPosition(
          bounds.x,
          bounds.y,
          false
        );

        window.setSize(
          bounds.width,
          bounds.height,
          false
        );

        window.setAlwaysOnTop(
          true,
          "screen-saver"
        );

        window.setSkipTaskbar(true);
      } catch (error) {
        console.error(
          "DAVID full-screen patch:",
          error.message
        );
      }
    };

    window.once(
      "ready-to-show",
      forceDavidFullScreen
    );

    window.on(
      "show",
      forceDavidFullScreen
    );

    window.on(
      "restore",
      forceDavidFullScreen
    );

    window.webContents.on(
      "did-finish-load",
      async () => {
        forceDavidFullScreen();

        try {
          await window.webContents.insertCSS(`
            html,
            body,
            #root,
            #app,
            .app,
            .overlay,
            .overlay-root,
            .david-overlay {
              position: fixed !important;
              inset: 0 !important;
              left: 0 !important;
              top: 0 !important;
              width: 100vw !important;
              height: 100vh !important;
              min-width: 100vw !important;
              min-height: 100vh !important;
              max-width: none !important;
              max-height: none !important;
              margin: 0 !important;
              padding: 0 !important;
              overflow: hidden !important;
              box-sizing: border-box !important;
            }
          `);
        } catch {}
      }
    );

    let attempts = 0;

    const fullScreenTimer = setInterval(() => {
      attempts += 1;
      forceDavidFullScreen();

      if (
        attempts >= 10 ||
        window.isDestroyed()
      ) {
        clearInterval(fullScreenTimer);
      }
    }, 500);
  }
);
/* DAVID_FULL_SCREEN_PATCH_END */

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
const { getBuiltInSkills } = require("./core/builtin-skills.cjs");

const overlays = new Map();

let pointerTimer = null;
let rebuildTimer = null;
let commandPanelState = null;
let commandPanelOpen = false;
let pendingDavidInput = null;
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

function isBareChatGptIntent(text) {
  return /^(?:пиши|pishi|напиши|napishi|прати|prati|изпрати|izprati)(?:\s+(?:на|в|до|do))?\s+(?:gpt|chatgpt)\s*[.!?]*$/iu.test(
    String(text || "").trim()
  );
}

function requestChatGptMessage() {
  const state =
    commandPanelState ||
    getOverlayForCursor() ||
    getPrimaryOverlay();

  pendingDavidInput = {
    type: "chatgpt_message",
    createdAt: Date.now()
  };

  safeSend(state, "david:request-input", {
    mode: "chatgpt_message",
    prompt: "Какво да изпратя на GPT?",
    placeholder: "Напиши съобщението за GPT..."
  });

  sendStatus("Какво да изпратя на GPT?", "working");
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
    contextProvider: () => getRuntimeContext(config),
    builtInSkills: getBuiltInSkills()
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
    let text = String(command || "").trim();

    if (!text) {
      return {
        ok: false,
        message: "Напиши команда."
      };
    }

    if (
      pendingDavidInput &&
      pendingDavidInput.type === "chatgpt_message"
    ) {
      pendingDavidInput = null;
      text = `пиши на GPT ${text}`;
    } else if (isBareChatGptIntent(text)) {
      requestChatGptMessage();

      return {
        ok: true,
        awaitingInput: true,
        inputMode: "chatgpt_message",
        message: "Какво да изпратя на GPT?"
      };
    }

    closeCommandPanel();

    try {
      return await skillEngine.handleCommand(text);
    } catch (error) {
      sendStatus(`Грешка: ${error.message}`, "error");

      return {
        ok: false,
        message: error.message
      };
    }
  });

  ipcMain.on("david:hide-command-panel", () => {
    pendingDavidInput = null;
    closeCommandPanel();
  });

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



