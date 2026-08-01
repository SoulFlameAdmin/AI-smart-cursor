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
    teacherMode:
      String(process.env.DAVID_TEACHER_MODE || "electron-chat")
        .trim()
        .toLowerCase(),
    teacherChatUrl: process.env.DAVID_TEACHER_CHAT_URL || "",
    teacherTimeoutMs: parseInteger(
      process.env.DAVID_TEACHER_TIMEOUT_MS,
      180000,
      30000,
      600000
    ),
    allowDemoFallback: parseBoolean(
      process.env.DAVID_ALLOW_DEMO_FALLBACK,
      false
    ),
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
    )
  };
}

module.exports = { loadConfig };
