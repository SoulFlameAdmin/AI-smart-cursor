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

relay.SoulBrowserAgent.prototype.runPage = async function runPage(fn, ...args) {
  const helper = `const pageFindPrompt = ${pageFindPromptRuntime.toString()};`;
  const callArgs = args.map((arg) => JSON.stringify(arg)).join(",");
  const source = `(() => { ${helper} return (${fn.toString()})(${callArgs}); })()`;
  return this.ensureWindow().webContents.executeJavaScript(source, true);
};

module.exports = relay;
