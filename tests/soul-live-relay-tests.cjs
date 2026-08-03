"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  HEARTBEAT_MS,
  LIVE_RELAY_VERSION,
  LIVE_STAGES,
  progressLabel
} = require("../core/soul-relay-live.cjs");
const {
  SoulBrowserAgent,
  pageSnapshotRuntime,
  isChatGptUrl,
  sameConversation
} = require("../core/soul-relay-runtime-v3.cjs");
const {
  AUTH_HOST_SUFFIXES,
  installSoulAuthWindowPatch,
  isAllowedSoulAuthUrl
} = require("../core/soul-auth-window-patch.cjs");
const {
  EdgeSoulBrowserAgent,
  buildChatGptLoginUrl,
  isChatGptUrl: isEdgeChatGptUrl,
  normalizeUrl,
  sameConversation: sameEdgeConversation
} = require("../core/edge-cdp-soul-browser.cjs");

assert.strictEqual(LIVE_RELAY_VERSION, "david-soul-relay-v3");
assert.strictEqual(HEARTBEAT_MS, 5000);
assert.strictEqual(LIVE_STAGES.RECEIVED, "received");
assert.strictEqual(LIVE_STAGES.GPT_THINKING, "gpt_thinking");
assert.strictEqual(LIVE_STAGES.RETURNING_TO_SOUL, "returning_to_soul");
assert.match(progressLabel(LIVE_STAGES.RECEIVED), /получи съобщението/u);
assert.match(progressLabel(LIVE_STAGES.GPT_THINKING, 15), /15 сек/u);
assert.match(progressLabel(LIVE_STAGES.COMPLETED), /завършен/u);
assert.strictEqual(typeof SoulBrowserAgent.prototype.showReport, "function");
assert.strictEqual(typeof SoulBrowserAgent.prototype.diagnose, "function");
assert.strictEqual(typeof SoulBrowserAgent.prototype.runPage, "function");
assert.strictEqual(typeof SoulBrowserAgent.prototype.getSnapshot, "function");
assert.strictEqual(typeof pageSnapshotRuntime, "function");
assert.strictEqual(typeof isChatGptUrl, "function");
assert.strictEqual(typeof sameConversation, "function");
assert.match(SoulBrowserAgent.prototype.runPage.toString(), /pageFindPrompt/u);
assert.match(SoulBrowserAgent.prototype.getSnapshot.toString(), /pageSnapshotRuntime/u);

const snapshotSource = pageSnapshotRuntime.toString();
assert.match(snapshotSource, /conversation-turn-/u);
assert.match(snapshotSource, /data-message-author-role/u);
assert.match(snapshotSource, /lastAssistantTurnKey/u);
assert.match(snapshotSource, /data-is-streaming/u);
assert.match(snapshotSource, /stop-button/u);
assert.match(snapshotSource, /result-streaming/u);

assert.strictEqual(isChatGptUrl("https://chatgpt.com/c/test"), true);
assert.strictEqual(isChatGptUrl("https://example.com/c/test"), false);
assert.strictEqual(
  sameConversation(
    "https://chatgpt.com/c/abc?model=test",
    "https://chatgpt.com/c/abc"
  ),
  true
);
assert.strictEqual(
  sameConversation("https://chatgpt.com/c/abc", "https://chatgpt.com/c/xyz"),
  false
);

assert.strictEqual(typeof installSoulAuthWindowPatch, "function");
assert.ok(AUTH_HOST_SUFFIXES.includes("chatgpt.com"));
assert.ok(AUTH_HOST_SUFFIXES.includes("google.com"));
assert.strictEqual(isAllowedSoulAuthUrl("https://auth.openai.com/login"), true);
assert.strictEqual(isAllowedSoulAuthUrl("https://accounts.google.com/o/oauth2/v2/auth"), true);
assert.strictEqual(isAllowedSoulAuthUrl("https://login.microsoftonline.com/common/oauth2"), true);
assert.strictEqual(isAllowedSoulAuthUrl("https://appleid.apple.com/auth/authorize"), true);
assert.strictEqual(isAllowedSoulAuthUrl("http://accounts.google.com/login"), false);
assert.strictEqual(isAllowedSoulAuthUrl("https://evil.example/login"), false);

assert.strictEqual(typeof EdgeSoulBrowserAgent, "function");
assert.strictEqual(
  normalizeUrl("https://chatgpt.com/c/abc/?model=test#section"),
  "https://chatgpt.com/c/abc/?model=test"
);
assert.strictEqual(
  sameEdgeConversation(
    "https://chatgpt.com/c/abc?model=test",
    "https://chatgpt.com/c/abc"
  ),
  true
);
assert.strictEqual(
  sameEdgeConversation("https://chatgpt.com/c/abc", "https://chatgpt.com/c/xyz"),
  false
);
assert.strictEqual(isEdgeChatGptUrl("https://chatgpt.com/auth/login"), true);
assert.strictEqual(isEdgeChatGptUrl("https://example.com/auth/login"), false);
assert.strictEqual(
  buildChatGptLoginUrl("https://chatgpt.com/c/abc?model=test"),
  "https://chatgpt.com/auth/login?next=%2Fc%2Fabc%3Fmodel%3Dtest"
);
assert.match(EdgeSoulBrowserAgent.prototype.openIfNeeded.toString(), /opening_login/u);
assert.match(EdgeSoulBrowserAgent.prototype.openIfNeeded.toString(), /login_required/u);
assert.match(EdgeSoulBrowserAgent.prototype.sendAndWait.toString(), /waitForAnswer/u);
assert.match(EdgeSoulBrowserAgent.prototype.startEdge.toString(), /remote-debugging-address=127\.0\.0\.1/u);

const root = path.join(__dirname, "..");
const edgeMainSource = fs.readFileSync(path.join(root, "edge-soul-main.cjs"), "utf8");
const gptReadyIndex = edgeMainSource.indexOf("await relay.browser.openIfNeeded(chatUrl)");
const queueStartIndex = edgeMainSource.indexOf("await relay.start()");
assert.ok(gptReadyIndex >= 0, "edge-soul-main must prepare GPT");
assert.ok(queueStartIndex > gptReadyIndex, "Twins queue must start only after GPT is ready");
assert.match(edgeMainSource, /requestSingleInstanceLock/u);
assert.match(edgeMainSource, /soul-status\.json/u);

const launcherPath = path.join(root, "START-DAVID-SOUL-MODE.ps1");
const launcherBuffer = fs.readFileSync(launcherPath);
const launcherSource = launcherBuffer.toString("ascii");
assert.ok(
  [...launcherBuffer].every((byte) => byte < 128),
  "The PowerShell launcher must remain ASCII for Windows PowerShell 5.1"
);
assert.match(launcherSource, /GIT_TERMINAL_PROMPT = '0'/u);
assert.match(launcherSource, /127\.0\.0\.1/u);
assert.match(launcherSource, /SOUL text is never executed as PowerShell/u);
assert.match(launcherSource, /edge-soul-main\.cjs/u);
assert.match(launcherSource, /DAVID_TWINS_SOUL_URL/u);

console.log("DAVID SOUL mode security, Edge login and Twins handoff tests: PASS");
