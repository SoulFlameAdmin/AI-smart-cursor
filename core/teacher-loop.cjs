"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadConfig } = require("./config.cjs");
const { DeviceBridgeClient } = require("./device-bridge-client.cjs");

const PROTOCOL = "david_upgrade_loop_v1";
const ALLOWED_POWERSHELL_ACTIONS = new Set([
  "run_powershell_upgrade",
  "run_powershell",
  "powershell"
]);

function createJobId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `upgrade-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function truncateMiddle(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return { text, truncated: false, original_length: text.length };
  }

  const half = Math.floor((maxLength - 80) / 2);
  return {
    text:
      text.slice(0, half) +
      `\n... DAVID TRUNCATED ${text.length - half * 2} CHARACTERS ...\n` +
      text.slice(-half),
    truncated: true,
    original_length: text.length
  };
}

function findBalancedJsonObjects(text) {
  const source = String(text || "");
  const results = [];

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;

        if (depth === 0) {
          results.push(source.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }

  return results;
}

function normalizeTeacherAction(action, index) {
  if (!action || typeof action !== "object") return null;

  const actionName = String(action.action || action.type || "").trim();
  if (!ALLOWED_POWERSHELL_ACTIONS.has(actionName)) return null;

  const script = String(
    action.script || action.code || action.command || ""
  ).trim();

  if (!script) return null;

  return {
    action: actionName,
    action_id: String(action.action_id || `round-action-${index + 1}`),
    script,
    requires_confirmation: action.requires_confirmation !== false,
    timeout_ms: Number(action.timeout_ms) || null,
    expected_tests: Array.isArray(action.expected_tests)
      ? action.expected_tests.map(String).slice(0, 20)
      : []
  };
}

function parseTeacherResponse(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("GPT върна празен отговор.");

  const candidates = [text, ...findBalancedJsonObjects(text)];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object") continue;

      const status = String(parsed.status || "").toLowerCase();
      const rawActions = Array.isArray(parsed.actions)
        ? parsed.actions
        : parsed.action && typeof parsed.action === "object"
          ? [parsed.action]
          : [];
      const actions = rawActions
        .map(normalizeTeacherAction)
        .filter(Boolean)
        .slice(0, 3);

      if (["completed", "blocked", "action"].includes(status)) {
        if (status === "action" && actions.length === 0) {
          throw new Error(
            "GPT върна status=action, но няма валиден PowerShell script."
          );
        }

        return {
          protocol: String(parsed.protocol || PROTOCOL),
          job_id: parsed.job_id ? String(parsed.job_id) : null,
          round: Number(parsed.round) || null,
          status,
          summary: String(parsed.summary || parsed.message || "").trim(),
          actions,
          raw: parsed
        };
      }
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        /status=action/.test(String(error.message))
      ) {
        continue;
      }
      throw error;
    }
  }

  const fenced = text.match(
    /```(?:powershell|ps1|pwsh)?\s*([\s\S]*?)```/iu
  );

  if (fenced && fenced[1].trim()) {
    return {
      protocol: PROTOCOL,
      job_id: null,
      round: null,
      status: "action",
      summary: "GPT върна PowerShell код без JSON протокол.",
      actions: [
        {
          action: "run_powershell_upgrade",
          action_id: "fallback-powershell",
          script: fenced[1].trim(),
          requires_confirmation: true,
          timeout_ms: null,
          expected_tests: []
        }
      ],
      raw: { fallback: true }
    };
  }

  throw new Error(
    "GPT отговорът не съдържа валиден DAVID JSON или PowerShell блок."
  );
}

function classifyPowerShellRisk(script, repositoryRoot) {
  const text = String(script || "");
  const lower = text.toLowerCase();
  const reasons = [];
  let blocked = false;
  let level = "low";

  const blockedPatterns = [
    [/(?:^|\s)format-volume\b/i, "форматиране на дял"],
    [/(?:^|\s)clear-disk\b/i, "изчистване на диск"],
    [/(?:^|\s)initialize-disk\b/i, "инициализиране на диск"],
    [/(?:^|\s)remove-partition\b/i, "изтриване на дял"],
    [/(?:^|\s)(?:stop-computer|restart-computer)\b/i, "спиране или рестарт на компютъра"],
    [/\bbcdedit\b/i, "промяна на boot конфигурацията"],
    [/\breg(?:\.exe)?\s+delete\s+hklm\\/i, "изтриване от HKLM регистъра"],
    [/remove-item[^\r\n]*(?:[a-z]:\\(?:\s|["']?$)|c:\\windows|c:\\users)(?:[^a-z]|$)/i, "масово изтриване извън DAVID проекта"]
  ];

  for (const [pattern, reason] of blockedPatterns) {
    if (pattern.test(text)) {
      blocked = true;
      level = "blocked";
      reasons.push(reason);
    }
  }

  const highPatterns = [
    [/(?:^|\s)start-process\b[^\r\n]*-verb\s+runas/i, "искане на администраторски права"],
    [/(?:^|\s)set-executionpolicy\b[^\r\n]*(?:localmachine|machinepolicy|userpolicy)/i, "системна ExecutionPolicy промяна"],
    [/\b(?:new-localuser|remove-localuser|net\s+user)\b/i, "промяна на локални потребители"],
    [/\b(?:set-netfirewallprofile|new-netfirewallrule|disable-netadapter)\b/i, "промяна на мрежа или firewall"],
    [/\binvoke-expression\b|\biex\b/i, "динамично изпълнение чрез Invoke-Expression"],
    [/\b(?:curl(?:\.exe)?\s+-t|scp\s+|start-bitstransfer\b[^\r\n]*-destination\s+https?:)/i, "възможно качване на данни"],
    [/\bgit\s+(?:push|merge|rebase)\b/i, "Git push/merge/rebase"],
    [/\b(?:npm\s+publish|npx\s+vercel\s+--prod|vercel\s+--prod)\b/i, "публикуване в production"]
  ];

  if (!blocked) {
    for (const [pattern, reason] of highPatterns) {
      if (pattern.test(text)) {
        level = "high";
        reasons.push(reason);
      }
    }
  }

  const normalizedRoot = path.resolve(repositoryRoot || process.cwd()).toLowerCase();
  const absolutePaths = text.match(/[a-z]:\\[^\r\n"'`]*/gi) || [];

  for (const candidate of absolutePaths) {
    const cleaned = candidate.replace(/[\s),;]+$/g, "").trim().toLowerCase();
    if (!cleaned) continue;

    if (
      !cleaned.startsWith(normalizedRoot) &&
      !cleaned.startsWith("c:\\program files\\git") &&
      !cleaned.startsWith("c:\\windows\\system32\\windowspowershell")
    ) {
      if (!blocked && level === "low") level = "high";
      reasons.push(`абсолютен път извън проекта: ${candidate.slice(0, 180)}`);
    }
  }

  if (!blocked && level === "low") {
    if (/\b(?:remove-item|set-content|move-item|rename-item|copy-item)\b/i.test(lower)) {
      level = "medium";
      reasons.push("промяна на файлове");
    }
  }

  return {
    blocked,
    level,
    reasons: [...new Set(reasons)]
  };
}

