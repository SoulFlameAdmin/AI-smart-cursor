# DAVID Multi-User SOUL v2 — Stage 5 account isolation

Status: `PREPARED_DISABLED_NOT_INSTALLED`

## Base

- Base branch: `feature/david-multi-user-v2-stage4-api-gateway`
- Base commit: `d69f4fef3e05657d4b23d9df25c330c6fbeb446d`
- Stage 4 remains installed and disabled in production.
- This Stage 5 branch is not applied to production and does not enable provider traffic.

## Identity rule

Google/Gmail is only the authentication method. The permanent isolation key is `auth.users.id` / `auth.uid()`.

This avoids mixing data when:

- two people have different Gmail accounts;
- one person changes their email address;
- multiple accounts use the same device;
- a user has multiple Twins or SOUL threads.

No Gmail password is stored. No private ChatGPT URL, ChatGPT cookie, Edge profile, provider API key or service-role key is stored in a user row.

## Strict ownership chain

Every provider run is bound atomically to:

`auth.uid() -> DAVID identity -> Twin -> provider conversation -> SOUL thread -> provider run -> ordered progress events`

Composite foreign keys prevent a run from combining another user's identity, Twin, conversation or thread.

## New private tables

- `david_v2.user_limits` — plan limits and provider allowlist per `auth.uid()`.
- `david_v2.provider_runs` — one idempotent user message run.
- `david_v2.provider_run_events` — ordered progress such as received, connecting, thinking, reading and completed.
- `david_v2.provider_usage_daily` — request/token/cost counters per account.
- `david_v2.device_routes` — optional server or Electron route per account; disabled by default.

All tables use RLS + FORCE RLS. Direct access remains denied to `PUBLIC`, `anon` and `authenticated`; service-side access only. Owner reads are exposed through bounded RPCs.

## User RPCs

- `david_v2_ensure_my_provider_conversation`
- `david_v2_create_my_provider_run`
- `david_v2_get_my_provider_run`
- `david_v2_list_my_provider_run_events`

The RPCs derive ownership from `auth.uid()` and do not accept `user_id`, Gmail or owner overrides.

## Worker RPCs

Service-role only:

- `david_v2.claim_provider_run`
- `david_v2.append_provider_run_event`
- `david_v2.complete_provider_run`
- `david_v2.fail_provider_run`

The queue uses `FOR UPDATE SKIP LOCKED`, leases and attempt counting so many workers can process many accounts without claiming the same run twice.

## Provider router

`david-provider-router-v2` is prepared but not deployed.

- authenticated JWT required;
- explicit `auth.getUser()` verification;
- rejects `user_id`, `owner_id`, email overrides, API keys, authorization fields, cookies and private chat URLs;
- uses only user-scoped RPCs;
- contains no provider key and makes no provider/model call;
- `provider_calls_enabled: false`.

## Runtime locks

Stage 5 adds `provider_router_enabled`, default `false`.

Provider execution requires all of the following:

- `provider_router_enabled = true`
- `provider_enabled = true`
- `multi_user_enabled = true`
- `gateway_enabled = true`
- `rollout_limit > 0`

Current production remains:

- `provider_router_enabled`: not installed
- `provider_enabled = false`
- `multi_user_enabled = false`
- `gateway_enabled = false`
- `electron_routing_enabled = false`
- `rollout_limit = 0`

## Required gates before installation

1. Complete and lock Stage 4 with the exact live v1 smoke prompt `TEST STAGE 4 V1`.
2. Review Stage 5 SQL and CI.
3. Apply Stage 5 migration disabled.
4. Run a transactional two-user ownership canary and roll it back.
5. Deploy the provider router with `verify_jwt = true`, but keep browser origins and provider traffic disabled.
6. Run a mock-provider canary with two separate Google accounts.
7. Enable one controlled pilot account only after explicit approval.
