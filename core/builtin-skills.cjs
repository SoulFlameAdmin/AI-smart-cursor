"use strict";

const DAVID_TEACHER_CHAT_URL =
  "https://chatgpt.com/c/6a6d7e46-3534-83eb-a42b-c981bad99c84";

function createChatGptTeacherSkill() {
  return {
    skill_key: "builtin_chatgpt_teacher_send",
    title: "Пиши в DAVID Teacher GPT разговора",
    description:
      "Вграден локален skill. Отваря постоянния DAVID Teacher разговор и изпраща зададеното съобщение.",
    version: 2,
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
        selector:
          "#prompt-textarea, " +
          "[contenteditable='true'][data-virtualkeyboard], " +
          "[contenteditable='true'].ProseMirror, " +
          "textarea[data-id='root'], textarea",
        timeout_ms: 30000
      },
      {
        action: "browser_type_selector",
        selector:
          "#prompt-textarea, " +
          "[contenteditable='true'][data-virtualkeyboard], " +
          "[contenteditable='true'].ProseMirror, " +
          "textarea[data-id='root'], textarea",
        text: "{{message}}"
      },
      {
        action: "wait",
        milliseconds: 5000
      },
      {
        action: "browser_wait_selector",
        selector:
          "button[data-testid='send-button']:not([disabled]), " +
          "button[aria-label='Send prompt']:not([disabled]), " +
          "button[aria-label='Изпращане на подкана']:not([disabled]), " +
          "button[aria-label='Send message']:not([disabled])",
        timeout_ms: 15000
      },
      {
        action: "browser_click_selector",
        selector:
          "button[data-testid='send-button']:not([disabled]), " +
          "button[aria-label='Send prompt']:not([disabled]), " +
          "button[aria-label='Изпращане на подкана']:not([disabled]), " +
          "button[aria-label='Send message']:not([disabled])"
      },
      {
        action: "wait",
        milliseconds: 900
      },
      {
        action: "verify_url_contains",
        value: "6a6d7e46-3534-83eb-a42b-c981bad99c84"
      },
      {
        action: "notify",
        title: "DAVID",
        text: "Съобщението е изпратено към GPT."
      }
    ]
  };
}

function createBorkoTwinTaskSkill() {
  return {
    skill_key: "builtin_borko_twin_task",
    title: "Дай задача на BORKO Twin",
    description:
      "Възлага задача на личния DAVID/Twin Agent на Борко през DAVID Core, без да блокира MITKO DAVID.",
    version: 1,
    status: "approved",
    source: "builtin",
    risk_level: "low",
    matcher: {
      type: "regex",
      pattern:
        "^(?:дай|dai|възложи|vuzlozhi|прати|prati|изпрати|izprati)" +
        "(?:\\s+(?:задача|zadacha))?\\s+(?:на|na)\\s+" +
        "(?:борко|borko)(?:\\s+(?:twin|agent|агент|david|дейвид))?" +
        "\\s*[:,-]?\\s+(.+)$",
      flags: "iu",
      variables: ["task"]
    },
    steps: [
      {
        action: "twin_agent_task",
        agent_key: "borko-twin",
        task_type: "work",
        prompt: "{{task}}",
        priority: 100
      },
      {
        action: "notify",
        title: "DAVID Core",
        text: "Задачата е добавена в опашката на BORKO Twin."
      }
    ]
  };
}

function getBuiltInSkills() {
  return [
    createChatGptTeacherSkill(),
    createBorkoTwinTaskSkill()
  ];
}

module.exports = {
  DAVID_TEACHER_CHAT_URL,
  createChatGptTeacherSkill,
  createBorkoTwinTaskSkill,
  getBuiltInSkills
};
