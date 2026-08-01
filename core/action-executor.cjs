"use strict";

const { spawn } = require("child_process");
const { BrowserAgent, sleep, validateHttpUrl } = require("./browser-agent.cjs");
const { TeacherLoop } = require("./teacher-loop.cjs");
const { clickAt, typeText } = require("./windows-native.cjs");
const { ALLOWED_ACTIONS } = require("./skill-schema.cjs");

class ActionExecutor {
  constructor({
    BrowserWindow,
    shell,
    Notification,
    confirmAction,
    nativeActionsEnabled,
    sendStatus
  }) {
    this.shell = shell;
    this.Notification = Notification;
    this.confirmAction = confirmAction;
    this.nativeActionsEnabled = nativeActionsEnabled;
    this.sendStatus = sendStatus;
    this.browser = new BrowserAgent({ BrowserWindow, sendStatus });
    this.teacherLoop = new TeacherLoop({
      browser: this.browser,
      sendStatus,
      confirmAction
    });
  }

  async run(steps) {
    const logs = [];
    const startedAt = new Date().toISOString();

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const log = {
        index,
        action: step.action,
        started_at: new Date().toISOString(),
        status: "running"
      };

      logs.push(log);
      this.sendStatus(
        `Стъпка ${index + 1}/${steps.length}: ${step.action}`,
        "working"
      );

      try {
        const stepResult = await this.executeStep(step);
        if (stepResult !== undefined) log.result = stepResult;
        log.status = "success";
        log.finished_at = new Date().toISOString();
      } catch (error) {
        log.status = step.allow_fail ? "skipped" : "failed";
        log.error = error.message;
        log.finished_at = new Date().toISOString();

        if (!step.allow_fail) {
          return {
            ok: false,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            failed_step: index,
            error: error.message,
            logs
          };
        }
      }
    }

    return {
      ok: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      logs
    };
  }

  async executeStep(step) {
    if (!ALLOWED_ACTIONS.has(step.action)) {
      throw new Error(`Неразрешено действие: ${step.action}`);
    }

    switch (step.action) {
      case "open_url":
        await this.shell.openExternal(validateHttpUrl(step.url));
        return;

      case "open_app":
        await this.openApp(step.app);
        return;

      case "wait":
        await sleep(Number(step.milliseconds || 500));
        return;

      case "browser_open":
        await this.browser.open(step.url);
        return;

      case "browser_wait_selector":
        await this.browser.waitForSelector(
          step.selector,
          Number(step.timeout_ms || 15000)
        );
        return;

      case "browser_click_selector":
        await this.browser.clickSelector(step.selector);
        return;

      case "browser_click_text":
        await this.browser.clickText(step.text);
        return;

      case "browser_type_selector":
        await this.browser.typeSelector(step.selector, step.text);
        return;

      case "browser_press_key":
        await this.browser.pressKey(step.key);
        return;

      case "verify_url_contains":
        this.browser.verifyUrlContains(step.value);
        return;

      case "teacher_loop":
        return this.teacherLoop.run(step.goal || "");

      case "system_click":
        await this.executeNativeClick(step);
        return;

      case "system_type":
        await this.executeNativeType(step);
        return;

      case "notify":
        if (this.Notification.isSupported()) {
          new this.Notification({
            title: step.title || "DAVID",
            body: step.text || "Задачата приключи."
          }).show();
        }
        return;

      default:
        throw new Error(`Неподдържано действие: ${step.action}`);
    }
  }

  async openApp(appName) {
    const value = String(appName || "").trim();

    if (!value || value.length > 160 || /[\r\n;&|<>]/.test(value)) {
      throw new Error("Невалидно име на приложение.");
    }

    await new Promise((resolve, reject) => {
      const child = spawn(value, [], {
        detached: true,
        stdio: "ignore",
        shell: false
      });

      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  async executeNativeClick(step) {
    if (!this.nativeActionsEnabled) {
      throw new Error(
        "Native desktop действията са изключени. Включват се с DAVID_ENABLE_NATIVE_ACTIONS=true."
      );
    }

    const allowed = await this.confirmAction({
      title: "DAVID иска да кликне върху компютъра",
      detail: `Координати: X=${step.x}, Y=${step.y}`
    });

    if (!allowed) throw new Error("Потребителят отказа system_click.");
    await clickAt(Number(step.x), Number(step.y));
  }

  async executeNativeType(step) {
    if (!this.nativeActionsEnabled) {
      throw new Error(
        "Native desktop действията са изключени. Включват се с DAVID_ENABLE_NATIVE_ACTIONS=true."
      );
    }

    const allowed = await this.confirmAction({
      title: "DAVID иска да напише текст",
      detail: String(step.text || "").slice(0, 300)
    });

    if (!allowed) throw new Error("Потребителят отказа system_type.");
    await typeText(String(step.text || ""));
  }
}

module.exports = { ActionExecutor };
