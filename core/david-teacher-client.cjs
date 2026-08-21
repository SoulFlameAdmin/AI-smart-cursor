"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const TRIGGER_PATTERNS = [
  /^\s*@worker\b\s*[:\-]?\s*/i,
  /^\s*david\s+(?:worker|teacher|учител)\b\s*[:\-]?\s*/iu,
  /^\s*(?:david[\s,:\-]+)?(?:научи\s+се|обучи\s+се|самообучи\s+се)\s+(?:да\s+)?/iu,
  /^\s*(?:david[\s,:\-]+)?ъпгрейд\s*[:\-]?\s*/iu
];

function extractTeacherGoal(value) {
  const text = String(value || "").trim();
  if (!text) return null;
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

async function runTeacherWorkerGoal({ goal, projectRoot, sendStatus, onProgress }) {
  const root = path.resolve(projectRoot || path.resolve(__dirname, ".."));
  const requestRoot = path.join(root, ".david-runtime", "teacher-requests");
  fs.mkdirSync(requestRoot, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const requestFile = path.join(requestRoot, `${id}.request.json`);
  const resultFile = path.join(requestRoot, `${id}.result.json`);
  const progressFile = path.join(requestRoot, `${id}.progress.json`);
  writeJsonAtomic(requestFile, {
    protocol: "david_teacher_worker_v1",
    id,
    goal: String(goal || "").trim(),
    max_rounds: 8,
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
    const child = spawn(nodeExecutable, [workerFile, "--request", requestFile], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        DAVID_REPOSITORY_ROOT: root,
        DAVID_TEACHER_CHAT_URL:
          process.env.DAVID_TEACHER_CHAT_URL ||
          "https://chatgpt.com/c/6a81285a-3e38-83ed-965a-b221453fb742",
        DAVID_TEACHER_EDGE_PORT: "9444"
      }
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
  TRIGGER_PATTERNS,
  extractTeacherGoal,
  runTeacherWorkerGoal
};
