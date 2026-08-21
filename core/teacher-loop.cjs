"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadConfig } = require("./config.cjs");
const { DeviceBridgeClient } = require("./device-bridge-client.cjs");
const { analyzeKnowledgeGap } = require("./knowledge-gap-engine.cjs"); // DAVID_KNOWLEDGE_GAP_LIVE_V20_1
const { getBuiltInSkills } = require("./builtin-skills.cjs");
const {
  SupabaseMemory,
  buildMemoryContext,
  normalizeMemoryInput
} = require("./supabase-memory.cjs"); // DAVID_AGI_SUPABASE_MEMORY_V15

const PROTOCOL = "david_upgrade_loop_v1";
const MAX_FORMAT_REPAIR_ATTEMPTS = 2;
const ALLOWED_POWERSHELL_ACTIONS = new Set([
  "run_powershell_upgrade",
  "run_powershell",
  "powershell"
]);
const MEMORY_ACTION = "promote_memory";

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

function buildPowerShellEnvironment({ jobId, round, repositoryRoot }) {
  // Do not expose the Electron/bridge environment (tokens, keys, passwords)
  // to GPT-authored PowerShell. Keep only the Windows variables required to
  // locate executables and use the current interactive profile.
  const allowedNames = new Set([
    "ALLUSERSPROFILE",
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PSMODULEPATH",
    "PUBLIC",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR"
  ]);
  const safe = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (allowedNames.has(name.toUpperCase())) safe[name] = value;
  }
  return {
    ...safe,
    DAVID_JOB_ID: jobId,
    DAVID_ROUND: String(round),
    DAVID_REPOSITORY_ROOT: repositoryRoot
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

function doubleUnpairedBackslashes(value) {
  const source = String(value || "");
  let result = "";

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\\") {
      result += source[index];
      continue;
    }

    let end = index;
    while (end < source.length && source[end] === "\\") end += 1;
    const count = end - index;
    result += "\\".repeat(count % 2 === 0 ? count : count + 1);
    index = end - 1;
  }

  return result;
}

function normalizeRawWindowsPathsInJson(value) {
  // DAVID_TEACHER_LOCAL_JSON_NORMALIZER_V1
  // GPT sometimes emits a PowerShell single-quoted Windows path inside a JSON
  // string with raw backslashes (E:\path). JSON requires those backslashes to
  // be doubled. Restrict the repair to an unambiguous single-quoted absolute
  // Windows path so script semantics outside the path are never guessed.
  return String(value || "").replace(
    /'([a-z]:\\[^'\r\n]*)'/giu,
    (_match, rawPath) => `'${doubleUnpairedBackslashes(rawPath)}'`
  );
}

function normalizeInvalidJsonStringEscapes(value) {
  // DAVID_TEACHER_JSON_STRING_ESCAPE_NORMALIZER_V2
  // PowerShell regexes often contain raw escapes such as \s, \d, \( or \[.
  // Those are meaningful to PowerShell/.NET regex but invalid inside a JSON
  // string. Repair only backslashes that JSON itself cannot interpret while
  // preserving every valid JSON escape. Absolute single-quoted Windows paths
  // are normalized first because path segments beginning with t/n/r/b/f can
  // otherwise look like valid JSON control escapes and silently change data.
  const source = String(value || "");
  let result = "";
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (!inString) {
      result += char;
      if (char === '"') inString = true;
      continue;
    }

    if (char === '"') {
      result += char;
      inString = false;
      continue;
    }

    if (char !== "\\") {
      result += char;
      continue;
    }

    const next = source[index + 1];
    if (next === undefined) {
      result += "\\\\";
      continue;
    }

    if ('"\\/bfnrt'.includes(next)) {
      result += `\\${next}`;
      index += 1;
      continue;
    }

    if (
      next === "u" &&
      /^[0-9a-f]{4}$/iu.test(source.slice(index + 2, index + 6))
    ) {
      result += source.slice(index, index + 6);
      index += 5;
      continue;
    }

    result += "\\\\";
  }

  return result;
}

