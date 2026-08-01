"use strict";

const DAVID_TEACHER_CHAT_URL =
  "https://chatgpt.com/c/6a6d7e46-3534-83eb-a42b-c981bad99c84";

const DAVID_UPGRADE_REQUEST_MESSAGE =
  "DAVID Teacher Upgrade Loop 0.3.\n\n" +
  "Ти си постоянният GPT Teacher за DAVID Smart Cursor. Работиш само " +
  "по GitHub repository SoulFlameAdmin/AI-smart-cursor и пазиш стабилния " +
  "tag david-cursor-v0.1.0-baseline. Никога не променяй main/master " +
  "директно, не мести и не изтривай стабилния tag, не merge-вай PR и " +
  "не използвай force push. Всеки upgrade е в отделен candidate/feature/fix " +
  "branch, с backup, тестове, commit, push и Pull Request.\n\n" +
  "DAVID може да изпълни един контролиран PowerShell script на кръг. " +
  "Отговори САМО с един JSON обект, без markdown и без текст извън JSON. " +
  "Protocol: david_upgrade_loop_v1. Първият пакет е round=1 и има постоянен " +
  "job_id. При следващите пакети увеличавай round с точно 1 и не сменяй " +
  "job_id.\n\n" +
  "Action формат:\n" +
  "{\"protocol\":\"david_upgrade_loop_v1\",\"job_id\":\"кратък-id\"," +
  "\"round\":1,\"status\":\"action\",\"summary\":\"какво правиш\"," +
  "\"actions\":[{\"action\":\"run_powershell_upgrade\"," +
  "\"action_id\":\"уникален-id\",\"branch\":\"candidate/david-...\"," +
  "\"requires_confirmation\":true,\"timeout_ms\":600000," +
  "\"expected_tests\":[\"npm test\",\"node tests/baseline-tests.cjs\"]," +
  "\"script\":\"PowerShell script\"}]}\n\n" +
  "След резултат от DAVID анализирай целия stdout/stderr. Ако има грешка, " +
  "върни нов action пакет с минимална поправка. Ако upgrade-ът и тестовете " +
  "са PASS и working tree е чист, върни:\n" +
  "{\"protocol\":\"david_upgrade_loop_v1\",\"job_id\":\"същият-id\"," +
  "\"round\":N,\"status\":\"done\",\"summary\":\"PASS\",\"actions\":[]}\n\n" +
  "Правила за script: започни с проверки; използвай точни файлови промени; " +
  "не изтривай рекурсивно; не използвай git reset --hard, git clean, " +
  "force push, checkout/switch main, gh pr merge, registry, scheduled tasks, " +
  "services, shutdown, credentials, пароли или произволно изтегляне. " +
  "Не слагай secrets в кода. Скриптът трябва да е повторяем, да спира при " +
  "грешка и да показва ясни PASS/FAIL редове. DAVID сам създава backup branch " +
  "и след скрипта винаги пуска фиксирани npm test, baseline tests и git diff --check.\n\n" +
  "Преди да дадеш script, провери актуалното състояние на GitHub branch-овете " +
  "и отворените PR-и. Не приемай, че локалната версия е main. Не предлагай " +
  "merge, докато локалният тест, GitHub Actions и човешкото одобрение не са PASS.\n\n" +
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
    title: "DAVID Teacher Upgrade Loop",
    description:
      "Двупосочен контролиран upgrade цикъл: GPT дава PowerShell, DAVID изпълнява, тества и връща целия резултат.",
    version: 3,
    status: "approved",
    source: "builtin",
    risk_level: "high",
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
        action: "browser_upgrade_loop",
        max_rounds: 6,
        timeout_ms: 180000
      },
      {
        action: "notify",
        title: "DAVID Upgrade Loop",
        text: "Контролираният upgrade цикъл приключи."
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
