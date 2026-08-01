"use strict";

const crypto = require("crypto");

const DAVID_UPGRADE_PROTOCOL = "david_upgrade_loop_v1";
const ALLOWED_UPGRADE_STATUSES = new Set(["action", "done", "blocked"]);
const ALLOWED_UPGRADE_ACTIONS = new Set(["run_powershell_upgrade"]);

const FORBIDDEN_POWERSHELL_PATTERNS = [
  {
    pattern: /\b(?:remove-item|del|erase|rmdir|rd)\b[^\r\n]*(?:-recurse|\/s)\b/iu,
    reason: "рекурсивно изтриване"
  },
  {
    pattern: /\b(?:format|diskpart|clear-disk|initialize-disk)\b/iu,
    reason: "операция върху диск"
  },
  {
    pattern: /\b(?:stop-computer|restart-computer|shutdown)\b/iu,
    reason: "изключване или рестартиране"
  },
  {
    pattern: /\b(?:invoke-expression|iex)\b/iu,
    reason: "динамично изпълнение"
  },
  {
    pattern: /\bset-executionpolicy\b/iu,
    reason: "промяна на ExecutionPolicy"
  },
  {
    pattern: /\b(?:new-service|set-service|sc\.exe|schtasks)\b/iu,
    reason: "системна услуга или scheduled task"
  },
  {
    pattern: /\b(?:reg\.exe|new-itemproperty|set-itemproperty)\b/iu,
    reason: "промяна на Windows Registry"
  },
  {
    pattern: /\b(?:invoke-webrequest|invoke-restmethod|curl(?:\.exe)?|wget|bitsadmin|certutil)\b/iu,
    reason: "непроверено директно изтегляне"
  },
  {
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-|push\b[^\r\n]*--force|tag\b[^\r\n]*-f)\b/iu,
    reason: "разрушителна Git операция"
  },
  {
    pattern: /\bgit\s+(?:checkout|switch)\s+(?:--\s+)?(?:main|master)\b/iu,
    reason: "директно превключване към стабилния branch"
  },
  {
    pattern: /\bgit\s+push\b[^\r\n]*(?:\borigin\s+(?:main|master)\b|HEAD:(?:main|master)\b)/iu,
    reason: "директен push към стабилния branch"
  },
  {
    pattern: /\bgh\s+pr\s+(?:merge|close)\b/iu,
    reason: "автоматичен merge или затваряне на Pull Request"
  },
  {
    pattern: /\b(?:ghp_|github_pat_|sk-[a-z0-9_-]{10,}|sb_secret_|service_role)\b/iu,
    reason: "вграден credential или secret"
  },
  {
    pattern: /\b(?:password|passwd|secret|token)\s*=\s*["'][^"']+["']/iu,
    reason: "вграден credential"
  },
  {
    pattern: /(?:^|[\s"'`])C:\\Windows(?:\\|[\s"'`]|$)/iu,
    reason: "директна промяна в Windows system directory"
  }
];

function findJsonObject(text) {
  const source = String(text || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/iu);

  if (fenced) {
    return fenced[1].trim();
  }

  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
      continue;
    }

    if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;

      if (depth === 0 && start >= 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error("GPT Teacher не върна JSON пакет за upgrade loop.");
}

function assertText(value, label, maxLength, required = true) {
  if (typeof value !== "string") {
    throw new Error(`${label} трябва да е текст.`);
  }

  const normalized = value.trim();

  if (required && !normalized) {
    throw new Error(`${label} е празно.`);
  }

  if (value.length > maxLength) {
    throw new Error(`${label} е прекалено дълго.`);
  }

  return value;
}

function normalizeBranch(value) {
  const branch = assertText(value, "Upgrade branch", 180).trim();

  if (!/^(?:feature|fix|candidate|experiment|sync)\/[a-z0-9][a-z0-9._/-]*$/iu.test(branch)) {
    throw new Error(
      "Upgrade branch трябва да започва с feature/, fix/, candidate/, experiment/ или sync/."
    );
  }

  if (/(?:^|\/)(?:main|master)(?:$|\/)/iu.test(branch)) {
    throw new Error("Upgrade branch не може да бъде main/master.");
  }

  if (branch.includes("..") || branch.endsWith("/") || branch.includes("//")) {
    throw new Error("Upgrade branch има невалидна структура.");
  }

  return branch;
}

function inspectPowerShellScript(script) {
  assertText(script, "PowerShell script", 60000);

  if (script.includes("\0")) {
    throw new Error("PowerShell script съдържа NUL символ.");
  }

  for (const rule of FORBIDDEN_POWERSHELL_PATTERNS) {
    if (rule.pattern.test(script)) {
      throw new Error(
        `PowerShell script е блокиран: ${rule.reason}.`
      );
    }
  }

  return {
    sha256: crypto
      .createHash("sha256")
      .update(script, "utf8")
      .digest("hex"),
    length: script.length
  };
}

function normalizeUpgradeAction(action, index) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error(`Upgrade action ${index + 1} е невалидно.`);
  }

  if (!ALLOWED_UPGRADE_ACTIONS.has(action.action)) {
    throw new Error(
      `Upgrade action ${index + 1} не е разрешено: ${action.action}`
    );
  }

  const actionId = assertText(
    action.action_id,
    `Upgrade action ${index + 1} action_id`,
    120
  ).trim();

  if (!/^[a-z0-9][a-z0-9._:-]*$/iu.test(actionId)) {
    throw new Error(`Upgrade action ${index + 1} има невалидно action_id.`);
  }

  const script = assertText(action.script, "PowerShell script", 60000);
  const inspection = inspectPowerShellScript(script);
  const timeout = Number(action.timeout_ms ?? 600000);

  if (!Number.isFinite(timeout) || timeout < 15000 || timeout > 900000) {
    throw new Error("Upgrade timeout трябва да е между 15000 и 900000 ms.");
  }

  const tests = Array.isArray(action.expected_tests)
    ? action.expected_tests
    : [];

  if (tests.length > 12) {
    throw new Error("Upgrade пакетът има прекалено много expected_tests.");
  }

  const expectedTests = tests.map((item, testIndex) =>
    assertText(
      item,
      `expected_tests[${testIndex}]`,
      240
    ).trim()
  );

  if (action.requires_confirmation !== true) {
    throw new Error(
      "PowerShell upgrade действието трябва да изисква потвърждение."
    );
  }

  return {
    action: "run_powershell_upgrade",
    action_id: actionId,
    branch: normalizeBranch(action.branch),
    script,
    script_sha256: inspection.sha256,
    timeout_ms: Math.round(timeout),
    expected_tests: expectedTests,
    requires_confirmation: true
  };
}

