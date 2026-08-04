"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const migrationPath = path.join(root, "supabase", "migrations", "20260804004000_david_multi_user_v2_stage4_api_gateway.sql");
const guardPath = path.join(root, "supabase", "migrations", "20260804004100_david_multi_user_v2_stage4_gateway_twin_guard.sql");
const rollbackPath = path.join(root, "supabase", "rollback", "20260804004000_david_multi_user_v2_stage4_api_gateway_rollback.sql");
const functionPath = path.join(root, "supabase", "functions", "david-api-gateway-v2", "index.ts");
const contractPath = path.join(root, "supabase", "functions", "david-api-gateway-v2", "contract.ts");
const deploymentPath = path.join(root, "supabase", "functions", "david-api-gateway-v2", "deployment.json");

for (const file of [migrationPath, guardPath, rollbackPath, functionPath, contractPath, deploymentPath]) {
  assert.ok(fs.existsSync(file), `Missing Stage 4 file: ${path.relative(root, file)}`);
}

const migration = fs.readFileSync(migrationPath, "utf8");
const guard = fs.readFileSync(guardPath, "utf8");
const rollback = fs.readFileSync(rollbackPath, "utf8");
const edge = fs.readFileSync(functionPath, "utf8");
const contract = fs.readFileSync(contractPath, "utf8");
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

assert.match(migration, /add column if not exists gateway_enabled boolean not null default false/i);
assert.match(migration, /create table david_v2\.gateway_requests/i);
assert.match(migration, /gateway_requests_user_key_unique unique \(user_id, request_key\)/i);
assert.match(migration, /request_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
assert.match(migration, /octet_length\(response_body::text\) <= 16384/i);
assert.match(migration, /lease_until = now\(\) \+ interval '2 minutes'/i);
assert.match(migration, /pg_advisory_xact_lock/i);
assert.match(migration, /idempotency key conflict/i);
assert.match(migration, /create policy david_v2_gateway_requests_owner_select/i);
assert.match(migration, /user_id = \(select auth\.uid\(\)\)/i);
assert.match(migration, /revoke all on table david_v2\.gateway_requests from public, anon, authenticated/i);
assert.match(migration, /gateway_enabled = false/i);
assert.match(migration, /provider_calls_enabled', false/i);
assert.doesNotMatch(migration, /alter table public\.david_soul_messages/i);
assert.doesNotMatch(migration, /drop table public\./i);

assert.match(guard, /create trigger david_v2_gateway_requests_twin_owner/i);
assert.match(guard, /when \(new\.twin_id is not null\)/i);
assert.match(guard, /execute function david_v2\.enforce_twin_owner\(\)/i);
assert.match(guard, /gateway_enabled = false/i);

assert.match(rollback, /Refusing DAVID v2 Stage 4 rollback while runtime or rollout is enabled/i);
assert.match(rollback, /Refusing DAVID v2 Stage 4 rollback while gateway request records exist/i);
assert.match(rollback, /drop table if exists david_v2\.gateway_requests/i);
assert.match(rollback, /schema_version = 'david-v2-stage3-1'/i);
assert.doesNotMatch(rollback, /drop schema/i);

assert.strictEqual(deployment.verify_jwt, true);
assert.strictEqual(deployment.runtime_state, "disabled");
assert.strictEqual(deployment.provider_calls, false);
assert.strictEqual(deployment.service_role_client, false);

assert.match(edge, /client\.auth\.getUser\(\)/);
assert.match(edge, /SUPABASE_ANON_KEY/);
assert.doesNotMatch(edge, /SUPABASE_SERVICE_ROLE_KEY/);
assert.doesNotMatch(edge, /SUPABASE_SECRET_KEYS/);
assert.doesNotMatch(edge, /api\.openai\.com/i);
assert.doesNotMatch(edge, /anthropic/i);
assert.doesNotMatch(edge, /provider_conversation/i);
assert.match(edge, /DAVID_GATEWAY_ALLOWED_ORIGINS/);
assert.match(edge, /origin_denied/);
assert.match(edge, /request_too_large/);
assert.match(edge, /payload_contains_unknown_field/);
assert.match(edge, /david_v2_gateway_begin_my_request/);
assert.match(edge, /david_v2_gateway_complete_my_request/);
assert.match(edge, /david_v2_gateway_fail_my_request/);
assert.match(edge, /request_in_progress/);
assert.match(edge, /idempotency_key_conflict/);
assert.match(edge, /canonicalize/);
assert.match(edge, /sha256/);
assert.match(edge, /MAX_RESPONSE_BYTES/);
assert.doesNotMatch(edge, /body\.user_id/);
assert.doesNotMatch(edge, /payload\.user_id/);

for (const operation of [
  "health",
  "bootstrap",
  "get_identity",
  "set_consent",
  "list_consents",
  "register_local_conversation",
  "list_conversations",
  "create_thread",
  "list_threads"
]) {
  assert.ok(contract.includes(`\"${operation}\"`), `Missing gateway operation ${operation}`);
}

assert.match(contract, /MAX_BODY_BYTES = 65_536/);
assert.match(contract, /MAX_RESPONSE_BYTES = 16_384/);
assert.doesNotMatch(contract, /send_message/);
assert.doesNotMatch(contract, /chat_completion/);

console.log("DAVID Multi-User v2 Stage 4 API Gateway tests: PASS");
