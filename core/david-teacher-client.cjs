"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ensureThinkerRuntime } = require("./david-thinker-runtime-bootstrap.cjs");

const AUTONOMOUS_TRIGGER = /^\s*@sfadmin\b/iu;
const AUTONOMOUS_INNER_GOAL = /^DAVID AUTONOMOUS ORCHESTRATOR V1\b/u;

const TRIGGER_PATTERNS = [
  /^\s*@worker\b\s*[:\-]?\s*/i,
  /^\s*david\s+(?:worker|teacher|учител)\b\s*[:\-]?\s*/iu,
  /^\s*(?:david[\s,:\-]+)?(?:научи\s+се|обучи\s+се|самообучи\s+се)\s+(?:да\s+)?/iu,
  /^\s*(?:david[\s,:\-]+)?ъпгрейд\s*[:\-]?\s*/iu
];

function isAutonomousGoal(value) {
  return AUTONOMOUS_TRIGGER.test(String(value || "").trim());
}

function isAutonomousInnerGoal(value) {
  return AUTONOMOUS_INNER_GOAL.test(String(value || "").trim());
}

function extractTeacherGoal(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  // DAVID_AUTONOMOUS_SOUL_ROUTE_V1
  // Preserve the @sfadmin prefix so runTeacherWorkerGoal can distinguish an
  // autonomous task from the existing one-shot Teacher/Worker triggers.
  if (isAutonomousGoal(text)) return text;

  for (const pattern of TRIGGER_PATTERNS) {
    if (!pattern.test(text)) continue;
    const goal = text.replace(pattern, "").trim();
    return goal || text;
  }
  return null;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

function boundedAutonomousGptTimeoutMs() {
  const value = Number.parseInt(
    process.env.DAVID_AUTONOMOUS_GPT_RESPONSE_TIMEOUT_MS || "720000",
    10
  );
  return Math.max(240000, Math.min(900000, Number.isFinite(value) ? value : 720000));
}

async function runAutonomousWorkerGoal({
  goal,
  projectRoot,
  sendStatus,
  onProgress
}) {
  // Dynamic require is intentional. autonomous-orchestrator.cjs uses the
  // normal runTeacherWorkerGoal as its inner Thinker -> Worker executor, so a
  // top-level import here would create a circular initialization dependency.
  const { AutonomousOrchestrator } = require("./autonomous-orchestrator.cjs");

  const root = path.resolve(projectRoot || path.resolve(__dirname, ".."));
  const maxAttempts = Math.max(
    1,
    Math.min(
      10,
      Number.parseInt(process.env.DAVID_AUTONOMOUS_MAX_ATTEMPTS || "10", 10) || 10
    )
  );

  const forwardStatus = (message, kind = "working", meta = {}) => {
    sendStatus?.(message, kind, meta);
    if (typeof onProgress === "function") {
      Promise.resolve(onProgress({
        stage: meta?.stage || "autonomous",
        message: String(message || ""),
        kind,
        meta
      })).catch(() => {});
    }
  };

  forwardStatus(
    "DAVID AUTONOMOUS | @sfadmin задачата е поета от Orchestrator V1.",
    "training",
    { stage: "autonomous_started" }
  );

  const orchestrator = new AutonomousOrchestrator({
    projectRoot: root,
    sendStatus: forwardStatus,
    maxAttempts
  });

  const result = await orchestrator.run(goal, {
    max_rounds: Math.max(
      1,
      Math.min(
        500,
        Number.parseInt(process.env.DAVID_AUTONOMOUS_MAX_ROUNDS || "80", 10) || 80
      )
    ),
    metadata: {
      source: "soul",
      route: "@sfadmin",
      autonomous_soul_route: "v1"
    }
  });

  const attempts = Number(result?.attempts || 0) || null;
  const taskId = result?.task?.task_id || null;
  const goalText = String(result?.task?.goal || String(goal || "").replace(AUTONOMOUS_TRIGGER, "")).trim();

  const summary = result?.status === "completed"
    ? `AUTONOMOUS PASS | ${goalText} | attempts=${attempts || 1}`
    : result?.status === "blocked"
      ? `AUTONOMOUS BLOCKED | ${goalText} | approval or blocker requires attention`
      : `AUTONOMOUS FAILED | ${goalText} | attempts=${attempts || maxAttempts}`;

  return {
    ...result,
    autonomous: true,
    task_id: taskId,
    round: attempts || result?.worker_result?.round || null,
    summary
  };
}

async function runTeacherWorkerGoal({ goal, projectRoot, sendStatus, onProgress }) {
  // DAVID_AUTONOMOUS_SOUL_ROUTE_V1
  // @sfadmin is the universal autonomous route. The orchestrator itself calls
  // this function again with a non-@sfadmin generated Teacher goal, which then
  // follows the normal worker path below instead of recursing.
  if (isAutonomousGoal(goal)) {
    return runAutonomousWorkerGoal({
      goal,
      projectRoot,
      sendStatus,
      onProgress
    });
  }

  const root = path.resolve(projectRoot || path.resolve(__dirname, ".."));
  const workerGoal = String(goal || "").trim();
  const autonomousWorker = isAutonomousInnerGoal(workerGoal);
  const thinkerChatUrl = process.env.DAVID_TEACHER_CHAT_URL ||
    "https://chatgpt.com/c/6a81285a-3e38-83ed-965a-b221453fb742";
  const thinkerPort = 9444;

  // DAVID_AUTONOMOUS_THINKER_BOOTSTRAP_V1
  // The Electron-free SOUL runtime owns 9333. Autonomous Teacher rounds still
  // require the isolated Thinker route on 9444. Make that dependency
  // self-healing: reuse it when ready, otherwise start the dedicated Node
  // Thinker keeper and wait for the exact fixed Thinker conversation.
  await ensureThinkerRuntime({
    projectRoot: root,
    sendStatus,
    nodeExecutable: process.env.DAVID_NODE_EXE || process.execPath,
    chatUrl: thinkerChatUrl,
    port: thinkerPort
  });

  const requestRoot = path.join(root, ".david-runtime", "teacher-requests");
  fs.mkdirSync(requestRoot, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const requestFile = path.join(requestRoot, `${id}.request.json`);
  const resultFile = path.join(requestRoot, `${id}.result.json`);
  const progressFile = path.join(requestRoot, `${id}.progress.json`);
  writeJsonAtomic(requestFile, {
    protocol: "david_teacher_worker_v1",
    id,
    goal: workerGoal,
    max_rounds: 8,
    autonomous_task: autonomousWorker,
    auto_approve_repository_powershell: autonomousWorker,
    gpt_response_timeout_ms: autonomousWorker ? boundedAutonomousGptTimeoutMs() : null,
    result_file: resultFile,
    progress_file: progressFile,
    created_at: new Date().toISOString()
  });

  const nodeExecutable = process.env.DAVID_NODE_EXE || "node.exe";
  const workerFile = path.join(__dirname, "david-thinker-worker.cjs");
  sendStatus?.("DAVID изпраща задачата към Thinker 9444 и PowerShell Worker.", "training");

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const childEnv = {
      ...process.env,
      DAVID_REPOSITORY_ROOT: root,
      DAVID_TEACHER_CHAT_URL: thinkerChatUrl,
      DAVID_TEACHER_EDGE_PORT: String(thinkerPort)
    };

    // DAVID_AUTONOMOUS_REPOSITORY_POLICY_V1
    // Only orchestrator-generated inner goals receive the scoped repository
    // autonomy grant and the longer Thinker response window. Teacher risk
    // classification remains authoritative for every actual action.
    if (autonomousWorker) {
      childEnv.DAVID_AUTO_APPROVE_REPOSITORY_POWERSHELL = "true";
      childEnv.DAVID_GPT_RESPONSE_TIMEOUT_MS = String(boundedAutonomousGptTimeoutMs());
    }

    const child = spawn(nodeExecutable, [workerFile, "--request", requestFile], {
      cwd: root,
      windowsHide: true,
      env: childEnv
    });

    // DAVID_PARENT_LIVE_EVENT_FORWARDER_V14
    let liveLineBuffer = "";
    const forwardLiveEvent = (event) => {
      if (!event || typeof event !== "object" || !event.message) return;
      sendStatus?.(event.message, event.kind || "working", {
        stage: event.stage || "working"
      });
      if (typeof onProgress === "function") {
        Promise.resolve(onProgress(event)).catch(() => {});
      }
    };
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      stdout = stdout.slice(-50000);
      liveLineBuffer += text;
      const lines = liveLineBuffer.split(/\r?\n/);
      liveLineBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("[DAVID_LIVE]")) continue;
        try {
          forwardLiveEvent(JSON.parse(line.slice("[DAVID_LIVE]".length)));
        } catch (_) {
          // Unknown worker output is logged but never shown as trusted progress.
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      stderr = stderr.slice(-50000);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
    }, 45 * 60 * 1000);

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fs.existsSync(resultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
          result.worker_stdout = stdout;
          result.worker_stderr = stderr;
          resolve(result);
          return;
        } catch (readError) {
          error = readError;
        }
      }
      reject(error || new Error(stderr || "DAVID Teacher worker stopped without a result."));
    };

    child.once("error", finish);
    child.once("close", (code, signal) => {
      const error = code === 0
        ? null
        : new Error(`Teacher worker exited with code ${code ?? "null"} (${signal || "no signal"}).`);
      finish(error);
    });
  });
}

module.exports = {
  AUTONOMOUS_INNER_GOAL,
  AUTONOMOUS_TRIGGER,
  TRIGGER_PATTERNS,
  boundedAutonomousGptTimeoutMs,
  extractTeacherGoal,
  isAutonomousGoal,
  isAutonomousInnerGoal,
  runAutonomousWorkerGoal,
  runTeacherWorkerGoal
};
