"use strict";

const DAVID_TEACHER_CHAT_URL =
  "https://chatgpt.com/c/6a6d7e46-3534-83eb-a42b-c981bad99c84";

function buildYouTubeSkill(version = 1) {
  return {
    skill_key: "youtube_play_search_result",
    title: "Пусни изпълнител или песен в YouTube",
    description:
      "Отваря YouTube търсене в защитен DAVID Browser и стартира първия резултат.",
    version,
    status: "candidate",
    risk_level: "low",
    matcher: {
      type: "regex",
      pattern:
        "(?:отвори|otvori)\\s+(?:youtube|yt|ютуб).*?(?:пусни|pusni)\\s+(.+)",
      flags: "iu",
      variables: ["query"]
    },
    steps: [
      {
        action: "browser_open",
        url:
          "https://www.youtube.com/results?search_query={{url:query}}"
      },
      {
        action: "wait",
        milliseconds: 1800
      },
      {
        action: "browser_click_text",
        text: "Reject all",
        allow_fail: true
      },
      {
        action: "browser_click_text",
        text: "Accept all",
        allow_fail: true
      },
      {
        action: "browser_click_text",
        text: "Отхвърляне на всички",
        allow_fail: true
      },
      {
        action: "browser_click_text",
        text: "Приемане на всички",
        allow_fail: true
      },
      {
        action: "browser_wait_selector",
        selector: "ytd-video-renderer a#thumbnail",
        timeout_ms: 20000
      },
      {
        action: "browser_click_selector",
        selector: "ytd-video-renderer a#thumbnail"
      },
      {
        action: "wait",
        milliseconds: 2500
      },
      {
        action: "verify_url_contains",
        value: "watch"
      }
    ]
  };
}

function buildChatGptBridgeSkill(version = 1) {
  return {
    skill_key: "chatgpt_teacher_room_write",
    title: "Пиши в DAVID Teacher ChatGPT разговора",
    description:
      "Отваря конкретния DAVID Teacher разговор в локален постоянен DAVID Browser и изпраща текста.",
    version,
    status: "candidate",
    risk_level: "low",
    matcher: {
      type: "regex",
      pattern:
        "(?:пиши|pishi|напиши|napishi|изпрати|izprati)" +
        "(?:\\s+(?:на|в|do))?\\s+" +
        "(?:gpt|chatgpt|тук|tuk)\\s+(.+)",
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
        milliseconds: 1800
      },
      {
        action: "browser_wait_selector",
        selector:
          "#prompt-textarea, textarea[data-id='root'], textarea",
        timeout_ms: 30000
      },
      {
        action: "browser_type_selector",
        selector:
          "#prompt-textarea, textarea[data-id='root'], textarea",
        text: "{{message}}"
      },
      {
        action: "wait",
        milliseconds: 500
      },
      {
        action: "browser_wait_selector",
        selector:
          "button[data-testid='send-button']:not([disabled]), " +
          "button[aria-label='Send prompt']:not([disabled]), " +
          "button[aria-label='Изпращане на подкана']:not([disabled])",
        timeout_ms: 10000
      },
      {
        action: "browser_click_selector",
        selector:
          "button[data-testid='send-button']:not([disabled]), " +
          "button[aria-label='Send prompt']:not([disabled]), " +
          "button[aria-label='Изпращане на подкана']:not([disabled])"
      },
      {
        action: "wait",
        milliseconds: 1200
      },
      {
        action: "verify_url_contains",
        value: "6a6d7e46-3534-83eb-a42b-c981bad99c84"
      },
      {
        action: "notify",
        title: "DAVID",
        text: "Съобщението е изпратено в Teacher разговора."
      }
    ]
  };
}

function extractYouTubeQuery(command) {
  const regex =
    /(?:отвори|otvori)\s+(?:youtube|yt|ютуб).*?(?:пусни|pusni)\s+(.+)/iu;

  const match = regex.exec(command);

  return match
    ? match[1].trim()
    : null;
}

function extractChatGptMessage(command) {
  const regex =
    /(?:пиши|pishi|напиши|napishi|изпрати|izprati)(?:\s+(?:на|в|do))?\s+(?:gpt|chatgpt|тук|tuk)\s+(.+)/iu;

  const match = regex.exec(command);

  return match
    ? match[1].trim()
    : null;
}

async function createDemoPlan(command, previousSkill) {
  // DAVID_EXACT_GPT_SILENT
  const exactGptCommand =
    /^(?:gpt|chatgpt|джипити|чатджипити|гпт|чатгпт)$/iu
      .test(String(command || "").trim());

  if (exactGptCommand) {
    return {
      requestId: `gpt-screen-${Date.now()}`,
      skill: {
        skill_key: "gpt_screen_control",
        title: "GPT Screen Control",
        description:
          "Командата GPT се изпълнява от локалния screen bridge.",
        version: Number(previousSkill?.version || 0) + 1,
        status: "verified",
        risk_level: "low",
        matcher: {
          type: "regex",
          pattern:
            "^(?:gpt|chatgpt|джипити|чатджипити|гпт|чатгпт)$",
          flags: "iu",
          variables: []
        },
        steps: []
      }
    };
  }
  const normalizedCommand = String(command || "").trim();

  const isGptScreenCommand =
    /^(?:gpt|chatgpt|джипити|чатджипити|гпт|чатгпт)(?:\s+.+)?$/iu
      .test(normalizedCommand);

  if (isGptScreenCommand) {
    return {
      requestId: `gpt-screen-${Date.now()}`,
      skill: {
        skill_key: "gpt_screen_hotword",
        title: "GPT Screen Bridge",
        description:
          "Предава командата към отворения ChatGPT върху реалния Windows екран.",
        version: Number(previousSkill?.version || 0) + 1,
        status: "verified",
        risk_level: "low",
        matcher: {
          type: "regex",
          pattern:
            "^(?:gpt|chatgpt|джипити|чатджипити|гпт|чатгпт)(?:\\s+.+)?$",
          flags: "iu",
          variables: []
        },
        steps: [
          {
            action: "notify",
            title: "DAVID → GPT",
            text: "GPT Screen Bridge е активиран."
          }
        ]
      }
    };
  }
  const chatMessage =
    extractChatGptMessage(command);

  if (chatMessage) {
    return {
      requestId: `local-chatgpt-${Date.now()}`,
      skill: buildChatGptBridgeSkill(
        Number(previousSkill?.version || 0) + 1
      )
    };
  }

  const query =
    extractYouTubeQuery(command);

  if (query) {
    return {
      requestId: `demo-youtube-${Date.now()}`,
      skill: buildYouTubeSkill(
        Number(previousSkill?.version || 0) + 1
      )
    };
  }

  return {
    requestId: `demo-${Date.now()}`,
    skill: {
      skill_key: `demo_explain_${Date.now()}`,
      title: "Нужна е връзка с DAVID Teacher",
      description:
        "Локалният demo teacher познава YouTube и локалния ChatGPT Bridge.",
      version: 1,
      status: "candidate",
      risk_level: "low",
      matcher: {
        type: "regex",
        pattern: "^$",
        flags: "u",
        variables: []
      },
      steps: [
        {
          action: "notify",
          title: "DAVID Teacher",
          text:
            "Тази команда няма local skill. Свържи Supabase + OpenAI Teacher за автоматично обучение."
        }
      ]
    }
  };
}

module.exports = {
  DAVID_TEACHER_CHAT_URL,
  buildYouTubeSkill,
  buildChatGptBridgeSkill,
  extractYouTubeQuery,
  extractChatGptMessage,
  createDemoPlan
};


