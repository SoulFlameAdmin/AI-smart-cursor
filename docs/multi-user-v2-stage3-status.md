# DAVID Multi-User SOUL v2 — Stage 3 Status

Status: `LOCKED_VERIFIED_DISABLED`

Stage 3 adds the controlled ownership and RPC layer on top of the locked Stage 2 registry. It does not enable multi-user traffic, provider requests, production provisioning, or Electron v2 routing.

## Locked base

- Base branch: `stable/david-multi-user-v2-stage2`
- Base commit: `66630b824b3678354f98ba5fdfdc6381877c4e87`
- v1 rollback branch: `stable/david-soul-chat-v1.0.1`
- v1 rollback commit: `128a61af7243ef63749a0eaddcdb1a528b2ebadd`

Both earlier stable branches remain unchanged.

## Stable Stage 3 snapshot

- Stable branch: `stable/david-multi-user-v2-stage3`
- Source branch: `feature/david-multi-user-v2-stage3-ownership`
- Pull request: `#14`
- Pre-lock status commit: `952549fea2e01d37b17697d2ee33793fc96dd3c4`
- DAVID Baseline run `#103`: success
- DAVID Baseline run `#106`: success
- DAVID Baseline run `#107`: success
- Final lock commit is the head of the stable Stage 3 branch.

## Supabase migrations

- `20260804003044_david_multi_user_v2_stage3_ownership_functions`
- `20260804003404_david_multi_user_v2_stage3_ownership_ambiguity_fix`

## Installed ownership layer

Private helpers:

- `david_v2.require_authenticated_user()`
- `david_v2.require_multi_user_enabled()`
- `david_v2.assert_twin_owner(user_id, twin_id)`
- `david_v2.require_owned_identity(user_id)`
- `david_v2.require_owned_conversation(user_id, conversation_id)`

Controlled public RPCs:

- `public.david_v2_provision_my_identity()`
- `public.david_v2_get_my_identity()`
- `public.david_v2_set_my_consent(...)`
- `public.david_v2_list_my_consents(...)`
- `public.david_v2_register_my_local_conversation(...)`
- `public.david_v2_list_my_conversations()`
- `public.david_v2_create_my_thread(...)`
- `public.david_v2_list_my_threads()`

Every public RPC derives the caller from `auth.uid()`. No public Stage 3 RPC accepts a caller-supplied `user_id`.

## Access control

- `anon` schema usage: denied
- `authenticated` private-schema usage: denied
- `anon` public Stage 3 RPC execution: denied
- `authenticated` controlled public RPC execution: allowed
- `authenticated` private-helper execution: denied
- direct private-table grants: none
- owner-only RLS SELECT policies: four
- SECURITY DEFINER functions pin `search_path`

## Runtime lock

- `schema_version = david-v2-stage3-1`
- `multi_user_enabled = false`
- `provider_enabled = false`
- `electron_routing_enabled = false`
- `rollout_limit = 0`

Production v2 rows after testing:

- identities: 0
- conversations: 0
- consents: 0
- threads: 0

Stage 3 contains no provider key, service credential, private ChatGPT URL, cookie, browser profile, or Electron device secret.

## Canary verification

The first transactional canary correctly exposed an output-column ambiguity in an idempotent `ON CONFLICT` path. The entire transaction rolled back and left no test data or enabled runtime state.

A follow-up migration fixed the issue by:

- using the named `user_consents_version_unique` constraint;
- using the named `conversations_user_twin_provider_unique` constraint;
- replacing thread conflict inference with an explicit update-then-insert idempotency path.

The repeated two-user canary then returned `PASS_ROLLED_BACK` and verified:

- runtime-disabled provisioning is rejected;
- rollout admission is serialized and limit-controlled;
- identity provisioning is idempotent;
- consent writing is idempotent;
- local conversation registration is idempotent;
- thread creation is idempotent;
- user A cannot bind user B's Twin;
- user A cannot create a thread in user B's conversation;
- public/private function privileges are correctly separated;
- all temporary records and temporary feature-flag changes were rolled back.

An additional database-role switching simulation was blocked by the platform safety filter and was not counted as a passed test. Effective privileges were instead verified directly through PostgreSQL privilege checks.

## Advisor review

For the new Stage 3 layer:

- no new missing-index finding was reported for `david_v2`;
- owner RLS policies use `(select auth.uid())`, avoiding per-row auth re-evaluation warnings;
- remaining `david_v2` performance notices are unused-index INFO entries expected while the runtime is disabled and tables are empty;
- security notices for private tables without direct client policies are intentional where schema access is denied;
- pre-existing project-wide notices outside Stage 3 were not modified.

## Final live v1 smoke test

The post-migration test `TEST STAGE 3 V1` completed successfully on 2026-08-04:

- queue status: `completed`
- queue stage: `completed`
- error: none
- worker: `david-soul-relay-v3`
- created: `2026-08-04T00:38:40.218725Z`
- completed: `2026-08-04T00:38:53.758Z`
- end-to-end duration: approximately 13.5 seconds
- answer returned to the same SOUL chat: `TEST STAGE 3 V1 е успешен. DAVID SOUL работи нормално.`

The screenshot supplied by the owner and the production queue record show the same completed flow: SOUL → DAVID Electron → fixed GPT session → SOUL.

## v1 integrity

- `public.david_soul_messages` still exists;
- the v1.0.1 stable release remains locked;
- `claim_david_soul_message`, `append_david_soul_progress`, and `attach_twin_teacher_lessons_to_soul_queue` remain denied to `anon` and `authenticated` and executable by `service_role`;
- Stage 3 does not change the working Electron-to-fixed-GPT-session route.

## Guarded rollback

`supabase/rollback/20260804002000_david_multi_user_v2_stage3_ownership_functions_rollback.sql` removes only the Stage 3 functions and owner policies. It preserves the Stage 2 schema and data, and refuses to run while runtime or rollout is enabled.

## Lock result

Stage 3 is accepted as a stable disabled snapshot. Stage 4 must branch from `stable/david-multi-user-v2-stage3`. The Stage 3 runtime flags remain disabled until a separate rollout stage explicitly enables them.