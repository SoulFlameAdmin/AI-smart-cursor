"use strict";

const { BrowserWindow } = require("electron");
const { BrowserAgent } = require("./browser-agent.cjs");
const { validateSkill } = require("./skill-schema.cjs");

const DEFAULT_DAVID_TEACHER_CHAT_URL =
  "https://chatgpt.com/c/6a6d7e46-3534-83eb-a42b-c981bad99c84";

function extractBalancedJson(text) {
  const source = String(text || "").trim();
  if (!source) {
    throw new Error("GPT Teacher върна празен отговор.");
  }

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Продължаваме към балансирано извличане.
    }
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

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
        return JSON.parse(source.slice(start, index + 1));
      }
    }
  }

  throw new Error("GPT Teacher не върна валиден JSON обект.");
}

function normalizeTeacherSkill(payload) {
  const candidate = payload && typeof payload === "object" && payload.skill
    ? payload.skill
    : payload;

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("GPT Teacher не върна skill обект.");
  }

  const skill = {
    ...candidate,
    version: Number.isInteger(candidate.version) ? candidate.version : 1,
    status: "candidate",
    source: "electron_chat_teacher"
  };

  return validateSkill(skill);
}

function buildTeacherPrompt({ command, context, previousSkill, lastRun }) {
  const failureContext = previousSkill
    ? {
        previous_skill: previousSkill,
        last_run: lastRun || null,
        instruction:
          "Поправи предишния skill според грешката. Увеличи version с 1."
      }
    : null;

  return [
    "Ти си DAVID Teacher. Създай безопасен изпълним skill за локален Electron агент.",
    "Отговори САМО с един валиден JSON обект. Без markdown, обяснения или текст извън JSON.",
    "Позволени action стойности:",
    "open_url, open_app, wait, browser_open, browser_wait_selector, browser_click_selector, browser_click_text, browser_type_selector, browser_press_key, verify_url_contains, system_click, system_type, notify.",
    "Не използвай PowerShell, cmd, shell команди, изтриване, плащане, пароли или промяна на защитите.",
    "За непознат или рисков резултат върни безопасен skill само с notify, който казва защо задачата изисква човек.",
    "JSON формат:",
    JSON.stringify(
      {
        skill: {
          skill_key: "lowercase_unique_key",
          title: "Кратко име",
          description: "Какво прави skill-ът",
          version: 1,
          risk_level: "low",
          matcher: {
            type: "regex",
            pattern: "regex за командата",
            flags: "iu",
            variables: []
          },
          steps: [
            {
              action: "notify",
              title: "DAVID",
              text: "Пример"
            }
          ]
        }
      },
      null,
      2
    ),
    "ЗАДАЧА:",
    String(command || ""),
    "ЛОКАЛЕН КОНТЕКСТ:",
    JSON.stringify(context || {}, null, 2),
    failureContext
      ? `ПРЕДИШЕН НЕУСПЕШЕН ОПИТ:\n${JSON.stringify(failureContext, null, 2)}`
      : "Това е първи опит."
  ].join("\n\n");
}

class ElectronChatTeacher {
  constructor({ config, sendStatus }) {
    this.config = config;
    this.sendStatus = sendStatus;
    this.browser = new BrowserAgent({ BrowserWindow, sendStatus });
  }

  async requestSkill({ command, context, previousSkill, lastRun }) {
    const prompt = buildTeacherPrompt({
      command,
      context,
      previousSkill,
      lastRun
    });

    const responseText = await this.browser.sendChatGptMessageAndReadResponse({
      url:
        this.config.teacherChatUrl ||
        DEFAULT_DAVID_TEACHER_CHAT_URL,
      message: prompt,
      timeout: this.config.teacherTimeoutMs || 180000
    });

    const payload = extractBalancedJson(responseText);
    const skill = normalizeTeacherSkill(payload);

    this.sendStatus(`GPT Teacher създаде: ${skill.title}`, "training");

    return skill;
  }
}

module.exports = {
  DEFAULT_DAVID_TEACHER_CHAT_URL,
  ElectronChatTeacher,
  buildTeacherPrompt,
  extractBalancedJson,
  normalizeTeacherSkill
};
