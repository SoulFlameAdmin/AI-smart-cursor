"use strict";

const relay = require("./soul-relay.cjs");

function pageFindPromptRuntime() {
  const visible = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0 && rect.width >= 120 && rect.height >= 20 &&
      rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };

  const selectors = [
    "#prompt-textarea",
    "[data-testid='prompt-textarea']",
    "[contenteditable='true'][role='textbox']",
    "[contenteditable='true'][data-virtualkeyboard]",
    "[contenteditable='true'].ProseMirror",
    "form [contenteditable='true']",
    "textarea[data-id='root']",
    "textarea[placeholder]",
    "textarea"
  ];

  const found = [];
  const seen = new Set();

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element) || !visible(element)) continue;
      if (element.matches("[disabled], [aria-disabled='true']")) continue;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      const label = [
        element.id,
        element.getAttribute("data-testid"),
        element.getAttribute("role"),
        element.getAttribute("placeholder"),
        element.getAttribute("data-placeholder"),
        element.getAttribute("aria-label")
      ].filter(Boolean).join(" ");
      let score = 0;
      if (element.id === "prompt-textarea") score += 220;
      if (/prompt/i.test(label)) score += 170;
      if (element.getAttribute("role") === "textbox") score += 100;
      if (element.isContentEditable) score += 80;
      if (element.tagName === "TEXTAREA") score += 70;
      if (/message|prompt|ask|съобщ|подкан|питай/i.test(label)) score += 70;
      if (element.closest("form")) score += 40;
      if (rect.top > innerHeight * 0.45) score += 50;
      found.push({ element, score, label: label.slice(0, 160), rect });
    }
  }

  found.sort((a, b) => b.score - a.score);
  return found;
}

function pageSnapshotRuntime() {
  const clean = (value) => String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const inferRole = (turn) => {
    const roleNode = turn.matches?.("[data-message-author-role]")
      ? turn
      : turn.querySelector?.("[data-message-author-role]");
    const directRole = clean(
      roleNode?.getAttribute?.("data-message-author-role") ||
      turn.getAttribute?.("data-turn") ||
      turn.getAttribute?.("data-role") ||
      ""
    ).toLowerCase();

    if (directRole === "assistant" || directRole === "user") return directRole;

    const label = clean([
      turn.getAttribute?.("aria-label"),
      turn.querySelector?.("h4,h5,h6")?.textContent,
      turn.querySelector?.("[class*='sr-only']")?.textContent
    ].filter(Boolean).join(" ")).toLowerCase();

    if (/chatgpt said|assistant|david|дейвид|асистент/u.test(label)) return "assistant";
    if (/you said|user|ти каза|потребител/u.test(label)) return "user";
    return "";
  };

  const extractText = (turn, role) => {
    const roleSelector = `[data-message-author-role="${role}"]`;
    const selectors = role === "assistant"
      ? [
          ".markdown",
          "[class*='markdown']",
          "[class*='prose']",
          "[data-testid*='assistant-message']",
          roleSelector
        ]
      : [
          roleSelector,
          "[data-testid*='user-message']",
          "[class*='whitespace-pre-wrap']"
        ];

    for (const selector of selectors) {
      const candidate = turn.matches?.(selector) ? turn : turn.querySelector?.(selector);
      const text = clean(candidate?.innerText || candidate?.textContent || "");
      if (text) return text;
    }

    return clean(turn.innerText || turn.textContent || "");
  };

  const candidates = [];
  const seen = new Set();
  const add = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    candidates.push(node);
  };

  for (const node of document.querySelectorAll("[data-testid^='conversation-turn-']")) add(node);
  for (const node of document.querySelectorAll("article[data-turn], article[data-role]")) add(node);
  for (const roleNode of document.querySelectorAll("[data-message-author-role]")) {
    add(roleNode.closest("[data-testid^='conversation-turn-']") || roleNode.closest("article") || roleNode);
  }

  const turns = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const turn = candidates[index];
    const role = inferRole(turn);
    if (role !== "assistant" && role !== "user") continue;
    const text = extractText(turn, role);
    if (!text) continue;
    const key = clean(
      turn.getAttribute?.("data-testid") ||
      turn.getAttribute?.("data-message-id") ||
      turn.id ||
      `${role}-${index}-${text.slice(0, 80)}`
    );
    turns.push({ role, text, key });
  }

  const assistants = turns.filter((turn) => turn.role === "assistant");
  const users = turns.filter((turn) => turn.role === "user");
  const lastAssistant = assistants[assistants.length - 1] || { text: "", key: "" };
  const lastUser = users[users.length - 1] || { text: "", key: "" };

  const stopSelector = [
    "button[data-testid='stop-button']",
    "button[aria-label*='Stop']",
    "button[aria-label*='stop']",
    "button[aria-label*='Спри']",
    "button[aria-label*='спри']",
    "[data-is-streaming='true']",
    ".result-streaming",
    "[class*='result-streaming']"
  ].join(",");

  const stopBySelector = Boolean(document.querySelector(stopSelector));
  const stopByLabel = Array.from(document.querySelectorAll("button")).some((button) => {
    const label = clean([
      button.getAttribute("data-testid"),
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.innerText
    ].filter(Boolean).join(" ")).toLowerCase();
    return label.includes("stop-button") ||
      label.includes("stop generating") ||
      label.includes("stop response") ||
      label.includes("спиране на генерирането") ||
      label.includes("спри генерирането") ||
      label === "stop";
  });

  const body = clean(document.body?.innerText || "").toLowerCase();
  let pageError = "";
  if (body.includes("something went wrong")) pageError = "ChatGPT показа Something went wrong.";
  else if (body.includes("network error")) pageError = "ChatGPT показа network error.";
  else if (body.includes("conversation not found")) pageError = "Постоянният ChatGPT разговор не е намерен.";

  return {
    assistantCount: assistants.length,
    userCount: users.length,
    last: lastAssistant.text,
    lastLength: lastAssistant.text.length,
    lastAssistantTurnKey: lastAssistant.key,
    lastUser: lastUser.text,
    lastUserTurnKey: lastUser.key,
    generating: stopBySelector || stopByLabel,
    pageError,
    turnCount: turns.length,
    url: location.href
  };
}

relay.SoulBrowserAgent.prototype.runPage = async function runPage(fn, ...args) {
  const helper = `const pageFindPrompt = ${pageFindPromptRuntime.toString()};`;
  const callArgs = args.map((arg) => JSON.stringify(arg)).join(",");
  const source = `(() => { ${helper} return (${fn.toString()})(${callArgs}); })()`;
  return this.ensureWindow().webContents.executeJavaScript(source, true);
};

relay.SoulBrowserAgent.prototype.getSnapshot = async function getSnapshot() {
  return this.runPage(pageSnapshotRuntime);
};

relay.pageFindPromptRuntime = pageFindPromptRuntime;
relay.pageSnapshotRuntime = pageSnapshotRuntime;

module.exports = relay;
