"use strict";

const assert = require("assert");
const {
  DAVID_MULTI_USER_V2
} = require("../core/multi-user-v2/manifest.cjs");

assert.strictEqual(DAVID_MULTI_USER_V2.product, "DAVID Multi-User SOUL");
assert.strictEqual(DAVID_MULTI_USER_V2.version, "2.0.0-dev");
assert.strictEqual(DAVID_MULTI_USER_V2.stage, "foundation");
assert.strictEqual(
  DAVID_MULTI_USER_V2.base_release.branch,
  "stable/david-soul-chat-v1.0.1"
);
assert.strictEqual(
  DAVID_MULTI_USER_V2.base_release.commit,
  "128a61af7243ef63749a0eaddcdb1a528b2ebadd"
);
assert.strictEqual(DAVID_MULTI_USER_V2.provider_mode, "server-api");
assert.strictEqual(
  DAVID_MULTI_USER_V2.conversation_model,
  "one-isolated-core-conversation-per-user-and-twin"
);

const invariants = DAVID_MULTI_USER_V2.invariants.join("\n");
assert.match(invariants, /never modified directly/i);
assert.match(invariants, /exactly one user and one Twin/i);
assert.match(invariants, /never shared between users/i);
assert.match(invariants, /server-side only/i);
assert.match(invariants, /never sent to GPT/i);
assert.match(invariants, /never executed directly as PowerShell/i);
assert.match(invariants, /authenticated user/i);

for (const requiredModule of [
  "identity_resolver",
  "user_provisioning",
  "conversation_registry",
  "session_router",
  "context_pack_builder",
  "consent_engine",
  "soul_queue_v2",
  "api_gateway",
  "memory_isolation",
  "device_registry",
  "security_lock",
  "recovery_idempotency"
]) {
  assert.ok(
    DAVID_MULTI_USER_V2.modules.includes(requiredModule),
    `Missing v2 module: ${requiredModule}`
  );
}

console.log("DAVID Multi-User SOUL v2 foundation tests: PASS");
