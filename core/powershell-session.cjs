"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const FIXED_TESTS = [
  {
    name: "npm test",
    command: "npm.cmd",
    args: ["test"],
    timeout_ms: 300000
  },
  {
    name: "DAVID baseline tests",
    command: "node.exe",
    args: ["tests/baseline-tests.cjs"],
    timeout_ms: 180000
  },
  {
    name: "git diff --check",
    command: "git.exe",
    args: ["diff", "--check"],
    timeout_ms: 60000
  }
];

function nowStamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bsb_secret_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_SUPABASE_SECRET]")
    .replace(
      /\b(authorization\s*:\s*bearer)\s+\S+/giu,
      "$1 [REDACTED]"
    )
    .replace(
      /\b(password|passwd|secret|token)\s*=\s*([^\s;]+)/giu,
      "$1=[REDACTED]"
    );
}

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        windowsHide: true,
        timeout: options.timeout_ms || 30000,
        maxBuffer: options.max_buffer || 4 * 1024 * 1024,
        encoding: "utf8",
        env: options.env || process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout || "";
          error.stderr = stderr || "";
          reject(error);
          return;
        }

        resolve({
          stdout: String(stdout || ""),
          stderr: String(stderr || "")
        });
      }
    );
  });
}

async function git(repoRoot, args, timeoutMs = 30000) {
  const result = await runFile("git.exe", args, {
    cwd: repoRoot,
    timeout_ms: timeoutMs
  });

  return result.stdout.trim();
}

function createTerminalHtml() {
  return `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8">
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'"
>
<title>DAVID PowerShell</title>
<style>
  html, body {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #0b0d10;
    color: #e8edf2;
    font-family: Consolas, "Cascadia Mono", monospace;
  }
  header {
    position: sticky;
    top: 0;
    padding: 10px 14px;
    background: #171b21;
    border-bottom: 1px solid #303844;
    font: 600 13px system-ui, sans-serif;
  }
  pre {
    margin: 0;
    padding: 14px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.4;
    font-size: 13px;
  }
</style>
</head>
<body>
<header>DAVID PowerShell · наблюдаван upgrade процес</header>
<pre id="output">DAVID подготвя upgrade сесията...\n</pre>
</body>
</html>`;
}

class PowerShellSession {
  constructor({
    BrowserWindow,
    confirmAction,
    sendStatus,
    repoRoot = path.resolve(__dirname, "..")
  }) {
    this.BrowserWindow = BrowserWindow;
    this.confirmAction = confirmAction;
    this.sendStatus = sendStatus;
    this.repoRoot = repoRoot;
    this.window = null;
    this.windowReady = false;
    this.pendingOutput = [];
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    this.windowReady = false;
    this.pendingOutput = [];

    this.window = new this.BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 760,
      minHeight: 480,
      title: "DAVID PowerShell",
      show: false,
      frame: true,
      resizable: true,
      minimizable: true,
      maximizable: true,
      fullscreenable: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      autoHideMenuBar: true,
      backgroundColor: "#0b0d10",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    this.window.once("ready-to-show", () => {
      if (!this.window || this.window.isDestroyed()) {
        return;
      }

      this.windowReady = true;
      this.window.show();
      this.window.focus();
      this.flushPendingOutput();
    });

    this.window.on("closed", () => {
      this.window = null;
      this.windowReady = false;
      this.pendingOutput = [];
    });

    const html = createTerminalHtml();
    this.window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    );

