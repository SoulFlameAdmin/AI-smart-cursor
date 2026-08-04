begin;

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
  insert into david_v2.user_consents as uc (
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
  on conflict on constraint user_consents_version_unique
  do update set
    identity_id = excluded.identity_id,
    granted = excluded.granted,
    scopes = excluded.scopes,
    source = 'user',
    accepted_at = case when excluded.granted then now() else null end,
    withdrawn_at = case when excluded.granted then null else now() end
  returning
    uc.id,
    uc.twin_id,
    uc.consent_key,
    uc.consent_version,
    uc.granted,
    uc.scopes,
    uc.accepted_at,
    uc.withdrawn_at,
    uc.updated_at;
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
  insert into david_v2.conversations as c (
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
  on conflict on constraint conversations_user_twin_provider_unique
  do update set
    identity_id = excluded.identity_id,
    model_key = coalesce(c.model_key, excluded.model_key)
  returning
    c.id,
    c.identity_id,
    c.twin_id,
    c.provider,
    c.model_key,
    c.status,
    c.created_at,
    c.updated_at;
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
    update david_v2.soul_threads as st
    set title = v_title
    where st.user_id = v_user_id
      and st.client_thread_key = v_client_key
    returning
      st.id,
      st.conversation_id,
      st.twin_id,
      st.title,
      st.status,
      st.client_thread_key,
      st.created_at,
      st.updated_at;

    if found then
      return;
    end if;
  end if;

  return query
  insert into david_v2.soul_threads as st (
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
  returning
    st.id,
    st.conversation_id,
    st.twin_id,
    st.title,
    st.status,
    st.client_thread_key,
    st.created_at,
    st.updated_at;
end;
$$;

revoke all on function public.david_v2_set_my_consent(uuid, text, text, boolean, jsonb) from public, anon;
revoke all on function public.david_v2_register_my_local_conversation(uuid, text) from public, anon;
revoke all on function public.david_v2_create_my_thread(uuid, text, text) from public, anon;

grant execute on function public.david_v2_set_my_consent(uuid, text, text, boolean, jsonb) to authenticated, service_role;
grant execute on function public.david_v2_register_my_local_conversation(uuid, text) to authenticated, service_role;
grant execute on function public.david_v2_create_my_thread(uuid, text, text) to authenticated, service_role;

update david_v2.system_config
set metadata = metadata || jsonb_build_object(
  'stage3_ambiguity_fix', true,
  'stage3_ambiguity_fix_reason', 'named constraints and explicit thread idempotency'
)
where id = 1
  and multi_user_enabled = false
  and provider_enabled = false
  and electron_routing_enabled = false
  and rollout_limit = 0;

commit;
