"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const migrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20260804002000_david_multi_user_v2_stage3_ownership_functions.sql"
);
const rollbackPath = path.join(
  root,
  "supabase",
  "rollback",
  "20260804002000_david_multi_user_v2_stage3_ownership_functions_rollback.sql"
);

assert.ok(fs.existsSync(migrationPath), "Stage 3 ownership migration must exist");
assert.ok(fs.existsSync(rollbackPath), "Stage 3 guarded rollback must exist");

const migration = fs.readFileSync(migrationPath, "utf8");
const rollback = fs.readFileSync(rollbackPath, "utf8");
const compact = migration.replace(/\s+/g, " ").toLowerCase();
const rollbackCompact = rollback.replace(/\s+/g, " ").toLowerCase();

assert.match(compact, /^begin;/);
assert.match(compact, /commit;\s*$/);
assert.match(compact, /'david-v2-stage3-1'/);
assert.match(compact, /'stable\/david-multi-user-v2-stage2'/);
assert.match(compact, /'66630b824b3678354f98ba5fdfdc6381877c4e87'/);

for (const helper of [
  "require_authenticated_user",
  "require_multi_user_enabled",
  "assert_twin_owner",
  "require_owned_identity",
  "require_owned_conversation"
]) {
  assert.match(
    compact,
    new RegExp(`create or replace function david_v2\\.${helper}\\(`),
    `Missing private ownership helper ${helper}`
  );
}

for (const rpc of [
  "david_v2_provision_my_identity",
  "david_v2_get_my_identity",
  "david_v2_set_my_consent",
  "david_v2_list_my_consents",
  "david_v2_register_my_local_conversation",
  "david_v2_list_my_conversations",
  "david_v2_create_my_thread",
  "david_v2_list_my_threads"
]) {
  assert.match(
    compact,
    new RegExp(`create or replace function public\\.${rpc}\\(`),
    `Missing controlled Stage 3 RPC ${rpc}`
  );
}

assert.match(compact, /v_user_id uuid := auth\.uid\(\)/);
assert.doesNotMatch(
  compact,
  /create or replace function public\.david_v2_[^(]+\([^)]*p_user_id\s+uuid/,
  "Public Stage 3 RPCs must never accept a caller-supplied user_id"
);

const securityDefinerCount = (compact.match(/security definer/g) || []).length;
assert.ok(securityDefinerCount >= 13, "All helpers and public RPCs must be SECURITY DEFINER");
assert.doesNotMatch(
  compact,
  /security definer(?![^$]{0,300}set search_path)/,
  "Every SECURITY DEFINER function must pin search_path"
);

assert.match(compact, /pg_advisory_xact_lock\(hashtext\('david-v2-identity-rollout'\)\)/);
assert.match(compact, /rollout_limit/);
assert.match(compact, /multi_user_enabled/);
assert.match(compact, /runtime is disabled/);
assert.match(compact, /rollout limit has been reached/);

assert.match(compact, /t\.owner_id = p_user_id/);
assert.match(compact, /c\.user_id = p_user_id/);
assert.match(compact, /i\.user_id = p_user_id/);
assert.match(compact, /user_id = \(select auth\.uid\(\)\)/);

for (const policy of [
  "david_v2_identities_owner_select",
  "david_v2_conversations_owner_select",
  "david_v2_consents_owner_select",
  "david_v2_threads_owner_select"
]) {
  assert.match(compact, new RegExp(`create policy ${policy}`));
}

assert.doesNotMatch(
  compact,
  /grant\s+(?:select|insert|update|delete|all)[^;]*on\s+(?:table\s+)?david_v2\./,
  "Stage 3 must not grant direct private-table access"
);
assert.match(compact, /revoke all on function public\.david_v2_provision_my_identity\(\) from public, anon;/);
assert.match(compact, /grant execute on function public\.david_v2_provision_my_identity\(\) to authenticated, service_role;/);
assert.doesNotMatch(
  compact,
  /grant execute on function david_v2\.[^;]+ to authenticated/,
  "Private helper functions must not be executable by authenticated clients"
);

for (const protectedObject of [
  "public.david_soul_messages",
  "public.david_device_credentials",
  "public.sf_soul_threads",
  "public.sf_soul_messages"
]) {
  const escaped = protectedObject.replace(".", "\\.");
  assert.doesNotMatch(
    compact,
    new RegExp(`(?:alter|drop|truncate|delete from|update)\\s+(?:table\\s+)?${escaped}`),
    `Stage 3 must not mutate locked v1 object ${protectedObject}`
  );
}

assert.doesNotMatch(
  migration,
  /(?:sk-[a-z0-9_-]{10,}|sb_secret_|service_role\s*[:=]|password\s*[:=]|DAVID_DEVICE_TOKEN\s*=)/i,
  "Stage 3 migration must not contain credentials"
);

assert.match(rollbackCompact, /^begin;/);
assert.match(rollbackCompact, /rollback refused while runtime or rollout is enabled/);
assert.match(rollbackCompact, /drop policy if exists david_v2_identities_owner_select/);
assert.match(rollbackCompact, /drop function if exists public\.david_v2_provision_my_identity\(\)/);
assert.match(rollbackCompact, /schema_version = 'david-v2-stage2-1'/);
assert.doesNotMatch(rollbackCompact, /drop schema/);
assert.doesNotMatch(rollbackCompact, /drop table/);
assert.match(rollbackCompact, /commit;\s*$/);

console.log("DAVID Multi-User v2 Stage 3 ownership, RPC and rollback tests: PASS");