function buildInitialTeacherRequest({ jobId, goal, repositoryRoot, maxRounds }) {
  return JSON.stringify(
    {
      protocol: PROTOCOL,
      job_id: jobId,
      round: 0,
      status: "request",
      goal:
        String(goal || "").trim() ||
        "Диагностицирай DAVID Smart Cursor и предложи само следващия безопасен локален upgrade.",
      runtime: {
        platform: process.platform,
        repository_root: repositoryRoot,
        max_rounds: maxRounds,
        execution: "Electron GPT -> local PowerShell -> result back to GPT"
      },
      teacher_instructions: [
        "Върни само един JSON обект, без markdown и без текст извън JSON.",
        `protocol трябва да е ${PROTOCOL}.`,
        "Разрешени status стойности: action, completed, blocked.",
        "При action използвай actions масив. Всяко действие да е run_powershell_upgrade и да съдържа action_id, script, timeout_ms, expected_tests и requires_confirmation.",
        "Давай само една малка проверима стъпка на рунд.",
        "За безопасни проверки само в repository_root поставяй requires_confirmation=false. За промяна на файлове, системни настройки, git push/merge или публикуване поставяй requires_confirmation=true.",
        "Не използвай разрушителни команди, не форматирай дискове, не изтривай извън repository_root, не публикувай и не прави git push без изрично човешко потвърждение.",
        "След execution_result анализирай stdout, stderr и exit_code и върни следващото действие или completed."
      ]
    },
    null,
    2
  );
}

