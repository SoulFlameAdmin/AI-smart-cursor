"use strict";

const DAVID_TEACHER_SYNC_PROTOCOL = "david_teacher_sync_v1";

const SAFE_TEACHER_ACTIONS = new Set([
  "wait",
  "system_click",
  "system_type",
  "notify"
]);

function findJsonObject(text) {
  const source = String(text || "").trim();

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced) return fenced[1].trim();

  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0 && start >= 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error("GPT Teacher не върна JSON пакет за DAVID.");
}

function assertText(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new Error(`${label} трябва да е текст.`);
  }

  if (value.length > maxLength) {
    throw new Error(`${label} е прекалено дълго.`);
  }
}

function normalizeTeacherAction(action, index) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error(`Teacher action ${index + 1} е невалидно.`);
  }

  if (!SAFE_TEACHER_ACTIONS.has(action.action)) {
    throw new Error(
      `Teacher action ${index + 1} не е разрешено: ${action.action}`
    );
  }

  switch (action.action) {
    case "wait": {
      const milliseconds = Number(action.milliseconds);

      if (!Number.isFinite(milliseconds) || milliseconds < 50 || milliseconds > 10000) {
        throw new Error("Teacher wait трябва да е между 50 и 10000 ms.");
      }

      return {
        action: "wait",
        milliseconds: Math.round(milliseconds)
      };
    }

    case "system_click": {
      const x = Number(action.x);
      const y = Number(action.y);

      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < -20000 ||
        y < -20000 ||
        x > 50000 ||
        y > 50000
      ) {
        throw new Error("Teacher click има невалидни координати.");
      }

      return {
        action: "system_click",
        x: Math.round(x),
        y: Math.round(y)
      };
    }

    case "system_type":
      assertText(action.text, "Teacher type text", 2000);
      return {
        action: "system_type",
        text: action.text
      };

    case "notify":
      assertText(action.title || "DAVID", "Teacher notify title", 120);
      assertText(action.text || "", "Teacher notify text", 500);
      return {
        action: "notify",
        title: action.title || "DAVID",
        text: action.text || ""
      };

    default:
      throw new Error("Неподдържано Teacher действие.");
  }
}

function validateTeacherPacket(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new Error("Невалиден GPT Teacher пакет.");
  }

  if (packet.protocol !== DAVID_TEACHER_SYNC_PROTOCOL) {
    throw new Error("GPT Teacher пакетът е с непознат protocol.");
  }

  if (!["action", "done", "blocked"].includes(packet.status)) {
    throw new Error("GPT Teacher пакетът е с невалиден status.");
  }

  assertText(packet.summary || "", "Teacher summary", 2000);

  const actions = Array.isArray(packet.actions) ? packet.actions : [];

  if (actions.length > 8) {
    throw new Error("GPT Teacher върна прекалено много действия.");
  }

  if (packet.status === "action" && actions.length === 0) {
    throw new Error("GPT Teacher action пакетът няма действия.");
  }

  return {
    protocol: DAVID_TEACHER_SYNC_PROTOCOL,
    status: packet.status,
    summary: packet.summary || "",
    actions: actions.map(normalizeTeacherAction)
  };
}

function parseTeacherPacket(text) {
  const json = findJsonObject(text);
  let packet;

  try {
    packet = JSON.parse(json);
  } catch (error) {
    throw new Error(`Невалиден JSON от GPT Teacher: ${error.message}`);
  }

  return validateTeacherPacket(packet);
}

function buildTeacherResult({ round, packet, results }) {
  return JSON.stringify(
    {
      protocol: DAVID_TEACHER_SYNC_PROTOCOL,
      status: "result",
      round,
      teacher_status: packet.status,
      teacher_summary: packet.summary,
      results
    },
    null,
    2
  );
}

module.exports = {
  DAVID_TEACHER_SYNC_PROTOCOL,
  SAFE_TEACHER_ACTIONS,
  findJsonObject,
  validateTeacherPacket,
  parseTeacherPacket,
  buildTeacherResult
};
