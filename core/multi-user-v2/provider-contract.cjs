"use strict";

const PROVIDER_CONTRACT_VERSION = "david-multi-user-v2-stage5";

const ACCOUNT_ISOLATION_INVARIANTS = Object.freeze([
  "auth.users.id is the primary isolation key; Gmail is only an authentication attribute",
  "one DAVID identity belongs to exactly one auth.users.id",
  "one provider conversation is unique per user, Twin and provider",
  "one provider run is bound to one user, identity, Twin, conversation and SOUL thread",
  "provider API keys remain server-only and never enter browser, Electron, SOUL text or database rows",
  "private ChatGPT URLs, cookies and Edge profiles are never shared across users",
  "provider progress events are owner-scoped and ordered",
  "Electron routing is optional, per-account and disabled by default",
  "all provider runtime flags and rollout limits remain disabled until an explicit canary"
]);

const PROVIDER_STAGES = Object.freeze([
  "received",
  "queued",
  "provider_connecting",
  "provider_thinking",
  "reading_answer",
  "returning_answer",
  "completed",
  "failed",
  "cancelled"
]);

const PROVIDER_ALLOWLIST = Object.freeze([
  "mock",
  "openai",
  "azure_openai",
  "anthropic",
  "other"
]);

function buildAccountScope({ userId, identityId, twinId, conversationId, threadId }) {
  const values = { userId, identityId, twinId, conversationId, threadId };
  for (const [key, value] of Object.entries(values)) {
    if (!value || typeof value !== "string") {
      throw new TypeError(`${key} is required for a DAVID account scope`);
    }
  }
  return Object.freeze({
    user_id: userId,
    identity_id: identityId,
    twin_id: twinId,
    conversation_id: conversationId,
    thread_id: threadId
  });
}

function assertNoClientSecrets(value) {
  const text = JSON.stringify(value ?? {}).toLowerCase();
  const forbidden = [
    "api_key",
    "apikey",
    "authorization",
    "bearer ",
    "cookie",
    "chatgpt.com/c/",
    "device_token",
    "service_role"
  ];
  const match = forbidden.find((fragment) => text.includes(fragment));
  if (match) throw new Error(`client payload contains forbidden secret material: ${match}`);
  return true;
}

function mockProviderAnswer(prompt) {
  const text = String(prompt || "").trim();
  if (!text) throw new TypeError("prompt is required");
  return `MOCK DAVID: ${text}`;
}

module.exports = {
  ACCOUNT_ISOLATION_INVARIANTS,
  PROVIDER_ALLOWLIST,
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_STAGES,
  assertNoClientSecrets,
  buildAccountScope,
  mockProviderAnswer
};
