"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AUTONOMOUS_TASK_PROTOCOL,
  createAutonomousTask,
  transitionTask,
  validateAutonomousTask
} = require("./autonomous-task-protocol.cjs");
const { runTeacherWorkerGoal } = require("./david-teacher-client.cjs");

const AUTONOMOUS_ORCHESTRATOR_VERSION = "david_autonomous_orchestrator_v1";
const DEFAULT_MAX_ATTEMPTS = 3;

function isAutonomousCommand(value) {
  return /^\s*@sfadmin\b/iu.test(String(value || ""));
}

function createTaskId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `autonomous-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function observeRepository(projectRoot) {
  const root = path.resolve(projectRoot || path.resolve(__dirname, ".."));
  return {
    root,
    exists: fs.existsSync(root),
    package_json: fs.existsSync(path.join(root, "package.json")),
    git_directory: fs.existsSync(path.join(root, ".git")),
    observed_at: new Date().toISOString()
  };
}

function normalizeProgressState(event) {
  const stage = String(event?.stage || "").toLowerCase();
  if (/test|verify|contract|regression/u.test(stage)) return "test";
  if (/powershell|action|execute|worker/u.test(stage)) return "act";
  if (/think|gpt|knowledge|plan/u.test(stage)) return "think";
  return null;
}

function buildAutonomousTeacherGoal(task, context = {}) {
  validateAutonomousTask(task);

  return [
    "DAVID AUTONOMOUS ORCHESTRATOR V1",
    `TASK_PROTOCOL=${AUTONOMOUS_TASK_PROTOCOL}`,
    `TASK_ID=${task.task_id}`,
    `GOAL=${task.goal}`,
    `PASS_CRITERIA=${JSON.stringify(task.pass_criteria)}`,
    `ALLOWED_ACTIONS=${JSON.stringify(task.allowed_actions)}`,
    `MANDATORY_CONFIRMATION=${JSON.stringify(task.mandatory_confirmation_categories)}`,
    "",
    "EXECUTION CONTRACT:",
    "1. Inspect the real repository/runtime state before changing code.",
    "2. Make only small, reversible repository-local changes unless human confirmation is explicitly required.",
    "3. After every PowerShell/tool action, inspect the real stdout, stderr, exit_code and produced evidence.",
    "4. A failed test is not task completion: diagnose it, repair the cause, and test again.",
    "5. Return completed only after the requested target behavior is proven and regression tests are PASS.",
    "6. Never claim PASS from intention, code appearance, or an unexecuted command.",
    "7. Credentials, destructive delete, production writes, external publishing, payments and account-permission changes require human approval.",
    "8. If a mandatory risk gate is reached, return blocked with the exact required approval instead of bypassing it.",
    "9. Keep working through Think -> Act -> Test -> Verify until PASS or a real safety/blocking condition is reached.",
    "",
    `ORCHESTRATOR_ATTEMPT=${Number(context.attempt || 1)}`,
    context.previous_failure
      ? `PREVIOUS_VERIFICATION_FAILURE=${JSON.stringify(context.previous_failure)}`
      : "PREVIOUS_VERIFICATION_FAILURE=null"
  ].join("\n");
}

function defaultFinalVerifier(workerResult) {
  const ok = Boolean(workerResult?.ok === true && workerResult?.status === "completed");
  return {
    ok,
    source: "teacher_worker_completion",
    status: String(workerResult?.status || "unknown"),
    summary: String(workerResult?.summary || "")
  };
}

class AutonomousOrchestrator {
  constructor({
    projectRoot,
    sendStatus,
    runWorker = runTeacherWorkerGoal,
    observe = observeRepository,
    finalVerifier = defaultFinalVerifier,
    maxAttempts = DEFAULT_MAX_ATTEMPTS
  } = {}) {
    this.projectRoot = path.resolve(projectRoot || path.resolve(__dirname, ".."));
    this.sendStatus = typeof sendStatus === "function" ? sendStatus : () => {};
    this.runWorker = runWorker;
    this.observe = observe;
    this.finalVerifier = finalVerifier;
    this.maxAttempts = Math.max(1, Math.min(10, Number.parseInt(maxAttempts, 10) || DEFAULT_MAX_ATTEMPTS));
    this.running = false;
  }

  async run(command, overrides = {}) {
    if (this.running) {
      throw new Error("DAVID Autonomous Orchestrator вече изпълнява задача.");
    }
    if (!isAutonomousCommand(command)) {
      throw new Error("DAVID autonomous command must start with @sfadmin.");
    }

    this.running = true;

    let task = createAutonomousTask(command, {
      ...overrides,
      task_id: overrides.task_id || createTaskId(),
      metadata: {
        ...(overrides.metadata || {}),
        source: overrides?.metadata?.source || "soul",
        orchestrator: AUTONOMOUS_ORCHESTRATOR_VERSION
      }
    });

    const runtimeRoot = path.join(this.projectRoot, ".david-runtime", "autonomous-tasks");
    const statePath = path.join(runtimeRoot, `${task.task_id}.json`);
    const journalPath = path.join(runtimeRoot, `${task.task_id}.jsonl`);

    const persist = (eventType, evidence = null) => {
      writeJsonAtomic(statePath, task);
      appendJsonl(journalPath, {
        timestamp: new Date().toISOString(),
        orchestrator: AUTONOMOUS_ORCHESTRATOR_VERSION,
        task_id: task.task_id,
        state: task.state,
        event_type: eventType,
        evidence
      });
    };

    const move = (nextState, evidence = null, eventType = `state_${nextState}`) => {
      task = transitionTask(task, nextState, evidence);
      persist(eventType, evidence);
      this.sendStatus(
        `DAVID AUTONOMOUS | ${nextState.toUpperCase()} | ${task.task_id}`,
        nextState === "blocked" || nextState === "failed" ? "error" :
          nextState === "completed" ? "success" : "working",
        { stage: `autonomous_${nextState}`, task_id: task.task_id }
      );
      return task;
    };

    try {
      persist("task_created", { goal: task.goal });

      const observation = await Promise.resolve(this.observe(this.projectRoot, task));
      if (!observation?.exists || !observation?.package_json) {
        move("failed", observation, "repository_observation_failed");
        return {
          ok: false,
          status: "failed",
          task,
          reason: "repository_not_ready",
          state_path: statePath,
          journal_path: journalPath
        };
      }

      move("observe", observation);

      let previousFailure = null;
      let lastWorkerResult = null;
      let lastVerification = null;

      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        move("think", { attempt, previous_failure: previousFailure });

        const autonomousGoal = buildAutonomousTeacherGoal(task, {
          attempt,
          previous_failure: previousFailure
        });

        move("act", { attempt, worker: "thinker_9444_powershell" });

        try {
          lastWorkerResult = await this.runWorker({
            goal: autonomousGoal,
            projectRoot: this.projectRoot,
            sendStatus: this.sendStatus,
            onProgress: (event) => {
              const state = normalizeProgressState(event);
              appendJsonl(journalPath, {
                timestamp: new Date().toISOString(),
                orchestrator: AUTONOMOUS_ORCHESTRATOR_VERSION,
                task_id: task.task_id,
                state: state || task.state,
                event_type: "worker_progress",
                evidence: {
                  stage: event?.stage || null,
                  message: String(event?.message || "").slice(0, 1200),
                  meta: event?.meta || null
                }
              });
            }
          });
        } catch (error) {
          previousFailure = {
            kind: "worker_exception",
            attempt,
            message: String(error?.message || error).slice(0, 2000)
          };
          persist("worker_exception", previousFailure);
          if (attempt < this.maxAttempts) continue;
          move("failed", previousFailure, "worker_attempts_exhausted");
          return {
            ok: false,
            status: "failed",
            task,
            worker_result: lastWorkerResult,
            verification: lastVerification,
            state_path: statePath,
            journal_path: journalPath
          };
        }

        if (lastWorkerResult?.status === "blocked") {
          move("blocked", {
            attempt,
            worker_result: lastWorkerResult
          }, "mandatory_or_worker_block");
          return {
            ok: false,
            status: "blocked",
            task,
            worker_result: lastWorkerResult,
            state_path: statePath,
            journal_path: journalPath
          };
        }

        move("test", {
          attempt,
          worker_status: lastWorkerResult?.status || "unknown",
          worker_ok: Boolean(lastWorkerResult?.ok)
        });

        move("verify", { attempt });
        lastVerification = await Promise.resolve(
          this.finalVerifier(lastWorkerResult, {
            task,
            attempt,
            projectRoot: this.projectRoot,
            journalPath
          })
        );
        persist("verification_result", lastVerification);

        if (lastVerification?.ok === true) {
          move("learn", {
            attempt,
            verification: lastVerification,
            note: "Only verified results are eligible for later memory promotion/checkpointing."
          });
          move("completed", {
            attempt,
            verification: lastVerification,
            worker_result: lastWorkerResult
          });

          return {
            ok: true,
            status: "completed",
            task,
            attempts: attempt,
            worker_result: lastWorkerResult,
            verification: lastVerification,
            state_path: statePath,
            journal_path: journalPath
          };
        }

        previousFailure = {
          kind: "verification_failed",
          attempt,
          verification: lastVerification,
          worker_status: lastWorkerResult?.status || "unknown",
          worker_summary: String(lastWorkerResult?.summary || "").slice(0, 2000)
        };
        persist("verification_failed_retrying", previousFailure);
      }

      move("failed", previousFailure, "verification_attempts_exhausted");
      return {
        ok: false,
        status: "failed",
        task,
        worker_result: lastWorkerResult,
        verification: lastVerification,
        state_path: statePath,
        journal_path: journalPath
      };
    } finally {
      this.running = false;
    }
  }
}

module.exports = {
  AUTONOMOUS_ORCHESTRATOR_VERSION,
  DEFAULT_MAX_ATTEMPTS,
  AutonomousOrchestrator,
  buildAutonomousTeacherGoal,
  createTaskId,
  defaultFinalVerifier,
  isAutonomousCommand,
  normalizeProgressState,
  observeRepository
};
