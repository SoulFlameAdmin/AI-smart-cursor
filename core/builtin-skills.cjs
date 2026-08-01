"use strict";

const DAVID_TEACHER_CHAT_URL =
  "https://chatgpt.com/c/6a6d7e46-3534-83eb-a42b-c981bad99c84";

const DAVID_UPGRADE_REQUEST_MESSAGE =
  "Ъпгрейдни ме – DAVID.\n\n" +
  "Аз съм DAVID Smart Cursor. Провери текущото състояние на " +
  "GitHub repository SoulFlameAdmin/AI-smart-cursor и стабилния tag " +
  "david-cursor-v0.1.0-baseline. Създай следващия upgrade само в " +
  "отделен branch и Pull Request; не променяй main директно. " +
  "Използвай Supabase като памет за upgrade заявката, плана, " +
  "тестовете и резултата, когато връзката е настроена. " +
  "Преди merge пусни локалните тестове и GitHub Actions. " +
  "При неуспех запази стабилната версия и подготви rollback.\n\n" +
  "DAVID Teacher Sync 0.1 е активен. Отговори САМО с един JSON " +
  "обект, без обяснение извън него. Форматът е: " +
  "{\"protocol\":\"david_teacher_sync_v1\",\"status\":" +
  "\"action|done|blocked\",\"summary\":\"кратко\",\"actions\":[]}. " +
  "При status=action използвай само действия wait, system_click, " +
  "system_type или notify. Не използвай shell, PowerShell, изтриване, " +
  "пароли, плащания или скрити действия. DAVID ще иска разрешение " +
  "преди всяко местно кликване или писане. Не отгатвай координати; " +
  "при недостатъчно визуална информация върни status=blocked. " +
  "След резултат от DAVID върни следващия JSON пакет.\n\n" +
  "Допълнителна задача от DAVID: {{details}}";

const PROMPT_SELECTOR =
  "#prompt-textarea, " +
  "[contenteditable='true'][data-virtualkeyboard], " +
  "[contenteditable='true'].ProseMirror, " +
  "textarea[data-id='root'], textarea";

const SEND_SELECTOR =
  "button[data-testid='send-button']:not([disabled]), " +
  "button[aria-label='Send prompt']:not([disabled]), " +
  "button[aria-label='Изпращане на подкана']:not([disabled]), " +
  "button[aria-label='Send message']:not([disabled])";

function createTeacherSendSteps(message) {
  return [
    {
      action: "browser_open",
      url: DAVID_TEACHER_CHAT_URL
    },
    {
      action: "wait",
      milliseconds: 1600
    },
    {
      action: "browser_wait_selector",
      selector: PROMPT_SELECTOR,
      timeout_ms: 30000
    },
    {
      action: "browser_type_selector",
      selector: PROMPT_SELECTOR,
      text: message
    },
    {
      action: "wait",
      milliseconds: 5000
    },
    {
      action: "browser_wait_selector",
      selector: SEND_SELECTOR,
      timeout_ms: 15000
    },
    {
      action: "browser_mark_teacher_state"
    },
    {
      action: "browser_click_selector",
      selector: SEND_SELECTOR
    },
    {
      action: "wait",
      milliseconds: 900
    },
    {
      action: "verify_url_contains",
      value: "6a6d7e46-3534-83eb-a42b-c981bad99c84"
    }
  ];
}

function createChatGptTeacherSkill() {
  return {
    skill_key: "builtin_chatgpt_teacher_send",
    title: "Пиши в DAVID Teacher GPT разговора",
    description:
      "Вграден локален skill. Отваря постоянния DAVID Teacher разговор и изпраща зададеното съобщение.",
    version: 3,
    status: "approved",
    source: "builtin",
    risk_level: "low",
    matcher: {
      type: "regex",
      pattern:
        "^(?:пиши|pishi|напиши|napishi|прати|prati|изпрати|izprati)" +
        "(?:\\s+(?:на|na|в|v|до|do))?\\s+" +
        "(?:gpt|chatgpt)\\s+(.+)$",
      flags: "iu",
      variables: ["message"]
    },
    steps: [
      ...createTeacherSendSteps("{{message}}"),
      {
        action: "notify",
        title: "DAVID",
        text: "Съобщението е изпратено към GPT."
      }
    ]
  };
}

function createUpgradeBridgeSkill() {
  return {
    skill_key: "builtin_david_upgrade_bridge",
    title: "Поискай upgrade от DAVID GPT Teacher",
    description:
      "Изпраща upgrade заявка и продължава чрез безопасен GPT Teacher Sync цикъл.",
    version: 2,
    status: "approved",
    source: "builtin",
    risk_level: "medium",
    matcher: {
      type: "regex",
      pattern:
        "^(?:" +
        "ъпгрейдни\\s+ме|" +
        "upgreidni\\s+me|" +
        "upgrade\\s+me|" +
        "ъпгрейдни\\s+се|" +
        "upgreidni\\s+se" +
        ")" +
        "(?:\\s*[-–—]?\\s*david)?" +
        "(?:\\s*[:|]\\s*(.*))?\\s*[.!?]*$",
      flags: "iu",
      variables: ["details"]
    },
    steps: [
      ...createTeacherSendSteps(DAVID_UPGRADE_REQUEST_MESSAGE),
      {
        action: "browser_teacher_sync",
        max_rounds: 3,
        timeout_ms: 120000
      },
      {
        action: "notify",
        title: "DAVID Teacher Sync",
        text: "Безопасният Teacher Sync цикъл приключи."
      }
    ]
  };
}

function getBuiltInSkills() {
  return [
    createUpgradeBridgeSkill(),
    createChatGptTeacherSkill()
  ];
}

module.exports = {
  DAVID_TEACHER_CHAT_URL,
  DAVID_UPGRADE_REQUEST_MESSAGE,
  createChatGptTeacherSkill,
  createUpgradeBridgeSkill,
  getBuiltInSkills
};
