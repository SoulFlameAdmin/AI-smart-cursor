"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260805010000_david_multi_user_v2_stage5_account_isolation.sql"),
  "utf8"
);
const stage2Migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260804000100_david_multi_user_v2_identity_registry.sql"),
  "utf8"
);
const rollback = fs.readFileSync(
  path.join(root, "supabase", "rollback", "20260805010000_david_multi_user_v2_stage5_account_isolation_rollback.sql"),
  "utf8"
);
const router = fs.readFileSync(
  path.join(root, "supabase", "functions", "david-provider-router-v2", "index.ts"),
  "utf8"
);
const contractSource = fs.readFileSync(
  path.join(root, "core", "multi-user-v2", "provider-contract.cjs"),
  "utf8"
);

const {
  ACCOUNT_ISOLATION_INVARIANTS,
  PROVIDER_STAGES,
  assertNoClientSecrets,
  buildAccountScope,
  mockProviderAnswer
} = require("../core/multi-user-v2/provider-contract.cjs");

assert.match(migration, /provider_router_enabled boolean not null default false/u);
assert.match(migration, /create table david_v2\.provider_runs/u);
assert.match(migration, /create table david_v2\.provider_run_events/u);
assert.match(migration, /create table david_v2\.provider_usage_daily/u);
assert.match(migration, /create table david_v2\.device_routes/u);
assert.match(migration, /create table david_v2\.user_limits/u);
assert.match(stage2Migration, /conversations_user_twin_provider_unique unique \(user_id, twin_id, provider\)/u);
assert.match(migration, /on conflict \(user_id, twin_id, provider\)/u);
assert.match(migration, /provider_runs_user_message_unique unique \(user_id, client_message_key\)/u);
assert.match(migration, /foreign key \(conversation_id, identity_id, user_id, twin_id\)/u);
assert.match(migration, /foreign key \(thread_id, conversation_id, identity_id, user_id, twin_id\)/u);
assert.match(migration, /using \(user_id = \(select auth\.uid\(\)\)\)/u);
assert.match(migration, /revoke all on table david_v2\.provider_runs from public, anon, authenticated/u);
assert.match(migration, /provider_keys_server_only', true/u);
assert.match(migration, /private_chat_urls_stored', false/u);
assert.match(migration, /gmail_is_login_not_primary_key', true/u);
assert.match(migration, /provider_calls_enabled', false/u);
assert.match(migration, /rollout_limit = 0/u);
assert.match(migration, /create or replace function david_v2\.claim_provider_run/u);
assert.match(migration, /for update skip locked/u);
assert.match(migration, /create or replace function david_v2\.complete_provider_run/u);
assert.match(migration, /create or replace function public\.david_v2_get_my_provider_run/u);
assert.doesNotMatch(migration, /chatgpt\.com\/c\//iu);
assert.doesNotMatch(migration, /gmail\.com/iu);
assert.doesNotMatch(migration, /api[_-]?key\s*=/iu);

assert.match(router, /client\.auth\.getUser\(\)/u);
assert.match(router, /account_isolation_key: "auth\.uid"/u);
assert.match(router, /provider_calls_enabled: false/u);
assert.match(router, /"user_id" in value/u);
assert.match(router, /"email" in value/u);
assert.match(router, /"api_key" in value/u);
assert.match(router, /"cookie" in value/u);
assert.match(router, /"chat_url" in value/u);
assert.doesNotMatch(router, /SUPABASE_SERVICE_ROLE_KEY/u);
assert.doesNotMatch(router, /OPENAI_API_KEY/u);
assert.doesNotMatch(router, /chatgpt\.com\/c\//u);

assert.match(rollback, /Refusing Stage 5 rollback while DAVID v2 runtime flags or rollout are enabled/u);
assert.match(rollback, /Refusing Stage 5 rollback while Stage 5 rows exist/u);
assert.match(rollback, /schema_version = 'david-v2-stage4-1'/u);

assert.ok(ACCOUNT_ISOLATION_INVARIANTS.length >= 8);
assert.ok(PROVIDER_STAGES.includes("provider_thinking"));
assert.ok(PROVIDER_STAGES.includes("completed"));
assert.strictEqual(
  mockProviderAnswer("Здравей"),
  "MOCK DAVID: Здравей"
);
assert.deepStrictEqual(
  buildAccountScope({
    userId: "user-a",
    identityId: "identity-a",
    twinId: "twin-a",
    conversationId: "conversation-a",
    threadId: "thread-a"
  }),
  {
    user_id: "user-a",
    identity_id: "identity-a",
    twin_id: "twin-a",
    conversation_id: "conversation-a",
    thread_id: "thread-a"
  }
);
assert.strictEqual(assertNoClientSecrets({ prompt: "hello" }), true);
assert.throws(() => assertNoClientSecrets({ cookie: "secret" }), /forbidden secret material/u);
assert.match(contractSource, /Gmail is only an authentication attribute/u);

console.log("DAVID Multi-User v2 Stage 5 account isolation tests: PASS");
