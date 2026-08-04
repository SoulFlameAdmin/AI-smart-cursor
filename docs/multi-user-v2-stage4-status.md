# DAVID Multi-User SOUL v2 — Stage 4 Status

Status: `INSTALLED_DISABLED_VERIFIED`

Stage 4 adds the authenticated DAVID API Gateway control layer on top of the locked Stage 3 ownership registry. It does not enable multi-user production traffic, browser access, provider requests, model execution, SOUL queue v2, or Electron v2 routing.

## Locked base

- Base branch: `stable/david-multi-user-v2-stage3`
- Base commit: `f22e41cd84483d069eb6ea7acfc5b4871fb46088`
- v1 rollback branch: `stable/david-soul-chat-v1.0.1`
- v1 rollback commit: `128a61af7243ef63749a0eaddcdb1a528b2ebadd`

Both stable branches remain unchanged.

## Development checkpoint

- Branch: `feature/david-multi-user-v2-stage4-api-gateway`
- Pull request: `#15` (draft)
- Verified pre-status head: `7e59bf4b60a6ebcb2aced7a5490d99a56682aab1`
- DAVID Baseline run `#109`: success
- DAVID Baseline run `#111`: success
- DAVID Baseline run `#112`: success

## Applied Supabase migrations

- `david_multi_user_v2_stage4_api_gateway`
- `david_multi_user_v2_stage4_gateway_twin_guard`
- `david_multi_user_v2_stage4_gateway_deployment_record`

## Installed private data layer

`david_v2.gateway_requests` provides:

- owner-scoped request records;
- operation allowlisting;
- unique `(user_id, request_key)` idempotency;
- canonical SHA-256 request hashes;
- accepted/completed/failed state constraints;
- bounded replay responses up to 16 KiB;
- two-minute execution leases;
- stale lease recovery through attempt counting;
- composite identity/conversation ownership constraints;
- Twin ownership enforcement trigger;
- RLS and FORCE RLS;
- no direct `anon` or `authenticated` table grants.

## Installed public RPC layer

Authenticated callers can execute only:

- `public.david_v2_gateway_status()`
- `public.david_v2_gateway_begin_my_request(...)`
- `public.david_v2_gateway_complete_my_request(...)`
- `public.david_v2_gateway_fail_my_request(...)`

All ownership is derived from `auth.uid()`. `anon` execution is denied. The private gateway helper is denied to authenticated clients.

## Edge Function deployment

- Slug: `david-api-gateway-v2`
- Version: `1`
- Status: `ACTIVE`
- Platform JWT verification: `true`
- Deployment SHA-256: `bbab53490b2d1ff3dc92a015e9451ce7922eb732d051ee852c8b7f7dadf23cce`
- Explicit `auth.getUser()` validation: present
- Supabase client credential: publishable/anon key only
- Service-role client: absent
- Provider/model network calls: absent
- Accepted client `user_id` or `owner_id`: none
- Browser origin allowlist configured: false

The Edge Function is deployed but cannot enter the production control path while the database runtime flags remain disabled. Browser calls are also blocked until an explicit origin allowlist is configured in a later rollout stage.

## Runtime lock

- `schema_version = david-v2-stage4-1`
- `gateway_enabled = false`
- `multi_user_enabled = false`
- `provider_enabled = false`
- `electron_routing_enabled = false`
- `rollout_limit = 0`

Production rows after verification:

- gateway requests: 0
- identities: 0
- conversations: 0
- consents: 0
- threads: 0

## Verification

Static regression and baseline tests passed.

A database canary returned `PASS_ROLLED_BACK` and verified:

- idempotency unique-key enforcement;
- foreign Twin rejection through the ownership trigger;
- foreign conversation rejection through composite ownership constraints;
- request state-machine enforcement;
- replay response-size enforcement;
- lease attempt recovery storage.

All canary data was removed by rollback.

A simulated authenticated JWT role-switch test was blocked by the platform safety filter and is not counted as passed. Effective database privileges, RLS/FORCE RLS, triggers, constraints and Edge Function `verify_jwt=true` were verified independently. No claim of a live authenticated Stage 4 user request is made at this checkpoint.

## v1 integrity

- `public.david_soul_messages` still exists;
- v1.0.1 remains locked;
- its protected claim RPC remains denied to `anon` and `authenticated` and executable by `service_role`;
- Stage 4 does not alter the working Electron-to-fixed-GPT-session route.

## Guarded rollback

The Stage 4 rollback:

- refuses to run while gateway/runtime/rollout is enabled;
- refuses to run while gateway request records exist;
- removes only Stage 4 database objects;
- restores the Stage 3 schema version;
- preserves the Stage 3 schema and all stable v1 objects.

## Final Stage 4 gate

Before Stage 4 is locked as a stable disabled snapshot, one post-migration v1 SOUL smoke test must complete successfully:

`TEST STAGE 4 V1`
