begin;

alter table david_v2.system_config
  add column if not exists gateway_enabled boolean not null default false;

create table david_v2.gateway_requests (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  twin_id uuid references public.sf_twin_profiles(id) on delete cascade,
  conversation_id uuid,
  operation text not null check (operation in (
    'bootstrap',
    'get_identity',
    'set_consent',
    'list_consents',
    'register_local_conversation',
    'list_conversations',
    'create_thread',
    'list_threads'
  )),
  request_key text not null check (char_length(request_key) between 8 and 160),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'accepted' check (status in ('accepted', 'completed', 'failed')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  response_body jsonb,
  error_code text check (error_code is null or char_length(error_code) between 1 and 120),
  lease_until timestamptz,
  attempt_count integer not null default 1 check (attempt_count between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint gateway_requests_identity_owner_fk
    foreign key (identity_id, user_id)
    references david_v2.identities(id, user_id)
    on delete cascade,
  constraint gateway_requests_conversation_owner_fk
    foreign key (conversation_id, identity_id, user_id, twin_id)
    references david_v2.conversations(id, identity_id, user_id, twin_id)
    on delete cascade,
  constraint gateway_requests_user_key_unique unique (user_id, request_key),
  constraint gateway_requests_response_object check (
    response_body is null
    or (
      jsonb_typeof(response_body) = 'object'
      and octet_length(response_body::text) <= 16384
    )
  ),
  constraint gateway_requests_state_check check (
    (status = 'accepted' and http_status is null and completed_at is null and lease_until is not null)
    or
    (status = 'completed' and http_status between 200 and 299 and completed_at is not null and lease_until is null and error_code is null)
    or
    (status = 'failed' and http_status between 400 and 599 and completed_at is not null and lease_until is null and error_code is not null)
  ),
  constraint gateway_requests_scope_check check (
    (operation in ('bootstrap', 'get_identity', 'list_conversations', 'list_threads') and conversation_id is null)
    or
    (operation in ('set_consent', 'list_consents', 'register_local_conversation') and twin_id is not null and conversation_id is null)
    or
    (operation = 'create_thread' and conversation_id is not null and twin_id is not null and identity_id is not null)
  )
);

create index david_v2_gateway_requests_owner_created_idx
  on david_v2.gateway_requests(user_id, created_at desc);

create index david_v2_gateway_requests_lease_idx
  on david_v2.gateway_requests(status, lease_until)
  where status = 'accepted';

create index david_v2_gateway_requests_conversation_idx
  on david_v2.gateway_requests(conversation_id, created_at desc)
  where conversation_id is not null;

create trigger david_v2_gateway_requests_touch_updated_at
before update on david_v2.gateway_requests
for each row execute function david_v2.touch_updated_at();

alter table david_v2.gateway_requests enable row level security;
alter table david_v2.gateway_requests force row level security;

create policy david_v2_gateway_requests_owner_select
  on david_v2.gateway_requests
  for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table david_v2.gateway_requests from public, anon, authenticated;
grant select, insert, update, delete on table david_v2.gateway_requests to service_role;

create or replace function david_v2.require_gateway_enabled()
returns void
language plpgsql
security definer
set search_path = pg_catalog, david_v2
as $$
declare
  v_gateway_enabled boolean;
  v_multi_user_enabled boolean;
begin
  select c.gateway_enabled, c.multi_user_enabled
    into v_gateway_enabled, v_multi_user_enabled
  from david_v2.system_config c
  where c.id = 1;

  if coalesce(v_gateway_enabled, false) is not true
     or coalesce(v_multi_user_enabled, false) is not true then
    raise exception 'DAVID v2 API Gateway is disabled'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.david_v2_gateway_status()
returns table (
  schema_version text,
  gateway_enabled boolean,
  multi_user_enabled boolean,
  provider_enabled boolean,
  electron_routing_enabled boolean
)
language plpgsql
security definer
stable
set search_path = pg_catalog, auth, david_v2
as $$
begin
  perform david_v2.require_authenticated_user();

  return query
  select
    c.schema_version,
    c.gateway_enabled,
    c.multi_user_enabled,
    c.provider_enabled,
    c.electron_routing_enabled
  from david_v2.system_config c
  where c.id = 1;
end;
$$;

create or replace function public.david_v2_gateway_begin_my_request(
  p_operation text,
  p_request_key text,
  p_request_hash text,
  p_twin_id uuid default null,
  p_conversation_id uuid default null
)
returns table (
  gateway_request_id uuid,
  request_status text,
  acquired boolean,
  replay boolean,
  http_status integer,
  response_body jsonb,
  error_code text,
  lease_until timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
  v_identity_id uuid;
  v_twin_id uuid;
  v_operation text := btrim(coalesce(p_operation, ''));
  v_request_key text := btrim(coalesce(p_request_key, ''));
  v_request_hash text := lower(btrim(coalesce(p_request_hash, '')));
  v_existing david_v2.gateway_requests%rowtype;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_gateway_enabled();

  if v_operation not in (
    'bootstrap',
    'get_identity',
    'set_consent',
    'list_consents',
    'register_local_conversation',
    'list_conversations',
    'create_thread',
    'list_threads'
  ) then
    raise exception 'DAVID v2 gateway operation is not allowed'
      using errcode = '22023';
  end if;

  if char_length(v_request_key) not between 8 and 160 then
    raise exception 'DAVID v2 gateway request key is invalid'
      using errcode = '22023';
  end if;

  if v_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'DAVID v2 gateway request hash is invalid'
      using errcode = '22023';
  end if;

  if v_operation = 'bootstrap' then
    v_identity_id := null;
  else
    v_identity_id := david_v2.require_owned_identity(v_user_id);
  end if;

  if v_operation in ('set_consent', 'list_consents', 'register_local_conversation') then
    if p_twin_id is null then
      raise exception 'DAVID v2 gateway Twin is required'
        using errcode = '22004';
    end if;
    perform david_v2.assert_twin_owner(v_user_id, p_twin_id);
    v_twin_id := p_twin_id;
  elsif v_operation = 'create_thread' then
    if p_conversation_id is null then
      raise exception 'DAVID v2 gateway conversation is required'
        using errcode = '22004';
    end if;

    select o.identity_id, o.twin_id
      into v_identity_id, v_twin_id
    from david_v2.require_owned_conversation(v_user_id, p_conversation_id) o;
  else
    if p_twin_id is not null or p_conversation_id is not null then
      raise exception 'DAVID v2 gateway request scope is invalid'
        using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text || ':' || v_request_key));

  select r.*
    into v_existing
  from david_v2.gateway_requests r
  where r.user_id = v_user_id
    and r.request_key = v_request_key
  for update;

  if found then
    if v_existing.operation <> v_operation
       or v_existing.request_hash <> v_request_hash
       or v_existing.twin_id is distinct from v_twin_id
       or v_existing.conversation_id is distinct from p_conversation_id then
      raise exception 'DAVID v2 gateway idempotency key conflict'
        using errcode = '23505';
    end if;

    if v_existing.status in ('completed', 'failed') then
      return query select
        v_existing.id,
        v_existing.status,
        false,
        true,
        v_existing.http_status,
        v_existing.response_body,
        v_existing.error_code,
        v_existing.lease_until,
        v_existing.attempt_count;
      return;
    end if;

    if v_existing.lease_until > now() then
      return query select
        v_existing.id,
        v_existing.status,
        false,
        false,
        v_existing.http_status,
        v_existing.response_body,
        v_existing.error_code,
        v_existing.lease_until,
        v_existing.attempt_count;
      return;
    end if;

    update david_v2.gateway_requests r
    set
      identity_id = v_identity_id,
      twin_id = v_twin_id,
      conversation_id = p_conversation_id,
      lease_until = now() + interval '2 minutes',
      attempt_count = r.attempt_count + 1,
      error_code = null,
      response_body = null,
      http_status = null,
      completed_at = null
    where r.id = v_existing.id
    returning r.* into v_existing;

    return query select
      v_existing.id,
      v_existing.status,
      true,
      false,
      v_existing.http_status,
      v_existing.response_body,
      v_existing.error_code,
      v_existing.lease_until,
      v_existing.attempt_count;
    return;
  end if;

  insert into david_v2.gateway_requests (
    identity_id,
    user_id,
    twin_id,
    conversation_id,
    operation,
    request_key,
    request_hash,
    status,
    lease_until
  )
  values (
    v_identity_id,
    v_user_id,
    v_twin_id,
    p_conversation_id,
    v_operation,
    v_request_key,
    v_request_hash,
    'accepted',
    now() + interval '2 minutes'
  )
  returning * into v_existing;

  return query select
    v_existing.id,
    v_existing.status,
    true,
    false,
    v_existing.http_status,
    v_existing.response_body,
    v_existing.error_code,
    v_existing.lease_until,
    v_existing.attempt_count;
end;
$$;

create or replace function public.david_v2_gateway_complete_my_request(
  p_gateway_request_id uuid,
  p_http_status integer,
  p_response_body jsonb
)
returns table (
  gateway_request_id uuid,
  request_status text,
  http_status integer,
  response_body jsonb,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, auth, david_v2
as $$
declare
  v_user_id uuid;
  v_row david_v2.gateway_requests%rowtype;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_gateway_enabled();

  if p_http_status not between 200 and 299 then
    raise exception 'DAVID v2 gateway completion status is invalid'
      using errcode = '22023';
  end if;

  if p_response_body is null
     or jsonb_typeof(p_response_body) <> 'object'
     or octet_length(p_response_body::text) > 16384 then
    raise exception 'DAVID v2 gateway response body is invalid'
      using errcode = '22023';
  end if;

  update david_v2.gateway_requests r
  set
    status = 'completed',
    http_status = p_http_status,
    response_body = p_response_body,
    error_code = null,
    lease_until = null,
    completed_at = now()
  where r.id = p_gateway_request_id
    and r.user_id = v_user_id
    and r.status = 'accepted'
  returning r.* into v_row;

  if not found then
    raise exception 'DAVID v2 gateway request is not active for this user'
      using errcode = '42501';
  end if;

  return query select
    v_row.id,
    v_row.status,
    v_row.http_status,
    v_row.response_body,
    v_row.completed_at;
end;
$$;

create or replace function public.david_v2_gateway_fail_my_request(
  p_gateway_request_id uuid,
  p_http_status integer,
  p_error_code text
)
returns table (
  gateway_request_id uuid,
  request_status text,
  http_status integer,
  error_code text,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, auth, david_v2
as $$
declare
  v_user_id uuid;
  v_error_code text := btrim(coalesce(p_error_code, ''));
  v_row david_v2.gateway_requests%rowtype;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_gateway_enabled();

  if p_http_status not between 400 and 599 then
    raise exception 'DAVID v2 gateway failure status is invalid'
      using errcode = '22023';
  end if;

  if char_length(v_error_code) not between 1 and 120 then
    raise exception 'DAVID v2 gateway error code is invalid'
      using errcode = '22023';
  end if;

  update david_v2.gateway_requests r
  set
    status = 'failed',
    http_status = p_http_status,
    response_body = null,
    error_code = v_error_code,
    lease_until = null,
    completed_at = now()
  where r.id = p_gateway_request_id
    and r.user_id = v_user_id
    and r.status = 'accepted'
  returning r.* into v_row;

  if not found then
    raise exception 'DAVID v2 gateway request is not active for this user'
      using errcode = '42501';
  end if;

  return query select
    v_row.id,
    v_row.status,
    v_row.http_status,
    v_row.error_code,
    v_row.completed_at;
end;
$$;

revoke all on function public.david_v2_gateway_status() from public, anon;
revoke all on function public.david_v2_gateway_begin_my_request(text, text, text, uuid, uuid) from public, anon;
revoke all on function public.david_v2_gateway_complete_my_request(uuid, integer, jsonb) from public, anon;
revoke all on function public.david_v2_gateway_fail_my_request(uuid, integer, text) from public, anon;

grant execute on function public.david_v2_gateway_status() to authenticated, service_role;
grant execute on function public.david_v2_gateway_begin_my_request(text, text, text, uuid, uuid) to authenticated, service_role;
grant execute on function public.david_v2_gateway_complete_my_request(uuid, integer, jsonb) to authenticated, service_role;
grant execute on function public.david_v2_gateway_fail_my_request(uuid, integer, text) to authenticated, service_role;

revoke all on function david_v2.require_gateway_enabled() from public, anon, authenticated;
grant execute on function david_v2.require_gateway_enabled() to service_role;

update david_v2.system_config
set
  schema_version = 'david-v2-stage4-1',
  gateway_enabled = false,
  metadata = metadata || jsonb_build_object(
    'stage', 4,
    'state', 'api_gateway_schema_installed_disabled',
    'stage4_base_branch', 'stable/david-multi-user-v2-stage3',
    'stage4_base_commit', 'f22e41cd84483d069eb6ea7acfc5b4871fb46088',
    'gateway_request_ledger', true,
    'gateway_edge_function_deployed', false,
    'provider_calls_enabled', false
  )
where id = 1
  and multi_user_enabled = false
  and provider_enabled = false
  and electron_routing_enabled = false
  and rollout_limit = 0;

comment on table david_v2.gateway_requests is
  'Bounded owner-scoped idempotency and audit ledger for the DAVID v2 API Gateway.';
comment on function public.david_v2_gateway_begin_my_request(text, text, text, uuid, uuid) is
  'Acquires or safely replays one auth.uid()-owned gateway mutation using a request key and SHA-256 request hash.';
comment on function public.david_v2_gateway_complete_my_request(uuid, integer, jsonb) is
  'Completes only an active gateway request owned by auth.uid() and stores a bounded replay response.';
comment on function public.david_v2_gateway_fail_my_request(uuid, integer, text) is
  'Fails only an active gateway request owned by auth.uid() with a bounded machine-readable error code.';

commit;
