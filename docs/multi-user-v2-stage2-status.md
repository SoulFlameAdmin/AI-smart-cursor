# DAVID Multi-User SOUL v2 — Stage 2 Status

Status: `LOCKED_STABLE_DISABLED`

Stage 2 establishes the private multi-user identity and conversation registry. It does not enable multi-user runtime traffic, model-provider calls, or Electron routing.

## Stable snapshots

- Locked v1 rollback branch: `stable/david-soul-chat-v1.0.1`
- Locked v1 rollback commit: `128a61af7243ef63749a0eaddcdb1a528b2ebadd`
- Locked Stage 2 branch: `stable/david-multi-user-v2-stage2`
- Development branch: `feature/david-soul-multi-user-v2`
- Pull request: `#13`

The Stage 2 stable branch is a read-only recovery snapshot. Further work continues from a new development checkpoint and must not rewrite this snapshot.

## GitHub verification

- Stage 2 schema test commit: `6144156facd08b8615d5b098928413efc0b91676`
- Stage 2 index/test commit: `734eec27d062829b3bd53249db35c0bf41e8aa91`
- DAVID Baseline run `#98`: success
- DAVID Baseline run `#100`: success
- DAVID Baseline run `#101`: success

## Supabase migrations

- `20260804000223_david_multi_user_v2_identity_registry`
- `20260804000518_david_multi_user_v2_fk_indexes`

## Installed private schema

- `david_v2.system_config`
- `david_v2.identities`
- `david_v2.conversations`
- `david_v2.user_consents`
- `david_v2.soul_threads`

All five tables have RLS and FORCE RLS enabled. Direct schema, table, and function access is revoked from `PUBLIC`, `anon`, and `authenticated`. Only trusted server-side service access is granted.

## Runtime lock

- `multi_user_enabled = false`
- `provider_enabled = false`
- `electron_routing_enabled = false`
- `rollout_limit = 0`

Stage 2 contains no OpenAI key, no model-provider key, no device credential, no private ChatGPT URL, and no browser-session data.

## Isolation verification

The zero-cost transactional rehearsal and the production canary both passed:

- valid records for two different real Twin owners were accepted;
- a user-to-foreign-Twin binding was rejected;
- a foreign conversation-to-thread binding was rejected;
- all canary records were rolled back;
- production v2 tables contain zero user records after verification;
- `anon` and `authenticated` have no `david_v2` schema usage;
- all seven Stage 2 foreign-key paths have covering indexes.

## Final live v1 smoke test

The post-migration SOUL test passed on 2026-08-04:

- prompt: `TEST STAGE 2 V1`
- queue status: `completed`
- error: none
- answer: `TEST STAGE 2 V1 е успешен. DAVID SOUL работи нормално.`
- relay version: `david-soul-relay-v2`

This confirms that the installed but disabled Stage 2 schema did not break the locked v1 DAVID SOUL route.

## v1 integrity verification

- `public.david_soul_messages` still exists;
- previous A/B/C/D tests and the final Stage 2 smoke test completed without errors;
- the three protected SOUL worker RPCs remain denied to `anon` and `authenticated` and executable by `service_role`;
- stable release `david-soul-chat-v1-0-1` remains locked at commit `128a61af7243ef63749a0eaddcdb1a528b2ebadd`.

## Advisor review

For the new `david_v2` schema:

- no missing foreign-key covering-index findings remain;
- the only performance notes are unused-index INFO notices, expected while Stage 2 is disabled and empty;
- RLS-without-policy INFO notices are intentional because direct client access to the private schema is denied.

Pre-existing project-wide security and performance notices outside `david_v2` are not modified by Stage 2. They require a separate controlled hardening stage to avoid breaking production systems.

## Rollback

`supabase/rollback/20260804000100_david_multi_user_v2_identity_registry_rollback.sql` removes only `david_v2` and refuses to run when any v2 runtime flag is enabled.

## Lock decision

Stage 2 is complete, verified, and locked as an installed but disabled foundation. It may be used as the rollback point for Stage 3. No provider traffic, multi-user routing, user provisioning, or Electron v2 connection is active.
