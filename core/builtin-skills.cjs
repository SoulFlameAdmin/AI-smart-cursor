"use strict";

const DAVID_TEACHER_CHAT_URL =
  "https://chatgpt.com/c/6a6d7e46-3534-83eb-a42b-c981bad99c84";

function createTeacherUpgradeLoopSkill() {
  return {
    skill_key: "builtin_teacher_upgrade_loop",
    title: "DAVID Teacher Loop",
    description:
      "Изпраща целта към GPT в Electron, чака пълния отговор, изпълнява одобрения локален PowerShell upgrade и връща резултата към GPT до завършване.",
    version: 1,
    status: "approved",
    source: "builtin",
    risk_level: "medium",
    matcher: {
      type: "regex",
      pattern:
        "^(?:мисли|misli|стартирай\\s+teacher\\s+loop|start\\s+teacher\\s+loop)(?:\\s+(.+?))?\\s*[.!?…]*$",
      flags: "iu",
      variables: ["goal"]
    },
    steps: [
      {
        action: "teacher_loop",
        goal: "{{goal}}"
      }
    ]
  };
}

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

function getBuiltInSkills() {
  return [
    createTeacherUpgradeLoopSkill(),
    createChatGptTeacherSkill()
  ];
}

module.exports = {
  DAVID_TEACHER_CHAT_URL,
  createTeacherUpgradeLoopSkill,
  createChatGptTeacherSkill,
  getBuiltInSkills
};
