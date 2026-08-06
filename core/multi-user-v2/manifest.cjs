"use strict";

const DAVID_MULTI_USER_V2 = Object.freeze({
  product: "DAVID Multi-User SOUL",
  version: "2.0.0-dev",
  stage: "foundation",
  development_branch: "feature/david-soul-multi-user-v2",
  base_release: Object.freeze({
    branch: "stable/david-soul-chat-v1.0.1",
    commit: "128a61af7243ef63749a0eaddcdb1a528b2ebadd",
    rollback_branch: "stable/david-soul-chat-v1.0.1"
  }),
  provider_mode: "server-api",
  conversation_model: "one-isolated-core-conversation-per-user-and-twin",
  invariants: Object.freeze([
    "The locked DAVID SOUL CHAT v1.0.1 branch is never modified directly.",
    "Every authenticated user is resolved from a verified server-side identity.",
    "Every GPT conversation belongs to exactly one user and one Twin.",
    "A user can never read, route to, or mutate another user's conversation or memory.",
    "Personal ChatGPT accounts, cookies, browser profiles, and private chat URLs are never shared between users.",
    "Provider API keys and Supabase service credentials remain server-side only.",
    "Passwords, access tokens, refresh tokens, cookies, and OAuth credentials are never sent to GPT.",
    "SOUL text and GPT output are never executed directly as PowerShell, shell, or device commands.",
    "Device actions require explicit capability and risk-policy checks.",
    "Every request is auditable, idempotent, and tied to one authenticated user."
  ]),
  modules: Object.freeze([
    "identity_resolver",
    "user_provisioning",
    "conversation_registry",
    "session_router",
    "context_pack_builder",
    "consent_engine",
    "soul_queue_v2",
    "api_gateway",
    "model_orchestrator",
    "memory_isolation",
    "response_delivery",
    "cost_guard",
    "device_registry",
    "action_permission_engine",
    "audit_observability",
    "recovery_idempotency",
    "security_lock",
    "admin_control_plane"
  ])
});

module.exports = {
  DAVID_MULTI_USER_V2
};
