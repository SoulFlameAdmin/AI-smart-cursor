begin;

-- Stage 3 keeps the private registry inaccessible to browser clients.
-- Authenticated callers may use only the explicitly granted SECURITY DEFINER RPCs below.

create or replace function david_v2.require_authenticated_user()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, auth
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'DAVID v2 requires an authenticated user'
      using errcode = '28000';
  end if;

  return v_user_id;
end;
$$;

create or replace function david_v2.require_multi_user_enabled()
returns void
language plpgsql
security definer
set search_path = pg_catalog, david_v2
as $$
declare
  v_enabled boolean;
begin
  select c.multi_user_enabled
    into v_enabled
  from david_v2.system_config c
  where c.id = 1;

  if coalesce(v_enabled, false) is not true then
    raise exception 'DAVID v2 multi-user runtime is disabled'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function david_v2.assert_twin_owner(
  p_user_id uuid,
  p_twin_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_twin_id is null then
    raise exception 'DAVID v2 user and Twin are required'
      using errcode = '22004';
  end if;

  if not exists (
    select 1
    from public.sf_twin_profiles t
    where t.id = p_twin_id
      and t.owner_id = p_user_id
  ) then
    raise exception 'DAVID v2 Twin does not belong to the authenticated user'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function david_v2.require_owned_identity(
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, david_v2
as $$
declare
  v_identity_id uuid;
  v_status text;
begin
  select i.id, i.status
    into v_identity_id, v_status
  from david_v2.identities i
  where i.user_id = p_user_id;

  if v_identity_id is null then
    raise exception 'DAVID v2 identity is not provisioned for the authenticated user'
      using errcode = 'P0002';
  end if;

  if v_status <> 'active' then
    raise exception 'DAVID v2 identity is not active'
      using errcode = '42501';
  end if;

  return v_identity_id;
end;
$$;

create or replace function david_v2.require_owned_conversation(
  p_user_id uuid,
  p_conversation_id uuid
)
returns table (
  conversation_id uuid,
  identity_id uuid,
  twin_id uuid,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, david_v2
as $$
begin
  return query
  select c.id, c.identity_id, c.twin_id, c.status
  from david_v2.conversations c
  where c.id = p_conversation_id
    and c.user_id = p_user_id;

  if not found then
    raise exception 'DAVID v2 conversation does not belong to the authenticated user'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.david_v2_provision_my_identity()
returns table (
  identity_id uuid,
  user_id uuid,
  status text,
  plan_key text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
  v_enabled boolean;
  v_rollout_limit integer;
  v_identity_count integer;
begin
  v_user_id := david_v2.require_authenticated_user();

  -- Serialize rollout admission so concurrent first logins cannot exceed the limit.
  perform pg_advisory_xact_lock(hashtext('david-v2-identity-rollout'));

  select c.multi_user_enabled, c.rollout_limit
    into v_enabled, v_rollout_limit
  from david_v2.system_config c
  where c.id = 1
  for update;

  if coalesce(v_enabled, false) is not true then
    raise exception 'DAVID v2 multi-user runtime is disabled'
      using errcode = '55000';
  end if;

  return query
  select i.id, i.user_id, i.status, i.plan_key, i.created_at
  from david_v2.identities i
  where i.user_id = v_user_id;

  if found then
    return;
  end if;

  if coalesce(v_rollout_limit, 0) <= 0 then
    raise exception 'DAVID v2 rollout is closed'
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_identity_count
  from david_v2.identities i
  where i.status <> 'deleted';

  if v_identity_count >= v_rollout_limit then
    raise exception 'DAVID v2 rollout limit has been reached'
      using errcode = '54000';
  end if;

  return query
  insert into david_v2.identities (user_id, status, plan_key)
  values (v_user_id, 'active', 'free')
  returning id, identities.user_id, identities.status, identities.plan_key, identities.created_at;
end;
$$;

create or replace function public.david_v2_get_my_identity()
returns table (
  identity_id uuid,
  user_id uuid,
  status text,
  plan_key text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_multi_user_enabled();

  return query
  select i.id, i.user_id, i.status, i.plan_key, i.created_at, i.updated_at
  from david_v2.identities i
  where i.user_id = v_user_id;
end;
$$;

create or replace function public.david_v2_set_my_consent(
  p_twin_id uuid,
  p_consent_key text,
  p_consent_version text,
  p_granted boolean,
  p_scopes jsonb default '[]'::jsonb
)
returns table (
  consent_id uuid,
  twin_id uuid,
  consent_key text,
  consent_version text,
  granted boolean,
  scopes jsonb,
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
  v_identity_id uuid;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_multi_user_enabled();
  v_identity_id := david_v2.require_owned_identity(v_user_id);
  perform david_v2.assert_twin_owner(v_user_id, p_twin_id);

  if p_consent_key is null or char_length(btrim(p_consent_key)) not between 1 and 80 then
    raise exception 'Invalid DAVID v2 consent key'
      using errcode = '22023';
  end if;

  if p_consent_version is null or char_length(btrim(p_consent_version)) not between 1 and 40 then
    raise exception 'Invalid DAVID v2 consent version'
      using errcode = '22023';
  end if;

  if p_scopes is null or jsonb_typeof(p_scopes) <> 'array' then
    raise exception 'DAVID v2 consent scopes must be a JSON array'
      using errcode = '22023';
  end if;

  return query
  insert into david_v2.user_consents (
    identity_id,
    user_id,
    twin_id,
    consent_key,
    consent_version,
    granted,
    scopes,
    source,
    accepted_at,
    withdrawn_at
  )
  values (
    v_identity_id,
    v_user_id,
    p_twin_id,
    btrim(p_consent_key),
    btrim(p_consent_version),
    p_granted,
    p_scopes,
    'user',
    case when p_granted then now() else null end,
    case when p_granted then null else now() end
  )
  on conflict (user_id, twin_id, consent_key, consent_version)
  do update set
    identity_id = excluded.identity_id,
    granted = excluded.granted,
    scopes = excluded.scopes,
    source = 'user',
    accepted_at = case when excluded.granted then now() else null end,
    withdrawn_at = case when excluded.granted then null else now() end
  returning
    id,
    user_consents.twin_id,
    user_consents.consent_key,
    user_consents.consent_version,
    user_consents.granted,
    user_consents.scopes,
    user_consents.accepted_at,
    user_consents.withdrawn_at,
    user_consents.updated_at;
end;
$$;

create or replace function public.david_v2_list_my_consents(
  p_twin_id uuid default null
)
returns table (
  consent_id uuid,
  twin_id uuid,
  consent_key text,
  consent_version text,
  granted boolean,
  scopes jsonb,
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_multi_user_enabled();

  if p_twin_id is not null then
    perform david_v2.assert_twin_owner(v_user_id, p_twin_id);
  end if;

  return query
  select
    c.id,
    c.twin_id,
    c.consent_key,
    c.consent_version,
    c.granted,
    c.scopes,
    c.accepted_at,
    c.withdrawn_at,
    c.updated_at
  from david_v2.user_consents c
  where c.user_id = v_user_id
    and (p_twin_id is null or c.twin_id = p_twin_id)
  order by c.updated_at desc;
end;
$$;

create or replace function public.david_v2_register_my_local_conversation(
  p_twin_id uuid,
  p_model_key text default 'local'
)
returns table (
  conversation_id uuid,
  identity_id uuid,
  twin_id uuid,
  provider text,
  model_key text,
  status text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
  v_identity_id uuid;
  v_model_key text;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_multi_user_enabled();
  v_identity_id := david_v2.require_owned_identity(v_user_id);
  perform david_v2.assert_twin_owner(v_user_id, p_twin_id);

  v_model_key := coalesce(nullif(btrim(p_model_key), ''), 'local');
  if char_length(v_model_key) > 120 then
    raise exception 'DAVID v2 model key is too long'
      using errcode = '22023';
  end if;

  return query
  insert into david_v2.conversations (
    identity_id,
    user_id,
    twin_id,
    provider,
    model_key,
    status
  )
  values (
    v_identity_id,
    v_user_id,
    p_twin_id,
    'local',
    v_model_key,
    'provisioning'
  )
  on conflict (user_id, twin_id, provider)
  do update set
    identity_id = excluded.identity_id,
    model_key = coalesce(david_v2.conversations.model_key, excluded.model_key)
  returning
    id,
    conversations.identity_id,
    conversations.twin_id,
    conversations.provider,
    conversations.model_key,
    conversations.status,
    conversations.created_at,
    conversations.updated_at;
end;
$$;

create or replace function public.david_v2_list_my_conversations()
returns table (
  conversation_id uuid,
  twin_id uuid,
  provider text,
  model_key text,
  status text,
  last_error text,
  created_at timestamptz,
  updated_at timestamptz,
  last_used_at timestamptz
)
language plpgsql
security definer
stable
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_multi_user_enabled();

  return query
  select
    c.id,
    c.twin_id,
    c.provider,
    c.model_key,
    c.status,
    c.last_error,
    c.created_at,
    c.updated_at,
    c.last_used_at
  from david_v2.conversations c
  where c.user_id = v_user_id
  order by c.updated_at desc;
end;
$$;

create or replace function public.david_v2_create_my_thread(
  p_conversation_id uuid,
  p_title text default 'Разговор с DAVID',
  p_client_thread_key text default null
)
returns table (
  thread_id uuid,
  conversation_id uuid,
  twin_id uuid,
  title text,
  status text,
  client_thread_key text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
  v_identity_id uuid;
  v_twin_id uuid;
  v_conversation_status text;
  v_title text;
  v_client_key text;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_multi_user_enabled();

  select o.identity_id, o.twin_id, o.status
    into v_identity_id, v_twin_id, v_conversation_status
  from david_v2.require_owned_conversation(v_user_id, p_conversation_id) o;

  if v_conversation_status in ('archived', 'error') then
    raise exception 'DAVID v2 thread cannot be created for this conversation state'
      using errcode = '55000';
  end if;

  v_title := coalesce(nullif(btrim(p_title), ''), 'Разговор с DAVID');
  if char_length(v_title) > 120 then
    raise exception 'DAVID v2 thread title is too long'
      using errcode = '22023';
  end if;

  v_client_key := nullif(btrim(p_client_thread_key), '');
  if v_client_key is not null and char_length(v_client_key) > 160 then
    raise exception 'DAVID v2 client thread key is too long'
      using errcode = '22023';
  end if;

  if v_client_key is not null then
    return query
    insert into david_v2.soul_threads (
      identity_id,
      user_id,
      twin_id,
      conversation_id,
      title,
      client_thread_key,
      status
    )
    values (
      v_identity_id,
      v_user_id,
      v_twin_id,
      p_conversation_id,
      v_title,
      v_client_key,
      'active'
    )
    on conflict (user_id, client_thread_key)
      where client_thread_key is not null
    do update set
      title = excluded.title
    returning
      id,
      soul_threads.conversation_id,
      soul_threads.twin_id,
      soul_threads.title,
      soul_threads.status,
      soul_threads.client_thread_key,
      soul_threads.created_at,
      soul_threads.updated_at;
  else
    return query
    insert into david_v2.soul_threads (
      identity_id,
      user_id,
      twin_id,
      conversation_id,
      title,
      status
    )
    values (
      v_identity_id,
      v_user_id,
      v_twin_id,
      p_conversation_id,
      v_title,
      'active'
    )
    returning
      id,
      soul_threads.conversation_id,
      soul_threads.twin_id,
      soul_threads.title,
      soul_threads.status,
      soul_threads.client_thread_key,
      soul_threads.created_at,
      soul_threads.updated_at;
  end if;
end;
$$;

create or replace function public.david_v2_list_my_threads()
returns table (
  thread_id uuid,
  conversation_id uuid,
  twin_id uuid,
  title text,
  status text,
  client_thread_key text,
  created_at timestamptz,
  updated_at timestamptz,
  archived_at timestamptz
)
language plpgsql
security definer
stable
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_multi_user_enabled();

  return query
  select
    t.id,
    t.conversation_id,
    t.twin_id,
    t.title,
    t.status,
    t.client_thread_key,
    t.created_at,
    t.updated_at,
    t.archived_at
  from david_v2.soul_threads t
  where t.user_id = v_user_id
  order by t.updated_at desc;
end;
$$;

-- Defense in depth: even if a future migration accidentally grants table SELECT,
-- authenticated users can still see only their own records.
create policy david_v2_identities_owner_select
  on david_v2.identities
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy david_v2_conversations_owner_select
  on david_v2.conversations
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy david_v2_consents_owner_select
  on david_v2.user_consents
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy david_v2_threads_owner_select
  on david_v2.soul_threads
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- No direct table privileges are granted. Only the controlled RPCs are executable.
revoke all on function public.david_v2_provision_my_identity() from public, anon;
revoke all on function public.david_v2_get_my_identity() from public, anon;
revoke all on function public.david_v2_set_my_consent(uuid, text, text, boolean, jsonb) from public, anon;
revoke all on function public.david_v2_list_my_consents(uuid) from public, anon;
revoke all on function public.david_v2_register_my_local_conversation(uuid, text) from public, anon;
revoke all on function public.david_v2_list_my_conversations() from public, anon;
revoke all on function public.david_v2_create_my_thread(uuid, text, text) from public, anon;
revoke all on function public.david_v2_list_my_threads() from public, anon;

grant execute on function public.david_v2_provision_my_identity() to authenticated, service_role;
grant execute on function public.david_v2_get_my_identity() to authenticated, service_role;
grant execute on function public.david_v2_set_my_consent(uuid, text, text, boolean, jsonb) to authenticated, service_role;
grant execute on function public.david_v2_list_my_consents(uuid) to authenticated, service_role;
grant execute on function public.david_v2_register_my_local_conversation(uuid, text) to authenticated, service_role;
grant execute on function public.david_v2_list_my_conversations() to authenticated, service_role;
grant execute on function public.david_v2_create_my_thread(uuid, text, text) to authenticated, service_role;
grant execute on function public.david_v2_list_my_threads() to authenticated, service_role;

revoke all on function david_v2.require_authenticated_user() from public, anon, authenticated;
revoke all on function david_v2.require_multi_user_enabled() from public, anon, authenticated;
revoke all on function david_v2.assert_twin_owner(uuid, uuid) from public, anon, authenticated;
revoke all on function david_v2.require_owned_identity(uuid) from public, anon, authenticated;
revoke all on function david_v2.require_owned_conversation(uuid, uuid) from public, anon, authenticated;

grant execute on function david_v2.require_authenticated_user() to service_role;
grant execute on function david_v2.require_multi_user_enabled() to service_role;
grant execute on function david_v2.assert_twin_owner(uuid, uuid) to service_role;
grant execute on function david_v2.require_owned_identity(uuid) to service_role;
grant execute on function david_v2.require_owned_conversation(uuid, uuid) to service_role;

update david_v2.system_config
set
  schema_version = 'david-v2-stage3-1',
  metadata = metadata || jsonb_build_object(
    'stage', 3,
    'state', 'ownership_rpc_installed_disabled',
    'stage3_base_branch', 'stable/david-multi-user-v2-stage2',
    'stage3_base_commit', '66630b824b3678354f98ba5fdfdc6381877c4e87',
    'ownership_rpc_count', 8,
    'direct_client_table_access', false
  )
where id = 1
  and multi_user_enabled = false
  and provider_enabled = false
  and electron_routing_enabled = false
  and rollout_limit = 0;

comment on function public.david_v2_provision_my_identity() is
  'Idempotently provisions only auth.uid() and enforces the configured rollout limit.';
comment on function public.david_v2_set_my_consent(uuid, text, text, boolean, jsonb) is
  'Writes consent only for auth.uid() and a Twin owned by that authenticated user.';
comment on function public.david_v2_register_my_local_conversation(uuid, text) is
  'Registers an idempotent local conversation only for auth.uid() and their Twin.';
comment on function public.david_v2_create_my_thread(uuid, text, text) is
  'Creates a thread only inside a conversation owned by auth.uid().';

commit;