    return this.window;
  }

  appendOutput(value) {
    const text = redactSecrets(value);

    if (!text) {
      return;
    }

    if (
      !this.window ||
      this.window.isDestroyed() ||
      !this.windowReady
    ) {
      this.pendingOutput.push(text);
      return;
    }

    this.window.webContents
      .executeJavaScript(
        `(() => {
          const output = document.querySelector("#output");
          if (!output) return;
          output.textContent += ${JSON.stringify(text)};
          window.scrollTo(0, document.body.scrollHeight);
        })()`,
        true
      )
      .catch(() => {});
  }

  flushPendingOutput() {
    const output = this.pendingOutput.join("");
    this.pendingOutput = [];

    if (output) {
      this.appendOutput(output);
    }
  }

  async getPreflight() {
    const [branch, head, status] = await Promise.all([
      git(this.repoRoot, ["branch", "--show-current"]),
      git(this.repoRoot, ["rev-parse", "HEAD"]),
      git(this.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
    ]);

    return {
      branch,
      head,
      status,
      clean: status.length === 0
    };
  }

  async prepareCandidateBranch(requestedBranch, currentBranch, head) {
    if (["main", "master"].includes(currentBranch.toLowerCase())) {
      throw new Error(
        "DAVID отказа upgrade от main/master. Стартирай от feature branch."
      );
    }

    const backupBranch =
      `backup/david-upgrade-${nowStamp()}-` +
      crypto.randomBytes(3).toString("hex");

    await git(this.repoRoot, ["branch", backupBranch, head]);

    let branchExists = true;

    try {
      await git(
        this.repoRoot,
        ["show-ref", "--verify", `refs/heads/${requestedBranch}`]
      );
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      const requestedHead = await git(
        this.repoRoot,
        ["rev-parse", requestedBranch]
      );

      if (requestedHead !== head && requestedBranch !== currentBranch) {
        throw new Error(
          "Заявеният candidate branch вече съществува на различен commit."
        );
      }

      if (requestedBranch !== currentBranch) {
        await git(this.repoRoot, ["switch", requestedBranch], 60000);
      }
    } else {
      await git(
        this.repoRoot,
        ["switch", "-c", requestedBranch],
        60000
      );
    }

    return backupBranch;
  }

  createScriptFile(action) {
    const directory = path.join(
      os.tmpdir(),
      "david-upgrade-loop",
      action.action_id.replace(/[^a-z0-9._-]/giu, "_")
    );

    fs.mkdirSync(directory, { recursive: true });

    const scriptPath = path.join(
      directory,
      `upgrade-${Date.now()}.ps1`
    );

    const repoLiteral = this.repoRoot.replace(/'/g, "''");
    const wrapped = [
      "Set-StrictMode -Version Latest",
      '$ErrorActionPreference = "Stop"',
      '$ProgressPreference = "SilentlyContinue"',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
      `Set-Location -LiteralPath '${repoLiteral}'`,
      "",
      action.script,
      ""
    ].join("\r\n");

    fs.writeFileSync(scriptPath, wrapped, "utf8");
    return scriptPath;
  }

  async killProcessTree(pid) {
    try {
      await runFile(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        { timeout_ms: 15000 }
      );
    } catch {
      // The process may have already exited.
    }
  }

  async runProcess(command, args, options = {}) {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    this.appendOutput(
      `\n> ${command} ${args.join(" ")}\n`
    );

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd || this.repoRoot,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });

      const timer = setTimeout(async () => {
        timedOut = true;
        this.appendOutput(
          `\n[DAVID] Timeout след ${options.timeout_ms} ms.\n`
        );
        await this.killProcessTree(child.pid);
      }, options.timeout_ms);

      child.stdout.on("data", (chunk) => {
        const text = redactSecrets(chunk.toString("utf8"));
        stdout += text;
        this.appendOutput(text);
      });

      child.stderr.on("data", (chunk) => {
        const text = redactSecrets(chunk.toString("utf8"));
        stderr += text;
        this.appendOutput(text);
      });

      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once("close", (code, signal) => {
        clearTimeout(timer);

        resolve({
          exit_code: Number.isInteger(code) ? code : null,
          signal: signal || null,
          timed_out: timedOut,
          duration_ms: Date.now() - started,
          stdout,
          stderr
        });
      });
    });
  }

  async runFixedTests() {
    const results = [];

    for (const test of FIXED_TESTS) {
      this.sendStatus(`Проверка: ${test.name}`, "training");

      try {
        const result = await this.runProcess(
          test.command,
          test.args,
          {
            cwd: this.repoRoot,
            timeout_ms: test.timeout_ms
          }
        );

        const ok =
          result.exit_code === 0 &&
          !result.timed_out;

        results.push({
          name: test.name,
          ok,
          exit_code: result.exit_code,
          timed_out: result.timed_out
        });

        if (!ok) {
          break;
        }
      } catch (error) {
        results.push({
          name: test.name,
          ok: false,
          exit_code: null,
          timed_out: false,
          error: error.message
        });
        break;
      }
    }

    return results;
  }

  async run(action, context = {}) {
    const started = Date.now();
    const preflight = await this.getPreflight();

    if (!preflight.clean) {
      throw new Error(
        "DAVID отказа upgrade: working tree има локални промени."
      );
    }

    this.ensureWindow();
    this.appendOutput(
      [
        "\n=== DAVID UPGRADE LOOP ===\n",
        `Job: ${context.job_id || "unknown"}\n`,
        `Round: ${context.round || "unknown"}\n`,
        `Action: ${action.action_id}\n`,
        `Requested branch: ${action.branch}\n`,
        `Script SHA-256: ${action.script_sha256}\n`,
        `Current branch: ${preflight.branch}\n`,
        `Current HEAD: ${preflight.head}\n\n`
      ].join("")
    );

    const approved = await this.confirmAction({
      title: "DAVID иска да стартира контролиран PowerShell upgrade",
      detail:
        `Branch: ${action.branch}\n` +
        `Script SHA-256: ${action.script_sha256}\n` +
        `Timeout: ${action.timeout_ms} ms\n` +
        "След скрипта DAVID ще пусне фиксираните локални тестове."
    });

    if (!approved) {
      return {
        ok: false,
        approved: false,
        error: "Потребителят отказа PowerShell upgrade.",
        duration_ms: Date.now() - started,
        branch_before: preflight.branch,
        branch_after: preflight.branch,
        head_before: preflight.head,
        head_after: preflight.head,
        working_tree_clean_before: true,
        working_tree_clean_after: true,
        fixed_tests: [],
        stdout: "",
        stderr: ""
      };
    }

    let backupBranch = "";
    let processResult = {
      exit_code: null,
      timed_out: false,
      stdout: "",
      stderr: ""
    };
    let fixedTests = [];
    let operationError = null;

    try {
      backupBranch = await this.prepareCandidateBranch(
        action.branch,
        preflight.branch,
        preflight.head
      );

      this.appendOutput(
        `[DAVID] Backup branch: ${backupBranch}\n`
      );

      const scriptPath = this.createScriptFile(action);

      processResult = await this.runProcess(
        "powershell.exe",
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
          cwd: this.repoRoot,
          timeout_ms: action.timeout_ms
        }
      );

      if (
        processResult.exit_code === 0 &&
        !processResult.timed_out
      ) {
        fixedTests = await this.runFixedTests();
      }
    } catch (error) {
      operationError = error;
      this.appendOutput(
        `\n[DAVID ERROR] ${redactSecrets(error.message)}\n`
      );
    }

    const postflight = await this.getPreflight();
    const testsOk =
      fixedTests.length === FIXED_TESTS.length &&
      fixedTests.every((item) => item.ok);

    const ok =
      !operationError &&
      processResult.exit_code === 0 &&
      !processResult.timed_out &&
      testsOk &&
      postflight.branch === action.branch &&
      postflight.clean;

    if (!ok) {
      this.appendOutput(
        "\n[DAVID] Upgrade не е промотиран. Backup branch остава запазен.\n"
      );
    } else {
      this.appendOutput(
        "\n[DAVID] Upgrade и фиксираните тестове са PASS.\n"
      );
    }

    this.sendStatus(
      ok
        ? "PowerShell upgrade и тестовете са PASS."
        : "PowerShell upgrade е FAIL; стабилният branch не е променян.",
      ok ? "ready" : "error"
    );

    return {
      ok,
      approved: true,
      exit_code: processResult.exit_code,
      timed_out: processResult.timed_out,
      duration_ms: Date.now() - started,
      branch_before: preflight.branch,
      branch_after: postflight.branch,
      head_before: preflight.head,
      head_after: postflight.head,
      backup_branch: backupBranch,
      working_tree_clean_before: preflight.clean,
      working_tree_clean_after: postflight.clean,
      fixed_tests: fixedTests,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      error: operationError ? operationError.message : null
    };
  }
}

module.exports = {
  PowerShellSession,
  FIXED_TESTS,
  redactSecrets
};
