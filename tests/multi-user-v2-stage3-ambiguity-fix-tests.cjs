"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const migrationPath = path.join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260804002100_david_multi_user_v2_stage3_ownership_ambiguity_fix.sql"
);

assert.ok(fs.existsSync(migrationPath), "Stage 3 ambiguity fix migration must exist");

const sql = fs.readFileSync(migrationPath, "utf8");
const compact = sql.replace(/\s+/g, " ").toLowerCase();

assert.match(compact, /^begin;/);
assert.match(compact, /commit;\s*$/);
assert.match(compact, /on conflict on constraint user_consents_version_unique/);
assert.match(compact, /on conflict on constraint conversations_user_twin_provider_unique/);
assert.doesNotMatch(compact, /on conflict \(user_id, twin_id, provider\)/);
assert.doesNotMatch(compact, /on conflict \(user_id, twin_id, consent_key, consent_version\)/);

assert.match(
  compact,
  /update david_v2\.soul_threads as st set title = v_title where st\.user_id = v_user_id and st\.client_thread_key = v_client_key/
);
assert.match(compact, /if found then return; end if;/);
assert.doesNotMatch(
  compact,
  /on conflict \(user_id, client_thread_key\)/,
  "Thread idempotency must not use an output-column-ambiguous conflict target"
);

for (const fn of [
  "david_v2_set_my_consent",
  "david_v2_register_my_local_conversation",
  "david_v2_create_my_thread"
]) {
  assert.match(compact, new RegExp(`create or replace function public\\.${fn}\\(`));
  assert.match(compact, new RegExp(`revoke all on function public\\.${fn}`));
  assert.match(compact, new RegExp(`grant execute on function public\\.${fn}`));
}

assert.match(compact, /'stage3_ambiguity_fix', true/);
assert.doesNotMatch(
  sql,
  /(?:sk-[a-z0-9_-]{10,}|sb_secret_|service_role\s*[:=]|password\s*[:=]|DAVID_DEVICE_TOKEN\s*=)/i
);

console.log("DAVID Multi-User v2 Stage 3 ambiguity fix tests: PASS");
