"use strict";

const { spawn } = require("child_process");
const { BrowserAgent, sleep, validateHttpUrl } = require("./browser-agent.cjs");
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
        const result = await this.executeStep(step);
        log.status = "success";
        if (result !== undefined) log.result = result;
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

      case "system_click":
        await this.executeNativeClick(step);
        return;

      case "system_type":
        await this.executeNativeType(step);
        return;

      case "twin_agent_task":
        return this.executeTwinAgentTask(step);

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

  async executeTwinAgentTask(step) {
    const supabaseUrl = String(process.env.SUPABASE_URL || "")
      .trim()
      .replace(/\/+$/, "");
    const deviceToken = String(process.env.DAVID_DEVICE_TOKEN || "").trim();
    const agentKey = String(step.agent_key || "").trim().toLowerCase();
    const prompt = String(step.prompt || step.instruction || "").trim();
    const taskType = String(step.task_type || "work").trim() || "work";
    const priorityValue = Number(step.priority ?? 100);
    const priority = Number.isFinite(priorityValue)
      ? Math.max(1, Math.min(1000, Math.trunc(priorityValue)))
      : 100;

    if (!supabaseUrl) {
      throw new Error("SUPABASE_URL липсва за Twin Agent delegation.");
    }
    if (deviceToken.length < 32) {
      throw new Error("DAVID_DEVICE_TOKEN липсва или е невалиден за Twin Agent delegation.");
    }
    if (!/^[a-z0-9][a-z0-9_-]{1,119}$/i.test(agentKey)) {
      throw new Error("Невалиден Twin Agent key.");
    }
    if (!prompt || prompt.length > 90000) {
      throw new Error("Twin Agent задачата е празна или прекалено дълга.");
    }

    const endpoint = `${supabaseUrl}/functions/v1/david-twin-agent-bridge`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-david-device-token": deviceToken
      },
      body: JSON.stringify({
        op: "enqueue",
        payload: {
          agent_key: agentKey,
          task_type: taskType,
          prompt,
          priority
        }
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok !== true) {
      throw new Error(
        `Twin Agent bridge отказа задачата (${response.status}): ${String(
          data?.error || "unknown_error"
        )}`
      );
    }

    this.sendStatus(
      `DAVID даде задача на ${agentKey} · ${String(data.task_id || "queued")}`,
      "working"
    );

    return {
      task_id: data.task_id,
      agent_key: agentKey,
      status: data.status || "queued"
    };
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