function validateUpgradePacket(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new Error("Невалиден GPT upgrade пакет.");
  }

  if (packet.protocol !== DAVID_UPGRADE_PROTOCOL) {
    throw new Error("GPT upgrade пакетът е с непознат protocol.");
  }

  if (!ALLOWED_UPGRADE_STATUSES.has(packet.status)) {
    throw new Error("GPT upgrade пакетът е с невалиден status.");
  }

  const jobId = assertText(packet.job_id, "Upgrade job_id", 120).trim();

  if (!/^[a-z0-9][a-z0-9._:-]*$/iu.test(jobId)) {
    throw new Error("Upgrade job_id е невалидно.");
  }

  const round = Number(packet.round);

  if (!Number.isInteger(round) || round < 1 || round > 8) {
    throw new Error("Upgrade round трябва да е цяло число между 1 и 8.");
  }

  const summary = assertText(
    packet.summary || "",
    "Upgrade summary",
    2000,
    false
  );

  const actions = Array.isArray(packet.actions) ? packet.actions : [];

  if (packet.status === "action" && actions.length !== 1) {
    throw new Error(
      "Upgrade action пакетът трябва да съдържа точно едно действие."
    );
  }

  if (packet.status !== "action" && actions.length !== 0) {
    throw new Error(
      "Upgrade done/blocked пакетът не трябва да съдържа действия."
    );
  }

  return {
    protocol: DAVID_UPGRADE_PROTOCOL,
    job_id: jobId,
    round,
    status: packet.status,
    summary,
    actions: actions.map(normalizeUpgradeAction)
  };
}

function parseUpgradePacket(text) {
  const json = findJsonObject(text);

  try {
    return validateUpgradePacket(JSON.parse(json));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Невалиден JSON от GPT Teacher: ${error.message}`);
    }
    throw error;
  }
}

function limitOutput(value, maxLength = 100000) {
  const text = String(value || "");

  if (text.length <= maxLength) {
    return { text, truncated: false };
  }

  const headLength = Math.floor(maxLength * 0.35);
  const tailLength = maxLength - headLength;

  return {
    text:
      text.slice(0, headLength) +
      "\n\n...[DAVID OUTPUT TRUNCATED]...\n\n" +
      text.slice(-tailLength),
    truncated: true
  };
}

function buildUpgradeResult({ packet, action, result }) {
  const stdout = limitOutput(result.stdout);
  const stderr = limitOutput(result.stderr);

  return JSON.stringify(
    {
      protocol: DAVID_UPGRADE_PROTOCOL,
      job_id: packet.job_id,
      round: packet.round,
      status: "result",
      action_id: action.action_id,
      action: action.action,
      script_sha256: action.script_sha256,
      result: {
        ok: Boolean(result.ok),
        approved: Boolean(result.approved),
        exit_code:
          Number.isInteger(result.exit_code) ? result.exit_code : null,
        timed_out: Boolean(result.timed_out),
        duration_ms: Number(result.duration_ms || 0),
        branch_requested: action.branch,
        branch_before: result.branch_before || "",
        branch_after: result.branch_after || "",
        head_before: result.head_before || "",
        head_after: result.head_after || "",
        backup_branch: result.backup_branch || "",
        working_tree_clean_before:
          Boolean(result.working_tree_clean_before),
        working_tree_clean_after:
          Boolean(result.working_tree_clean_after),
        fixed_tests: result.fixed_tests || [],
        expected_tests: action.expected_tests,
        stdout: stdout.text,
        stdout_truncated: stdout.truncated,
        stderr: stderr.text,
        stderr_truncated: stderr.truncated,
        error: result.error || null
      }
    },
    null,
    2
  );
}

module.exports = {
  DAVID_UPGRADE_PROTOCOL,
  ALLOWED_UPGRADE_STATUSES,
  ALLOWED_UPGRADE_ACTIONS,
  FORBIDDEN_POWERSHELL_PATTERNS,
  findJsonObject,
  inspectPowerShellScript,
  validateUpgradePacket,
  parseUpgradePacket,
  buildUpgradeResult
};