function recoverKnownUiSuffixJsonEnvelope(value) {
  // DAVID_TEACHER_UI_SUFFIX_ENVELOPE_RECOVERY_V3
  // The Edge text transport can replace only the final one or two JSON
  // container closers with the exact UI artifact _](). Recover that one proven
  // corruption only when every JSON string is already closed, nesting is
  // otherwise consistent, at most two outer containers remain, and the result
  // parses as a JSON object. Anything else remains invalid and is never run.
  const source = String(value || "").trim();
  const suffixPattern = /(?:\r?\n)?_\]\(\)\s*$/u;
  if (!suffixPattern.test(source)) return source;

  const body = source.replace(suffixPattern, "").trimEnd();
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const char of body) {
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
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) return source;
    }
  }

  if (inString || escaped || stack.length > 2) return source;

  const closers = stack
    .reverse()
    .map((open) => open === "{" ? "}" : "]")
    .join("");
  const recovered = `${body}${closers}`;

  try {
    const parsed = JSON.parse(recovered);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? recovered
      : source;
  } catch {
    return source;
  }
}

function normalizeTeacherAction(action, index) {
  if (!action || typeof action !== "object") return null;

  const actionName = String(action.action || action.type || "").trim();
  if (actionName === MEMORY_ACTION) {
    const memory = {
      title: String(action.title || "").trim(),
      content: String(action.content || "").trim(),
      memoryType: String(action.memory_type || "lesson").trim(),
      evidence: Array.isArray(action.evidence)
        ? action.evidence.slice(0, 20)
        : [],
      source:
        action.source && typeof action.source === "object" && !Array.isArray(action.source)
          ? action.source
          : {}
    };
    try {
      normalizeMemoryInput({ ...memory, humanApproved: true });
    } catch {
      return null;
    }
    return {
      action: MEMORY_ACTION,
      action_id: String(action.action_id || `round-memory-${index + 1}`),
      ...memory,
      requires_confirmation: true,
      expected_tests: Array.isArray(action.expected_tests)
        ? action.expected_tests.map(String).slice(0, 20)
        : []
    };
  }

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
    const pathNormalized = normalizeRawWindowsPathsInJson(candidate);
    const escapeNormalized = normalizeInvalidJsonStringEscapes(pathNormalized);
    const envelopeNormalized = recoverKnownUiSuffixJsonEnvelope(
      escapeNormalized
    );
    const variants = [...new Set([
      candidate,
      pathNormalized,
      escapeNormalized,
      envelopeNormalized
    ])];

    for (const variant of variants) {
      try {
        const parsed = JSON.parse(variant);
        if (!parsed || typeof parsed !== "object") continue;

        const status = String(parsed.status || "").toLowerCase();
        const actionSource = parsed.actions ?? parsed.action;
        const rawActions = Array.isArray(actionSource)
          ? actionSource
          : actionSource && typeof actionSource === "object"
            ? [actionSource]
            : [];
        const actions = rawActions
          .map(normalizeTeacherAction)
          .filter(Boolean)
          .slice(0, 3);

        if (["completed", "blocked", "action"].includes(status)) {
          if (status === "action" && actions.length === 0) {
            throw new Error(
              "GPT върна status=action, но няма валидно PowerShell или memory действие."
            );
          }

          return {
            protocol: String(parsed.protocol || PROTOCOL),
            job_id: parsed.job_id ? String(parsed.job_id) : null,
            round: Number(parsed.round) || null,
            status,
            summary: String(parsed.summary || parsed.message || "").trim(),
            actions,
            transport_normalized: candidate !== text || variant !== candidate,
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

function buildFormatRepairRequest({
  jobId,
  round,
  invalidResponse,
  parseError,
  attempt,
  maxAttempts = MAX_FORMAT_REPAIR_ATTEMPTS,
  maxResponseChars = 16000
}) {
  const compact = truncateMiddle(
    invalidResponse,
    Math.max(4000, Math.min(Number(maxResponseChars) || 16000, 30000))
  );

  return JSON.stringify(
    {
      protocol: PROTOCOL,
      job_id: jobId,
      round,
      status: "format_repair",
      repair_attempt: attempt,
      max_repair_attempts: maxAttempts,
      parser_error: String(parseError?.message || parseError || "Invalid JSON"),
      invalid_response: compact.text,
      invalid_response_truncated: compact.truncated,
      repair_instructions: [
        "Поправи само формата на предишния си отговор; не сменяй намерението на действието.",
        "Върни само един валиден JSON обект без markdown и без текст извън JSON.",
        `protocol трябва да е ${PROTOCOL}.`,
        "Разрешени status стойности: action, completed, blocked.",
        "При status=action върни actions масив. PowerShell действие съдържа action, action_id, script, timeout_ms, expected_tests и requires_confirmation. Memory действие съдържа action=promote_memory, action_id, memory_type, title, content, evidence и requires_confirmation=true.",
        "Полето script трябва да е валиден JSON string: escape-вай всяка двойна кавичка и всяка обратна наклонена черта според JSON.",
        "За PowerShell използвай единични кавички, когато е възможно, за да намалиш нуждата от escaping.",
        "Не добавяй ново действие и не изпълнявай нищо в този отговор.",
        "Ако намерението не може да бъде възстановено надеждно, върни status=blocked с точна summary причина."
      ]
    },
    null,
    2
  );
}

function classifyPowerShellRisk(script, repositoryRoot) {
  const text = String(script || "");
  const lower = text.toLowerCase();
  const reasons = [];
  let blocked = false;
  let level = "low";
  let outsideRepository = false;

  const blockedPatterns = [
    [/(?:^|\s)format-volume\b/i, "форматиране на дял"],
    [/(?:^|\s)clear-disk\b/i, "изчистване на диск"],
    [/(?:^|\s)initialize-disk\b/i, "инициализиране на диск"],
    [/(?:^|\s)remove-partition\b/i, "изтриване на дял"],
    [/(?:^|\s)(?:stop-computer|restart-computer)\b/i, "спиране или рестарт на компютъра"],
    [/\bbcdedit\b/i, "промяна на boot конфигурацията"],
    [/\breg(?:\.exe)?\s+delete\s+hklm\\/i, "изтриване от HKLM регистъра"],
    [/remove-item[^\r\n]*(?:[a-z]:\\(?:\s|["']?$)|c:\\windows|c:\\users)(?:[^a-z]|$)/i, "масово изтриване извън DAVID проекта"],
    [/\b(?:-encodedcommand|frombase64string|invoke-expression|iex)\b/i, "скрито или динамично изпълнение"],
    [/(?:\.env(?:\.|\b)|david_device_token|service_role|private[_-]?key|password|credential)/i, "достъп до тайни или идентификационни данни"],
    [/\b(?:get-childitem|dir|ls)\s+env:|\[environment\]::getenvironmentvariable/i, "четене на process environment"]
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

  const rawRoot = String(repositoryRoot || process.cwd());
  const resolvedRoot = /^[a-z]:[\\/]/i.test(rawRoot)
    ? rawRoot
    : path.resolve(rawRoot);
  const normalizedRoot = resolvedRoot
    .replace(/\//g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
  const absolutePaths = text.match(/[a-z]:[\\/][^\r\n"'`]*/gi) || [];

  for (const candidate of absolutePaths) {
    const cleaned = candidate
      .replace(/[\s),;]+$/g, "")
      .trim()
      .replace(/\//g, "\\")
      .toLowerCase();
    if (!cleaned) continue;

    if (
      !cleaned.startsWith(normalizedRoot) &&
      !cleaned.startsWith("c:\\program files\\git") &&
      !cleaned.startsWith("c:\\windows\\system32\\windowspowershell")
    ) {
      outsideRepository = true;
      if (!blocked && level === "low") level = "high";
      reasons.push(`абсолютен път извън проекта: ${candidate.slice(0, 180)}`);
    }
  }

  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/m.test(text)) {
    outsideRepository = true;
    if (!blocked && level === "low") level = "high";
    reasons.push("path traversal извън DAVID проекта");
  }

  if (!blocked && level === "low") {
    if (/\b(?:remove-item|set-content|add-content|out-file|new-item|move-item|rename-item|copy-item)\b/i.test(lower)) {
      level = "medium";
      reasons.push("промяна на файлове");
    }
  }

  return {
    blocked,
    level,
    outsideRepository,
    reasons: [...new Set(reasons)]
  };
}

function isRepositoryAutonomyEligible(script, risk) {
  // DAVID_SCOPED_REPOSITORY_AUTONOMY_V1
  // Owner-authorized self-development: low/medium actions may run without a
  // prompt only while the classifier proves they stay inside the repository.
  // Deletion, process control, system configuration and external publication
  // remain outside this automatic grant.
  const text = String(script || "");
  if (!risk || risk.blocked || risk.outsideRepository) return false;
  if (!new Set(["low", "medium"]).has(String(risk.level || ""))) return false;

  const manualOnlyPatterns = [
    /\bremove-item\b/i,
    /\b(?:stop-process|start-process|stop-service|restart-service)\b/i,
    /\b(?:register-scheduledtask|schtasks)\b/i,
    /\b(?:set-itemproperty|new-itemproperty|remove-itemproperty)\b/i,
    /\bgit\s+(?:push|merge|rebase|reset|clean)\b/i,
    /\b(?:npm\s+publish|vercel\s+--prod)\b/i
  ];
  return !manualOnlyPatterns.some((pattern) => pattern.test(text));
}

// DAVID_WORKER_MEMORY_BRIDGE_V17_2
async function syncDavidMemoryContextV172(config = {}) {
  const baseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
  const token = String(config.deviceToken || "").trim();
  if (!baseUrl || token.length < 32) {
    return { ok: false, skipped: true, reason: "not_configured", count: 0, items: [] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${baseUrl}/functions/v1/david-memory-bridge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-david-device-token": token
      },
      body: JSON.stringify({
        op: "sync_context",
        payload: { limit: 100, include_sensitive: false }
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `DAVID memory bridge HTTP ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function buildMemoryContextForThinkerV172(davidMemoryPayloadV172) {
  if (!davidMemoryPayloadV172 || typeof davidMemoryPayloadV172 !== "object" || davidMemoryPayloadV172.ok !== true) {
    return {
      status: "DAVID_MEMORY_UNAVAILABLE",
      approved_lessons: 0,
      verified_lessons: 0,
      active_count: 0,
      loaded_count: 0,
      items: []
    };
  }

  const sourceItems = Array.isArray(davidMemoryPayloadV172.items) ? davidMemoryPayloadV172.items : [];
  const items = [];
  let contentChars = 0;
  for (const item of sourceItems) {
    const content = String(item?.content || "");
    if (contentChars + content.length > 50000) break;
    contentChars += content.length;
    items.push({
      record_id: Number(item?.record_id) || null,
      type: String(item?.type || "fact"),
      title: item?.title == null ? null : String(item.title),
      content,
      importance: Number(item?.importance) || 3,
      confidence: Number(item?.confidence) || 0,
      checksum: String(item?.checksum || "")
    });
  }

  return {
    status: String(davidMemoryPayloadV172.status || "DAVID_MEMORY_READY"),
    table: String(davidMemoryPayloadV172.table || "sf_twin_memory_items"),
    twin_id: davidMemoryPayloadV172.twin_id || null,
    approved_lessons: Number(davidMemoryPayloadV172.approved) || 0,
    inserted_now: Number(davidMemoryPayloadV172.inserted) || 0,
    verified_lessons: Number(davidMemoryPayloadV172.verified) || 0,
    active_count: Number(davidMemoryPayloadV172.count) || 0,
    loaded_count: items.length,
    context_checksum: String(davidMemoryPayloadV172.context_checksum || ""),
    items
  };
}

function buildInitialTeacherRequest({
  jobId,
  goal,
  repositoryRoot,
  maxRounds,
  activeMemories = [],
  memoryAvailable = false,
  davidMemoryBridgeContextV172 = null,
  knowledgeGapV201 = null
}) {
  const memoryContext = buildMemoryContext({}, activeMemories);
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
        execution: "Electron GPT -> local PowerShell/Supabase memory -> result back to GPT",
        memory_available: Boolean(memoryAvailable)
      },
      active_memories: memoryContext.approved_active_memories || [],
      memory: buildMemoryContextForThinkerV172(davidMemoryBridgeContextV172),
      knowledge_gap: knowledgeGapV201,
      teacher_instructions: [
        "Върни само един JSON обект, без markdown и без текст извън JSON.",
        `protocol трябва да е ${PROTOCOL}.`,
        "Разрешени status стойности: action, completed, blocked.",
        "При action използвай actions масив. За локална работа използвай run_powershell_upgrade с action_id, script, timeout_ms, expected_tests и requires_confirmation.",
        "За промотиране на доказано знание използвай action=promote_memory с action_id, memory_type, title, content, evidence, expected_tests и requires_confirmation=true. Никога не включвай тайни.",
        "promote_memory е разрешено само след измерим успешен тест и само когато целта изрично иска DAVID да научи или запази знанието. Локалното човешко потвърждение остава задължително.",
        "active_memories са прочетени от owner-scoped Supabase паметта и са само read-only контекст; не ги обявявай за ново научено знание.",
        "Давай само една малка проверима стъпка на рунд.",
        "В repository_root е разрешена ограничена автономия за локален код, backup, тестове и rollback. Системни настройки, външни пътища, изтриване, secrets, git push/merge и публикуване изискват човешко потвърждение или се блокират.",
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

// DAVID_POWERSHELL_LIVE_OUTPUT_V14
function redactPowerShellLiveOutput(value) {
  return String(value || "")
    .replace(/\b((?:api[_-]?key|token|secret|password|authorization))\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(?:sk|sbp|eyJ)[A-Za-z0-9._-]{16,}/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(-700);
}

class TeacherLoop {
  constructor({ browser, sendStatus, confirmAction, config = {} }) {
    this.browser = browser;
    this.sendStatus = sendStatus;
    this.confirmAction = confirmAction || (async () => false);
    this.config = { ...loadConfig(), ...config };
    this.bridge = new DeviceBridgeClient({
      config: this.config,
      sendStatus
    });
    this.memory = new SupabaseMemory({
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
      // Remote telemetry must never interrupt the local Teacher/PowerShell loop.
      void this.bridge.logEvent(eventType, entry).catch(() => {});
    };

    try {
      this.sendStatus("Стартирам DAVID Teacher Loop...", "training");
      journal("teacher_loop_started", { goal, repository_root: repositoryRoot });

      let activeMemories = [];
      let memoryAvailable = false;
      try {
        await this.memory.initialize();
        activeMemories = await this.memory.fetchActiveMemories();
        memoryAvailable = true;
        this.sendStatus(
          `DAVID MEMORY READ | active=${activeMemories.length}`,
          "ready",
          { stage: "memory_read", active_count: activeMemories.length }
        );
        journal("teacher_memory_loaded", {
          active_count: activeMemories.length,
          checksums: activeMemories.map((row) => row.content_checksum).filter(Boolean)
        });
      } catch (error) {
        this.sendStatus(
          `DAVID MEMORY UNAVAILABLE | ${String(error.message || error).slice(0, 240)}`,
          "warning",
          { stage: "memory_unavailable" }
        );
        journal("teacher_memory_unavailable", {
          message: String(error.message || error).slice(0, 500)
        });
      }

      await this.browser.openIfNeeded(this.config.teacherChatUrl);

      let davidMemoryBridgeContextV172 = null;
      try {
        this.sendStatus("DAVID MEMORY · syncing approved knowledge...", "working", {
          stage: "david_memory"
        });
        davidMemoryBridgeContextV172 = await syncDavidMemoryContextV172(this.config);
        if (!davidMemoryBridgeContextV172 || davidMemoryBridgeContextV172.ok !== true) {
          throw new Error(String(davidMemoryBridgeContextV172?.error || davidMemoryBridgeContextV172?.reason || "memory bridge unavailable"));
        }
        this.sendStatus(
          `DAVID MEMORY READY · approved=${Number(davidMemoryBridgeContextV172.approved || 0)} · verified=${Number(davidMemoryBridgeContextV172.verified || 0)} · active=${Number(davidMemoryBridgeContextV172.count || 0)}`,
          "ready",
          {
            stage: "david_memory",
            twin_id: davidMemoryBridgeContextV172.twin_id || null,
            approved: Number(davidMemoryBridgeContextV172.approved || 0),
            verified: Number(davidMemoryBridgeContextV172.verified || 0),
            active_count: Number(davidMemoryBridgeContextV172.count || 0),
            context_checksum: String(davidMemoryBridgeContextV172.context_checksum || "")
          }
        );
        journal("david_memory_ready", {
          twin_id: davidMemoryBridgeContextV172.twin_id || null,
          approved: Number(davidMemoryBridgeContextV172.approved || 0),
          inserted: Number(davidMemoryBridgeContextV172.inserted || 0),
          verified: Number(davidMemoryBridgeContextV172.verified || 0),
          count: Number(davidMemoryBridgeContextV172.count || 0),
          context_checksum: String(davidMemoryBridgeContextV172.context_checksum || ""),
          record_ids: (Array.isArray(davidMemoryBridgeContextV172.items) ? davidMemoryBridgeContextV172.items : [])
            .map((item) => Number(item?.record_id) || null)
            .filter(Boolean)
        });
      } catch (memoryError) {
        davidMemoryBridgeContextV172 = {
          ok: false,
          status: "DAVID_MEMORY_UNAVAILABLE",
          error: String(memoryError?.message || memoryError),
          count: 0,
          items: []
        };
        this.sendStatus(`DAVID MEMORY unavailable: ${davidMemoryBridgeContextV172.error}`, "warning", {
          stage: "david_memory"
        });
        journal("david_memory_unavailable", { error: davidMemoryBridgeContextV172.error });
      }

      // DAVID_KNOWLEDGE_GAP_LIVE_V20_1
      let knowledgeGapV201 = null;

      try {
        const approvedSkillsV201 =
          typeof getBuiltInSkills === "function"
            ? getBuiltInSkills()
            : [];

        const bridgeMemoriesV201 =
          davidMemoryBridgeContextV172 &&
          davidMemoryBridgeContextV172.ok === true &&
          Array.isArray(davidMemoryBridgeContextV172.items)
            ? davidMemoryBridgeContextV172.items.map((item) => ({
                id: item?.record_id ?? item?.id ?? null,
                record_id: item?.record_id ?? item?.id ?? null,
                status: "active",
                is_user_confirmed: true,
                deleted_at: null,
                is_sensitive: false,
                memory_type: String(item?.type || item?.memory_type || "fact"),
                title: item?.title == null ? null : String(item.title),
                content: String(item?.content || ""),
                tags: item?.tags || []
              }))
            : [];

        knowledgeGapV201 = analyzeKnowledgeGap({
          task: String(goal || ""),
          memories: bridgeMemoriesV201,
          skills: approvedSkillsV201
        });

        this.sendStatus(
          `DAVID KNOWLEDGE GAP | ${knowledgeGapV201.classification} | learning=${knowledgeGapV201.needs_learning ? "YES" : "NO"}`,
          knowledgeGapV201.classification === "KNOWN" ? "ready" : "working",
          {
            stage: "knowledge_gap_v20_1",
            classification: knowledgeGapV201.classification,
            status: knowledgeGapV201.status,
            needs_learning: Boolean(knowledgeGapV201.needs_learning),
            skill_matches: Number(knowledgeGapV201?.evidence?.approved_skill_matches?.length || 0),
            memory_matches: Number(knowledgeGapV201?.evidence?.approved_memory_matches?.length || 0)
          }
        );

        journal("david_knowledge_gap_v20_1", {
          classification: knowledgeGapV201.classification,
          status: knowledgeGapV201.status,
          needs_learning: Boolean(knowledgeGapV201.needs_learning),
          confidence: Number(knowledgeGapV201.confidence || 0),
          skill_matches: knowledgeGapV201?.evidence?.approved_skill_matches || [],
          memory_matches: knowledgeGapV201?.evidence?.approved_memory_matches || [],
          unknown: knowledgeGapV201.unknown || []
        });
      }
      catch (knowledgeGapErrorV201) {
        knowledgeGapV201 = {
          protocol: "david_knowledge_gap_v20",
          status: "KNOWLEDGE_GAP_UNAVAILABLE",
          classification: "UNKNOWN",
          needs_learning: true,
          confidence: 0,
          task: String(goal || ""),
          evidence: {
            approved_skill_matches: [],
            approved_memory_matches: []
          },
          unknown: [{
            requirement: String(goal || ""),
            reason: "Knowledge-gap analysis failed closed; capability is not proven."
          }],
          known: [],
          reason: String(knowledgeGapErrorV201?.message || knowledgeGapErrorV201)
        };

        this.sendStatus(
          `DAVID KNOWLEDGE GAP unavailable | fail-closed UNKNOWN | ${knowledgeGapV201.reason.slice(0, 220)}`,
          "warning",
          {
            stage: "knowledge_gap_v20_1",
            classification: "UNKNOWN",
            needs_learning: true,
            fail_closed: true
          }
        );

        journal("david_knowledge_gap_v20_1_error", {
          error: knowledgeGapV201.reason,
          fail_closed: true
        });
      }

      let outgoing = buildInitialTeacherRequest({
        jobId,
        goal,
        repositoryRoot,
        maxRounds: this.config.maxTeacherRounds,
        activeMemories,
        memoryAvailable,
        davidMemoryBridgeContextV172,
        knowledgeGapV201
      });

      const sendTeacherPrompt = async (prompt) => {
        if (typeof this.browser.sendAndWait === "function") {
          return this.browser.sendAndWait({
            url: this.config.teacherChatUrl,
            prompt,
            timeoutMs: this.config.gptResponseTimeoutMs
          });
        }

        const before = await this.browser.sendChatGptMessage(prompt);
        return this.browser.waitForChatGptResponse({
          before,
          timeoutMs: this.config.gptResponseTimeoutMs
        });
      };

      for (let round = 1; round <= this.config.maxTeacherRounds; round += 1) {
        this.sendStatus(
          `Teacher рунд ${round}: изпращам към GPT...`,
          "training"
        );

        let responseText = await sendTeacherPrompt(outgoing);

        const compactResponse = truncateMiddle(
          responseText,
          this.config.maxTeacherOutputChars
        );
        journal("teacher_gpt_response", {
          round,
          response: compactResponse
        });

        // DAVID_TEACHER_FORMAT_REPAIR_V1
        // Never execute a malformed response. Ask GPT to repair only the
        // machine format, then parse the replacement under the same strict
        // contract. The bounded retry prevents an infinite repair loop.
        let response = null;
        let lastParseError = null;

        for (
          let repairAttempt = 0;
          repairAttempt <= MAX_FORMAT_REPAIR_ATTEMPTS;
          repairAttempt += 1
        ) {
          try {
            response = parseTeacherResponse(responseText);
            if (response.transport_normalized) {
              journal("teacher_format_repaired_locally", {
                round,
                repair_attempt: repairAttempt,
                status: response.status
              });
            }
            if (repairAttempt > 0) {
              journal("teacher_format_repair_succeeded", {
                round,
                repair_attempt: repairAttempt,
                status: response.status
              });
            }
            break;
          } catch (error) {
            lastParseError = error;
            const invalid = truncateMiddle(
              responseText,
              this.config.maxTeacherOutputChars
            );
            journal("teacher_format_invalid", {
              round,
              repair_attempt: repairAttempt,
              error: String(error.message || error),
              response: invalid
            });

            if (repairAttempt >= MAX_FORMAT_REPAIR_ATTEMPTS) break;

            const nextAttempt = repairAttempt + 1;
            this.sendStatus(
              `Teacher JSON форматът е невалиден; автоматична поправка ${nextAttempt}/${MAX_FORMAT_REPAIR_ATTEMPTS}...`,
              "warning"
            );

            const repairPrompt = buildFormatRepairRequest({
              jobId,
              round,
              invalidResponse: responseText,
              parseError: error,
              attempt: nextAttempt,
              maxAttempts: MAX_FORMAT_REPAIR_ATTEMPTS,
              maxResponseChars: this.config.maxTeacherOutputChars
            });
            journal("teacher_format_repair_requested", {
              round,
              repair_attempt: nextAttempt
            });

            responseText = await sendTeacherPrompt(repairPrompt);
            const repairedCompact = truncateMiddle(
              responseText,
              this.config.maxTeacherOutputChars
            );
            journal("teacher_format_repair_response", {
              round,
              repair_attempt: nextAttempt,
              response: repairedCompact
            });
          }
        }

        if (!response) {
          throw new Error(
            `GPT върна невалиден DAVID JSON след ${MAX_FORMAT_REPAIR_ATTEMPTS} автоматични format-repair опита: ${String(
              lastParseError?.message || lastParseError || "unknown parse error"
            )}`
          );
        }

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
          if (action.action === MEMORY_ACTION) {
            const normalizedMemory = normalizeMemoryInput({
              title: action.title,
              content: action.content,
              memoryType: action.memoryType,
              evidence: action.evidence,
              source: {
                ...action.source,
                job_id: jobId,
                round,
                action_id: action.action_id
              },
              humanApproved: true
            });
            const checksum = normalizedMemory.contentChecksum;
            journal("teacher_memory_planned", {
              round,
              action_id: action.action_id,
              memory_type: normalizedMemory.memoryType,
              title: normalizedMemory.title,
              checksum
            });
            this.sendStatus(
              `ЧАКАМ ОДОБРЕНИЕ | MEMORY | ${normalizedMemory.title} | ${checksum.slice(0, 12)}`,
              "warning",
              { stage: "confirmation_pending", round, action_id: action.action_id }
            );
            const allowed = await this.confirmAction({
              title: "DAVID иска да запише доказано знание в Supabase паметта",
              detail:
                `Тип: ${normalizedMemory.memoryType}\n` +
                `Заглавие: ${normalizedMemory.title}\n` +
                `SHA-256: ${checksum}\n\n` +
                normalizedMemory.content.slice(0, 1800)
            });
            if (!allowed) {
              const denied = {
                action_id: action.action_id,
                ok: false,
                status: "rejected_by_user",
                checksum
              };
              actionResults.push(denied);
              journal("teacher_memory_rejected", { round, ...denied });
              break;
            }
            if (!memoryAvailable) {
              const unavailable = {
                action_id: action.action_id,
                ok: false,
                status: "memory_unavailable",
                checksum
              };
              actionResults.push(unavailable);
              journal("teacher_memory_failed", { round, ...unavailable });
              break;
            }
            this.sendStatus(
              `MEMORY WRITE | ${normalizedMemory.title}`,
              "working",
              { stage: "memory_write", round, action_id: action.action_id }
            );
            try {
              const promoted = await this.memory.promoteApprovedMemory({
                title: normalizedMemory.title,
                content: normalizedMemory.content,
                memoryType: normalizedMemory.memoryType,
                evidence: normalizedMemory.evidence,
                source: normalizedMemory.source,
                humanApproved: true
              });
              const result = {
                action_id: action.action_id,
                ok: true,
                ...promoted,
                expected_tests: action.expected_tests
              };
              actionResults.push(result);
              journal("teacher_memory_promoted", { round, ...result });
              this.sendStatus(
                `MEMORY_PROMOTED | ${result.record_id} | ${result.checksum.slice(0, 12)}`,
                "success",
                {
                  stage: "memory_promoted",
                  round,
                  action_id: action.action_id,
                  record_id: result.record_id,
                  checksum: result.checksum
                }
              );
            } catch (error) {
              const failed = {
                action_id: action.action_id,
                ok: false,
                status: "memory_write_failed",
                error: String(error.message || error).slice(0, 500),
                checksum
              };
              actionResults.push(failed);
              journal("teacher_memory_failed", { round, ...failed });
              this.sendStatus(
                `MEMORY WRITE FAILED | ${failed.error}`,
                "error",
                { stage: "memory_failed", round, action_id: action.action_id }
              );
            }
            if (!actionResults.at(-1)?.ok) break;
            continue;
          }

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

          const repositoryAutonomy =
            Boolean(this.config.autoApproveRepositoryPowerShell) &&
            isRepositoryAutonomyEligible(action.script, risk);
          const needsConfirmation =
            !repositoryAutonomy &&
            (action.requires_confirmation ||
              !this.config.autoApproveSafePowerShell ||
              risk.level !== "low");

          if (repositoryAutonomy) {
            this.sendStatus(
              `DAVID scoped autonomy: ${action.action_id} (${risk.level})`,
              "working"
            );
            journal("teacher_powershell_auto_approved", {
              round,
              action_id: action.action_id,
              risk,
              scope: "repository_only"
            });
          }

          if (needsConfirmation) {
            this.sendStatus(
              `Р§РђРљРђРњ РћР”РћР‘Р Р•РќРР• В· ${action.action_id}`,
              "warning",
              { stage: "confirmation_pending", round, action_id: action.action_id }
            );
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
          this.sendStatus(
            `РџР РћР’Р•Р РЇР’РђРњ В· ${action.action_id} В· exit=${result.exit_code} В· ${result.duration_ms} ms.`,
            result.ok ? "working" : "error",
            {
              stage: "verifying",
              round,
              action_id: action.action_id,
              exit_code: result.exit_code,
              duration_ms: result.duration_ms
            }
          );

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
      this.memory.dispose();
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
          env: buildPowerShellEnvironment({ jobId, round, repositoryRoot })
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

      let lastLiveOutputAt = 0;
      const emitLiveOutput = (channel, chunk) => {
        const now = Date.now();
        if (now - lastLiveOutputAt < 900) return;
        const output = redactPowerShellLiveOutput(chunk);
        if (!output) return;
        lastLiveOutputAt = now;
        this.sendStatus(
          `POWERSHELL ${channel.toUpperCase()} В· ${output}`,
          channel === "stderr" ? "warning" : "working",
          {
            stage: "powershell_output",
            round,
            action_id: action.action_id,
            output_channel: channel,
            output
          }
        );
      };
      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stdout += text;
        emitLiveOutput("stdout", text);
      });
      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderr += text;
        emitLiveOutput("stderr", text);
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
  MAX_FORMAT_REPAIR_ATTEMPTS,
  PROTOCOL,
  TeacherLoop,
  buildFormatRepairRequest,
  buildPowerShellEnvironment,
  buildExecutionFeedback,
  buildInitialTeacherRequest,
  classifyPowerShellRisk,
  isRepositoryAutonomyEligible,
  doubleUnpairedBackslashes,
  findBalancedJsonObjects,
  normalizeInvalidJsonStringEscapes,
  normalizeRawWindowsPathsInJson,
  parseTeacherResponse,
  recoverKnownUiSuffixJsonEnvelope,
  truncateMiddle
};
