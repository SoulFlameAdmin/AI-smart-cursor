-- DAVID SOUL Relay v1
-- Run once in the Supabase SQL editor before deploying david-soul-bridge.

create extension if not exists pgcrypto;

create table if not exists public.david_soul_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text,
  prompt text not null check (char_length(prompt) between 1 and 100000),
  context_text text,
  messages jsonb not null default '[]'::jsonb,
  answer text,
  error text,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  claimed_by text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists david_soul_messages_queue_idx
  on public.david_soul_messages (status, created_at);

create index if not exists david_soul_messages_user_idx
  on public.david_soul_messages (user_id, created_at desc);

alter table public.david_soul_messages enable row level security;

revoke all on public.david_soul_messages from anon;
revoke all on public.david_soul_messages from authenticated;

grant select, insert on public.david_soul_messages to authenticated;

 drop policy if exists "SOUL users read own messages"
  on public.david_soul_messages;
create policy "SOUL users read own messages"
  on public.david_soul_messages
  for select
  to authenticated
  using (auth.uid() = user_id);

 drop policy if exists "SOUL users enqueue own messages"
  on public.david_soul_messages;
create policy "SOUL users enqueue own messages"
  on public.david_soul_messages
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and status = 'queued'
    and answer is null
    and error is null
    and claimed_by is null
    and lease_until is null
  );

create or replace function public.claim_david_soul_message(
  p_user_id uuid default null,
  p_worker text default 'david-soul-relay-v1'
)
returns setof public.david_soul_messages
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select message.id
    from public.david_soul_messages as message
    where
      (p_user_id is null or message.user_id = p_user_id)
      and (
        message.status = 'queued'
        or (
          message.status = 'processing'
          and message.lease_until is not null
          and message.lease_until < now()
        )
      )
    order by message.created_at asc
    limit 1
    for update skip locked
  )
  update public.david_soul_messages as message
  set
    status = 'processing',
    claimed_by = left(coalesce(p_worker, 'david-soul-relay-v1'), 160),
    lease_until = now() + interval '10 minutes',
    error = null,
    updated_at = now()
  from candidate
  where message.id = candidate.id
  returning message.*;
end;
$$;

revoke all on function public.claim_david_soul_message(uuid, text) from public;
grant execute on function public.claim_david_soul_message(uuid, text)
  to service_role;

comment on table public.david_soul_messages is
  'Queue between an authenticated Soul/Twins user and the local DAVID Electron SOUL relay.';
