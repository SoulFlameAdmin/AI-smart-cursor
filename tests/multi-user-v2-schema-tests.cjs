"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const migrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20260804000100_david_multi_user_v2_identity_registry.sql"
);
const indexMigrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20260804000200_david_multi_user_v2_fk_indexes.sql"
);
const rollbackPath = path.join(
  root,
  "supabase",
  "rollback",
  "20260804000100_david_multi_user_v2_identity_registry_rollback.sql"
);

assert.ok(fs.existsSync(migrationPath), "Stage 2 migration must exist");
assert.ok(fs.existsSync(indexMigrationPath), "Stage 2 index migration must exist");
assert.ok(fs.existsSync(rollbackPath), "Stage 2 rollback must exist");

const migration = fs.readFileSync(migrationPath, "utf8");
const indexMigration = fs.readFileSync(indexMigrationPath, "utf8");
const rollback = fs.readFileSync(rollbackPath, "utf8");
const compact = migration.replace(/\s+/g, " ").toLowerCase();
const indexCompact = indexMigration.replace(/\s+/g, " ").toLowerCase();
const rollbackCompact = rollback.replace(/\s+/g, " ").toLowerCase();

assert.match(compact, /^begin;/, "Migration must be transactional");
assert.match(compact, /commit;\s*$/, "Migration must commit atomically");
assert.match(compact, /create schema if not exists david_v2;/);
assert.match(indexCompact, /^begin;/, "Index migration must be transactional");
assert.match(indexCompact, /commit;\s*$/, "Index migration must commit atomically");

for (const table of [
  "system_config",
  "identities",
  "conversations",
  "user_consents",
  "soul_threads"
]) {
  assert.match(
    compact,
    new RegExp(`create table david_v2\\.${table} \\(`),
    `${table} must be created in the private david_v2 schema`
  );
  assert.match(
    compact,
    new RegExp(`alter table david_v2\\.${table} enable row level security;`),
    `${table} must enable RLS`
  );
  assert.match(
    compact,
    new RegExp(`alter table david_v2\\.${table} force row level security;`),
    `${table} must force RLS`
  );
}

assert.match(
  compact,
  /revoke all on schema david_v2 from public, anon, authenticated;/,
  "Client roles must not access the private schema"
);
assert.match(
  compact,
  /revoke all on all tables in schema david_v2 from public, anon, authenticated;/,
  "Client roles must not access private tables"
);
assert.match(
  compact,
  /revoke all on all functions in schema david_v2 from public, anon, authenticated;/,
  "Client roles must not execute private functions"
);
assert.doesNotMatch(
  compact,
  /grant\s+(?:all|select|insert|update|delete|usage|execute)[^;]*\s+to\s+(?:anon|authenticated)\s*;/,
  "Stage 2 must not grant direct client access"
);

assert.match(compact, /references auth\.users\(id\)/);
assert.match(compact, /references public\.sf_twin_profiles\(id\)/);
assert.match(compact, /conversations_identity_owner_fk/);
assert.match(compact, /soul_threads_conversation_owner_fk/);
assert.match(compact, /create or replace function david_v2\.enforce_twin_owner\(\)/);
assert.match(compact, /t\.owner_id = new\.user_id/);
assert.match(compact, /conversations_user_twin_provider_unique/);
assert.match(compact, /provider_conversation_id is not null/);

for (const requiredIndex of [
  /on david_v2\.conversations\(identity_id, user_id\)/,
  /on david_v2\.conversations\(twin_id\)/,
  /on david_v2\.user_consents\(identity_id, user_id\)/,
  /on david_v2\.user_consents\(twin_id\)/,
  /on david_v2\.soul_threads\(conversation_id, identity_id, user_id, twin_id\)/,
  /on david_v2\.soul_threads\(source_thread_id\)/,
  /on david_v2\.soul_threads\(twin_id\)/
]) {
  assert.match(indexCompact, requiredIndex, "Every Stage 2 foreign key must have a covering index");
}

assert.match(compact, /'david-v2-stage2-1'/);
assert.match(compact, /multi_user_enabled[^,]*false/);
assert.match(compact, /provider_enabled[^,]*false/);
assert.match(compact, /electron_routing_enabled[^,]*false/);
assert.match(compact, /rollout_limit[^,]*0/);

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
    `Stage 2 must not mutate locked v1 object ${protectedObject}`
  );
  assert.doesNotMatch(
    indexCompact,
    new RegExp(`(?:alter|drop|truncate|delete from|update)\\s+(?:table\\s+)?${escaped}`),
    `Stage 2 index migration must not mutate locked v1 object ${protectedObject}`
  );
}

assert.doesNotMatch(
  `${migration}\n${indexMigration}`,
  /(?:sk-[a-z0-9_-]{10,}|sb_secret_|service_role\s*[:=]|password\s*[:=]|DAVID_DEVICE_TOKEN\s*=)/i,
  "Stage 2 migrations must not contain credentials or secrets"
);

assert.match(rollbackCompact, /^begin;/);
assert.match(rollbackCompact, /multi_user_enabled/);
assert.match(rollbackCompact, /provider_enabled/);
assert.match(rollbackCompact, /electron_routing_enabled/);
assert.match(rollbackCompact, /rollback refused/);
assert.match(rollbackCompact, /drop schema if exists david_v2 cascade;/);
assert.match(rollbackCompact, /commit;\s*$/);
assert.doesNotMatch(
  rollbackCompact,
  /drop\s+(?:table|schema)[^;]*(?:david_soul_messages|sf_soul_threads|sf_soul_messages)/,
  "Rollback must only remove the isolated david_v2 schema"
);

console.log("DAVID Multi-User v2 Stage 2 schema, isolation, indexes and rollback tests: PASS");
