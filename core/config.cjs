"use strict";

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function loadConfig() {
  return {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabasePublishableKey:
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      "",
    teacherFunction:
      process.env.SUPABASE_TEACHER_FUNCTION || "teacher-plan",
    email: process.env.DAVID_USER_EMAIL || "",
    password: process.env.DAVID_USER_PASSWORD || "",
    maxTrainingAttempts: parseInteger(
      process.env.DAVID_MAX_TRAINING_ATTEMPTS,
      3,
      1,
      5
    ),
    nativeActionsEnabled: parseBoolean(
      process.env.DAVID_ENABLE_NATIVE_ACTIONS,
      false
    ),
    teacherChatUrl:
      process.env.DAVID_TEACHER_CHAT_URL ||
      "https://chatgpt.com/c/6a81285a-3e38-83ed-965a-b221453fb742",
    repositoryRoot: process.env.DAVID_REPOSITORY_ROOT || process.cwd(),
    maxTeacherRounds: parseInteger(
      process.env.DAVID_MAX_TEACHER_ROUNDS,
      8,
      1,
      20
    ),
    gptResponseTimeoutMs: parseInteger(
      process.env.DAVID_GPT_RESPONSE_TIMEOUT_MS,
      240000,
      30000,
      900000
    ),
    powershellTimeoutMs: parseInteger(
      process.env.DAVID_POWERSHELL_TIMEOUT_MS,
      600000,
      10000,
      1800000
    ),
    maxTeacherOutputChars: parseInteger(
      process.env.DAVID_MAX_TEACHER_OUTPUT_CHARS,
      30000,
      4000,
      100000
    ),
    powershellExecutable:
      process.env.DAVID_POWERSHELL_EXE || "powershell.exe",
    autoApproveSafePowerShell: parseBoolean(
      process.env.DAVID_AUTO_APPROVE_SAFE_POWERSHELL,
      false
    ),
    deviceBridgeFunction:
      process.env.DAVID_DEVICE_BRIDGE_FUNCTION || "david-device-bridge",
    deviceToken: process.env.DAVID_DEVICE_TOKEN || ""
  };
}

module.exports = { loadConfig, parseBoolean, parseInteger };