function buildExecutionFeedback({ jobId, round, actionResults }) {
  return JSON.stringify(
    {
      protocol: PROTOCOL,
      job_id: jobId,
      round,
      status: "execution_result",
      action_results: actionResults
    },
    null,
    2
  );
}

class TeacherLoop {
  constructor({ browser, sendStatus, confirmAction }) {
    this.browser = browser;
    this.sendStatus = sendStatus;
    this.confirmAction = confirmAction;
    this.config = loadConfig();
    this.bridge = new DeviceBridgeClient({
      config: this.config,
      sendStatus
    });
    this.running = false;
  }

  async run(goal = "") {
    if (this.running) {
      throw new Error("DAVID Teacher Loop вече работи.");
    }

    this.running = true;
    const jobId = createJobId();
    const repositoryRoot = path.resolve(this.config.repositoryRoot);

    if (!fs.existsSync(repositoryRoot)) {
      throw new Error(`DAVID repository root не съществува: ${repositoryRoot}`);
    }

    if (!fs.existsSync(path.join(repositoryRoot, "package.json"))) {
      throw new Error(
        `DAVID_REPOSITORY_ROOT не сочи към DAVID проекта: ${repositoryRoot}`
      );
    }

    const runtimeDirectory = path.join(repositoryRoot, ".david-runtime");
    fs.mkdirSync(runtimeDirectory, { recursive: true });

    const journalPath = path.join(runtimeDirectory, "teacher-loop.jsonl");
    const journal = (eventType, payload = {}) => {
      const entry = {
        timestamp: new Date().toISOString(),
        protocol: PROTOCOL,
        job_id: jobId,
        event_type: eventType,
        payload
      };
      fs.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
      void this.bridge.logEvent(eventType, entry);
    };

    try {
      this.sendStatus("Стартирам DAVID Teacher Loop...", "training");
      journal("teacher_loop_started", { goal, repository_root: repositoryRoot });

      await this.browser.openIfNeeded(this.config.teacherChatUrl);

      let outgoing = buildInitialTeacherRequest({
        jobId,
        goal,
        repositoryRoot,
        maxRounds: this.config.maxTeacherRounds
      });

      for (let round = 1; round <= this.config.maxTeacherRounds; round += 1) {
        this.sendStatus(
          `Teacher рунд ${round}: изпращам към GPT...`,
          "training"
        );

        const before = await this.browser.sendChatGptMessage(outgoing);
        const responseText = await this.browser.waitForChatGptResponse({
          before,
          timeoutMs: this.config.gptResponseTimeoutMs
        });

        const compactResponse = truncateMiddle(
          responseText,
          this.config.maxTeacherOutputChars
        );
        journal("teacher_gpt_response", {
          round,
          response: compactResponse
        });

        const response = parseTeacherResponse(responseText);

        if (response.status === "completed") {
          const message =
            response.summary || `Teacher Loop приключи на рунд ${round}.`;
          this.sendStatus(message, "success");
          journal("teacher_loop_completed", { round, summary: message });

          return {
            ok: true,
            job_id: jobId,
            round,
            status: "completed",
            summary: message,
            journal_path: journalPath
          };
        }

        if (response.status === "blocked") {
          const message = response.summary || "GPT блокира цикъла.";
          this.sendStatus(message, "error");
          journal("teacher_loop_blocked", { round, summary: message });

          return {
            ok: false,
            job_id: jobId,
            round,
            status: "blocked",
            summary: message,
            journal_path: journalPath
          };
        }

        const actionResults = [];

        for (const action of response.actions) {
          const risk = classifyPowerShellRisk(action.script, repositoryRoot);
          journal("teacher_powershell_planned", {
            round,
            action_id: action.action_id,
            risk,
            expected_tests: action.expected_tests
          });

          if (risk.blocked) {
            throw new Error(
              `PowerShell действието е блокирано: ${risk.reasons.join(", ")}`
            );
          }

          const needsConfirmation =
            action.requires_confirmation ||
            risk.level === "high" ||
            (risk.level === "medium" && !this.config.autoApproveSafePowerShell);

          if (needsConfirmation) {
            const allowed = await this.confirmAction({
              title: "DAVID Teacher иска да изпълни PowerShell upgrade",
              detail:
                `Риск: ${risk.level}. ` +
                `${risk.reasons.join("; ") || "няма открит висок риск"}\n\n` +
                action.script.slice(0, 3000)
            });

            if (!allowed) {
              const denied = {
                action_id: action.action_id,
                ok: false,
                status: "rejected_by_user",
                risk
              };
              actionResults.push(denied);
              journal("teacher_powershell_rejected", { round, ...denied });
              break;
            }
          }

          this.sendStatus(
            `PowerShell рунд ${round}: ${action.action_id}`,
            "working"
          );

          const result = await this.executePowerShell({
            jobId,
            round,
            action,
            repositoryRoot,
            runtimeDirectory
          });
          actionResults.push(result);
          journal("teacher_powershell_finished", { round, ...result });

          if (!result.ok) break;
        }

        outgoing = buildExecutionFeedback({
          jobId,
          round,
          actionResults
        });
      }

      const message =
        `DAVID спря след ${this.config.maxTeacherRounds} рунда без completed.`;
      this.sendStatus(message, "warning");
      journal("teacher_loop_round_limit", {
        max_rounds: this.config.maxTeacherRounds
      });

      return {
        ok: false,
        job_id: jobId,
        status: "round_limit",
        summary: message,
        journal_path: journalPath
      };
    } catch (error) {
      this.sendStatus(`Teacher Loop грешка: ${error.message}`, "error");
      journal("teacher_loop_error", {
        message: error.message,
        stack: String(error.stack || "").slice(0, 12000)
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  async executePowerShell({
    jobId,
    round,
    action,
    repositoryRoot,
    runtimeDirectory
  }) {
    const safeActionId = String(action.action_id || "action")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .slice(0, 80);
    const scriptPath = path.join(
      runtimeDirectory,
      `${jobId}-r${round}-${safeActionId}.ps1`
    );
    fs.writeFileSync(scriptPath, action.script, "utf8");

    const timeoutMs = Math.max(
      10000,
      Math.min(
        Number(action.timeout_ms) || this.config.powershellTimeoutMs,
        this.config.powershellTimeoutMs
      )
    );
    const startedAt = Date.now();

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let timer = null;

      const child = spawn(
        this.config.powershellExecutable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath
        ],
        {
          cwd: repositoryRoot,
          windowsHide: false,
          env: {
            ...process.env,
            DAVID_JOB_ID: jobId,
            DAVID_ROUND: String(round),
            DAVID_REPOSITORY_ROOT: repositoryRoot
          }
        }
      );

      const finish = (exitCode, signal, spawnError = null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);

        const compactStdout = truncateMiddle(
          stdout,
          this.config.maxTeacherOutputChars
        );
        const compactStderr = truncateMiddle(
          stderr,
          this.config.maxTeacherOutputChars
        );

        resolve({
          action_id: action.action_id,
          ok: !spawnError && !timedOut && exitCode === 0,
          exit_code: Number.isInteger(exitCode) ? exitCode : null,
          signal: signal || null,
          timed_out: timedOut,
          duration_ms: Date.now() - startedAt,
          stdout: compactStdout.text,
          stdout_truncated: compactStdout.truncated,
          stdout_original_length: compactStdout.original_length,
          stderr: spawnError
            ? `${compactStderr.text}\n${spawnError.message}`.trim()
            : compactStderr.text,
          stderr_truncated: compactStderr.truncated,
          stderr_original_length: compactStderr.original_length,
          script_path: scriptPath,
          expected_tests: action.expected_tests
        });
      };

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => finish(null, null, error));
      child.once("close", (code, signal) => finish(code, signal));

      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");

        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 3000).unref?.();
      }, timeoutMs);
    });
  }
}

module.exports = {
  PROTOCOL,
  TeacherLoop,
  buildExecutionFeedback,
  buildInitialTeacherRequest,
  classifyPowerShellRisk,
  findBalancedJsonObjects,
  parseTeacherResponse,
  truncateMiddle
};
