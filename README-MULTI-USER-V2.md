# DAVID Multi-User SOUL v2

This branch starts the multi-user architecture from the locked DAVID SOUL CHAT v1.0.1 release.

## Goal

Each authenticated SoulFlame user receives an isolated DAVID identity, an isolated GPT conversation, isolated memory, consent settings, usage limits, and optional paired Electron devices.

## Hard rules

- `stable/david-soul-chat-v1.0.1` remains the rollback release and is never edited directly.
- Users never share Dimitar's personal ChatGPT account, Edge profile, cookies, or private conversation URL.
- Provider and Supabase secret keys remain on trusted server infrastructure.
- Frontend-supplied `user_id` values are never trusted without server verification.
- Conversation ownership must match the authenticated user before any provider request.
- SOUL text and model output are never executed directly as shell commands.
- Device actions require capabilities, risk classification, and confirmation where required.

## Stage order

1. Foundation branch and invariants.
2. Supabase identity and conversation schema.
3. RLS and ownership functions.
4. DAVID API Gateway.
5. Provider conversation integration.
6. SOUL queue v2.
7. Context, consent, and memory isolation.
8. Cost controls and device routing.
9. Security, recovery, load tests, pilot, and stable lock.

## Current state

Stage 1 foundation only. No production routing, database schema, provider key, or user data has been added in this step.
