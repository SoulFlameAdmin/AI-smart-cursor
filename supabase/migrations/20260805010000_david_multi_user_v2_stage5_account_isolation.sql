begin;

alter table david_v2.system_config
  add column if not exists provider_router_enabled boolean not null default false;

alter table david_v2.soul_threads
  add constraint soul_threads_full_identity_unique
  unique (id, conversation_id, identity_id, user_id, twin_id);

create table david_v2.user_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  identity_id uuid not null,
  daily_request_limit integer not null default 50 check (daily_request_limit between 0 and 100000),
  daily_token_limit integer not null default 200000 check (daily_token_limit between 0 and 1000000000),
  max_active_runs integer not null default 2 check (max_active_runs between 0 and 100),
  provider_allowlist jsonb not null default '["mock"]'::jsonb check (jsonb_typeof(provider_allowlist) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_limits_identity_owner_fk
    foreign key (identity_id, user_id)
    references david_v2.identities(id, user_id)
    on delete cascade
);

create table david_v2.provider_runs (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  twin_id uuid not null references public.sf_twin_profiles(id) on delete cascade,
  conversation_id uuid not null,
  thread_id uuid not null,
  client_message_key text not null check (char_length(client_message_key) between 8 and 160),
  request_text text not null check (char_length(request_text) between 1 and 32768),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress_stage text not null default 'received' check (progress_stage in (
    'received',
    'queued',
    'provider_connecting',
    'provider_thinking',
    'reading_answer',
    'returning_answer',
    'completed',
    'failed',
    'cancelled'
  )),
  progress_message text check (progress_message is null or char_length(progress_message) between 1 and 1000),
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) between 1 and 512),
  answer_text text check (answer_text is null or char_length(answer_text) between 1 and 65536),
  error_code text check (error_code is null or char_length(error_code) between 1 and 120),
  worker_key text check (worker_key is null or char_length(worker_key) between 1 and 120),
  input_tokens integer not null default 0 check (input_tokens between 0 and 100000000),
  output_tokens integer not null default 0 check (output_tokens between 0 and 100000000),
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  lease_until timestamptz,
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_runs_conversation_owner_fk
    foreign key (conversation_id, identity_id, user_id, twin_id)
    references david_v2.conversations(id, identity_id, user_id, twin_id)
    on delete cascade,
  constraint provider_runs_thread_owner_fk
    foreign key (thread_id, conversation_id, identity_id, user_id, twin_id)
    references david_v2.soul_threads(id, conversation_id, identity_id, user_id, twin_id)
    on delete cascade,
  constraint provider_runs_user_message_unique unique (user_id, client_message_key),
  constraint provider_runs_full_identity_unique unique (
    id, identity_id, user_id, twin_id, conversation_id, thread_id
  ),
  constraint provider_runs_state_check check (
    (
      status = 'queued'
      and claimed_at is null
      and started_at is null
      and completed_at is null
      and answer_text is null
      and error_code is null
      and lease_until is null
    )
    or
    (
      status = 'processing'
      and claimed_at is not null
      and started_at is not null
      and completed_at is null
      and answer_text is null
      and error_code is null
      and lease_until is not null
    )
    or
    (
      status = 'completed'
      and completed_at is not null
      and answer_text is not null
      and error_code is null
      and lease_until is null
    )
    or
    (
      status in ('failed', 'cancelled')
      and completed_at is not null
      and answer_text is null
      and error_code is not null
      and lease_until is null
    )
  )
);

create index david_v2_provider_runs_owner_created_idx
  on david_v2.provider_runs(user_id, created_at desc);

create index david_v2_provider_runs_queue_idx
  on david_v2.provider_runs(status, created_at)
  where status = 'queued';

create index david_v2_provider_runs_lease_idx
  on david_v2.provider_runs(status, lease_until)
  where status = 'processing';

create index david_v2_provider_runs_thread_idx
  on david_v2.provider_runs(thread_id, created_at desc);

create table david_v2.provider_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  identity_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  twin_id uuid not null references public.sf_twin_profiles(id) on delete cascade,
  conversation_id uuid not null,
  thread_id uuid not null,
  sequence integer not null check (sequence between 1 and 10000),
  stage text not null check (stage in (
    'received',
    'queued',
    'provider_connecting',
    'provider_thinking',
    'reading_answer',
    'returning_answer',
    'completed',
    'failed',
    'cancelled'
  )),
  message text not null check (char_length(message) between 1 and 1000),
  details jsonb not null default '{}'::jsonb check (
    jsonb_typeof(details) = 'object'
    and octet_length(details::text) <= 8192
  ),
  created_at timestamptz not null default now(),
  constraint provider_run_events_run_owner_fk
    foreign key (run_id, identity_id, user_id, twin_id, conversation_id, thread_id)
    references david_v2.provider_runs(id, identity_id, user_id, twin_id, conversation_id, thread_id)
    on delete cascade,
  constraint provider_run_events_sequence_unique unique (run_id, sequence)
);

create index david_v2_provider_run_events_owner_idx
  on david_v2.provider_run_events(user_id, run_id, sequence);

create table david_v2.provider_usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  identity_id uuid not null,
  usage_date date not null default current_date,
  provider text not null check (provider in ('mock', 'openai', 'azure_openai', 'anthropic', 'other')),
  model_key text not null check (char_length(model_key) between 1 and 120),
  request_count integer not null default 0 check (request_count between 0 and 1000000),
  input_tokens bigint not null default 0 check (input_tokens between 0 and 1000000000000),
  output_tokens bigint not null default 0 check (output_tokens between 0 and 1000000000000),
  estimated_cost_micros bigint not null default 0 check (estimated_cost_micros between 0 and 1000000000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date, provider, model_key),
  constraint provider_usage_identity_owner_fk
    foreign key (identity_id, user_id)
    references david_v2.identities(id, user_id)
    on delete cascade
);

create table david_v2.device_routes (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_key text not null check (char_length(device_key) between 8 and 160),
  route_type text not null default 'server' check (route_type in ('server', 'electron')),
  status text not null default 'disabled' check (status in ('disabled', 'offline', 'online', 'error')),
  capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(capabilities) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_routes_identity_owner_fk
    foreign key (identity_id, user_id)
    references david_v2.identities(id, user_id)
    on delete cascade,
  constraint device_routes_user_device_unique unique (user_id, device_key)
);

create trigger david_v2_user_limits_touch_updated_at
before update on david_v2.user_limits
for each row execute function david_v2.touch_updated_at();

create trigger david_v2_provider_runs_touch_updated_at
before update on david_v2.provider_runs
for each row execute function david_v2.touch_updated_at();

create trigger david_v2_provider_usage_touch_updated_at
before update on david_v2.provider_usage_daily
for each row execute function david_v2.touch_updated_at();

create trigger david_v2_device_routes_touch_updated_at
before update on david_v2.device_routes
for each row execute function david_v2.touch_updated_at();

alter table david_v2.user_limits enable row level security;
alter table david_v2.user_limits force row level security;
alter table david_v2.provider_runs enable row level security;
alter table david_v2.provider_runs force row level security;
alter table david_v2.provider_run_events enable row level security;
alter table david_v2.provider_run_events force row level security;
alter table david_v2.provider_usage_daily enable row level security;
alter table david_v2.provider_usage_daily force row level security;
alter table david_v2.device_routes enable row level security;
alter table david_v2.device_routes force row level security;

create policy david_v2_user_limits_owner_select
  on david_v2.user_limits for select to authenticated
  using (user_id = (select auth.uid()));

create policy david_v2_provider_runs_owner_select
  on david_v2.provider_runs for select to authenticated
  using (user_id = (select auth.uid()));

create policy david_v2_provider_run_events_owner_select
  on david_v2.provider_run_events for select to authenticated
  using (user_id = (select auth.uid()));

create policy david_v2_provider_usage_owner_select
  on david_v2.provider_usage_daily for select to authenticated
  using (user_id = (select auth.uid()));

create policy david_v2_device_routes_owner_select
  on david_v2.device_routes for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on table david_v2.user_limits from public, anon, authenticated;
revoke all on table david_v2.provider_runs from public, anon, authenticated;
revoke all on table david_v2.provider_run_events from public, anon, authenticated;
revoke all on table david_v2.provider_usage_daily from public, anon, authenticated;
revoke all on table david_v2.device_routes from public, anon, authenticated;

grant select, insert, update, delete on table david_v2.user_limits to service_role;
grant select, insert, update, delete on table david_v2.provider_runs to service_role;
grant select, insert, update, delete on table david_v2.provider_run_events to service_role;
grant select, insert, update, delete on table david_v2.provider_usage_daily to service_role;
grant select, insert, update, delete on table david_v2.device_routes to service_role;

create or replace function david_v2.require_provider_router_enabled()
returns void
language plpgsql
security definer
set search_path = pg_catalog, david_v2
as $$
declare
  v_config david_v2.system_config%rowtype;
begin
  select * into v_config
  from david_v2.system_config
  where id = 1;

  if coalesce(v_config.provider_router_enabled, false) is not true
     or coalesce(v_config.provider_enabled, false) is not true
     or coalesce(v_config.multi_user_enabled, false) is not true
     or coalesce(v_config.gateway_enabled, false) is not true
     or coalesce(v_config.rollout_limit, 0) <= 0 then
    raise exception 'DAVID v2 provider router is disabled'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.david_v2_ensure_my_provider_conversation(
  p_twin_id uuid,
  p_provider text default 'mock',
  p_model_key text default 'mock-david-v1'
)
returns table (
  conversation_id uuid,
  twin_id uuid,
  provider text,
  model_key text,
  conversation_status text,
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
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_model_key text := btrim(coalesce(p_model_key, ''));
  v_row david_v2.conversations%rowtype;
  v_allowlist jsonb;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_provider_router_enabled();
  v_identity_id := david_v2.require_owned_identity(v_user_id);
  perform david_v2.assert_twin_owner(v_user_id, p_twin_id);

  if v_provider not in ('mock', 'openai', 'azure_openai', 'anthropic', 'other') then
    raise exception 'DAVID provider is not allowed' using errcode = '22023';
  end if;
  if char_length(v_model_key) not between 1 and 120 then
    raise exception 'DAVID provider model key is invalid' using errcode = '22023';
  end if;

  insert into david_v2.user_limits (user_id, identity_id)
  values (v_user_id, v_identity_id)
  on conflict (user_id) do nothing;

  select l.provider_allowlist into v_allowlist
  from david_v2.user_limits l
  where l.user_id = v_user_id;

  if not (v_allowlist ? v_provider) then
    raise exception 'DAVID provider is not enabled for this account' using errcode = '42501';
  end if;

  insert into david_v2.conversations (
    identity_id,
    user_id,
    twin_id,
    provider,
    model_key,
    status,
    metadata
  ) values (
    v_identity_id,
    v_user_id,
    p_twin_id,
    v_provider,
    v_model_key,
    'provisioning',
    jsonb_build_object('stage5_account_isolated', true)
  )
  on conflict (user_id, twin_id, provider)
  do update set
    model_key = excluded.model_key,
    updated_at = now()
  returning * into v_row;

  return query select
    v_row.id,
    v_row.twin_id,
    v_row.provider,
    v_row.model_key,
    v_row.status,
    v_row.created_at,
    v_row.updated_at;
end;
$$;

create or replace function public.david_v2_create_my_provider_run(
  p_conversation_id uuid,
  p_thread_id uuid,
  p_client_message_key text,
  p_prompt text
)
returns table (
  run_id uuid,
  run_status text,
  progress_stage text,
  progress_message text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, auth, public, david_v2
as $$
declare
  v_user_id uuid;
  v_identity_id uuid;
  v_twin_id uuid;
  v_provider text;
  v_model_key text;
  v_key text := btrim(coalesce(p_client_message_key, ''));
  v_prompt text := btrim(coalesce(p_prompt, ''));
  v_limit david_v2.user_limits%rowtype;
  v_today_count integer;
  v_active_count integer;
  v_row david_v2.provider_runs%rowtype;
begin
  v_user_id := david_v2.require_authenticated_user();
  perform david_v2.require_provider_router_enabled();

  select o.identity_id, o.twin_id
    into v_identity_id, v_twin_id
  from david_v2.require_owned_conversation(v_user_id, p_conversation_id) o;

  select c.provider, c.model_key
    into v_provider, v_model_key
  from david_v2.conversations c
  where c.id = p_conversation_id
    and c.user_id = v_user_id;

  if not exists (
    select 1 from david_v2.soul_threads t
    where t.id = p_thread_id
      and t.conversation_id = p_conversation_id
      and t.identity_id = v_identity_id
      and t.user_id = v_user_id
      and t.twin_id = v_twin_id
      and t.status = 'active'
  ) then
    raise exception 'DAVID thread does not belong to this account' using errcode = '42501';
  end if;

  if char_length(v_key) not between 8 and 160 then
    raise exception 'DAVID client message key is invalid' using errcode = '22023';
  end if;
  if char_length(v_prompt) not between 1 and 32768 then
    raise exception 'DAVID prompt is invalid' using errcode = '22023';
  end if;

  select * into v_limit
  from david_v2.user_limits l
  where l.user_id = v_user_id;

  if not found then
    raise exception 'DAVID account limits are not provisioned' using errcode = '55000';
  end if;

  select count(*)::integer into v_today_count
  from david_v2.provider_runs r
  where r.user_id = v_user_id
    and r.created_at >= date_trunc('day', now());

  if v_today_count >= v_limit.daily_request_limit then
    raise exception 'DAVID daily request limit reached' using errcode = '54000';
  end if;

  select count(*)::integer into v_active_count
  from david_v2.provider_runs r
  where r.user_id = v_user_id
    and r.status in ('queued', 'processing');

  if v_active_count >= v_limit.max_active_runs then
    raise exception 'DAVID active run limit reached' using errcode = '54000';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text || ':' || v_key));

  select * into v_row
  from david_v2.provider_runs r
  where r.user_id = v_user_id
    and r.client_message_key = v_key;

  if found then
    if v_row.conversation_id <> p_conversation_id
       or v_row.thread_id <> p_thread_id
       or v_row.request_text <> v_prompt then
      raise exception 'DAVID message idempotency key conflict' using errcode = '23505';
    end if;
  else
    insert into david_v2.provider_runs (
      identity_id,
      user_id,
      twin_id,
      conversation_id,
      thread_id,
      client_message_key,
      request_text,
      status,
      progress_stage,
      progress_message
    ) values (
      v_identity_id,
      v_user_id,
      v_twin_id,
      p_conversation_id,
      p_thread_id,
      v_key,
      v_prompt,
      'queued',
      'queued',
      'DAVID прие съобщението и го постави в личната provider опашка.'
    ) returning * into v_row;

    insert into david_v2.provider_run_events (
      run_id,
      identity_id,
      user_id,
      twin_id,
      conversation_id,
      thread_id,
      sequence,
      stage,
      message
    ) values (
      v_row.id,
      v_row.identity_id,
      v_row.user_id,
      v_row.twin_id,
      v_row.conversation_id,
      v_row.thread_id,
      1,
      'queued',
      'DAVID прие съобщението и го постави в личната provider опашка.'
    );
  end if;

  return query select
    v_row.id,
    v_row.status,
    v_row.progress_stage,
    v_row.progress_message,
    v_row.created_at;
end;
$$;

create or replace function public.david_v2_get_my_provider_run(p_run_id uuid)
returns table (
  run_id uuid,
  conversation_id uuid,
  thread_id uuid,
  run_status text,
  progress_stage text,
  progress_message text,
  answer_text text,
  error_code text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
language sql
security definer
stable
set search_path = pg_catalog, auth, david_v2
as $$
  select
    r.id,
    r.conversation_id,
    r.thread_id,
    r.status,
    r.progress_stage,
    r.progress_message,
    r.answer_text,
    r.error_code,
    r.input_tokens,
    r.output_tokens,
    r.created_at,
    r.updated_at,
    r.completed_at
  from david_v2.provider_runs r
  where r.id = p_run_id
    and r.user_id = david_v2.require_authenticated_user();
$$;

create or replace function public.david_v2_list_my_provider_run_events(p_run_id uuid)
returns table (
  sequence integer,
  stage text,
  message text,
  details jsonb,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = pg_catalog, auth, david_v2
as $$
  select e.sequence, e.stage, e.message, e.details, e.created_at
  from david_v2.provider_run_events e
  where e.run_id = p_run_id
    and e.user_id = david_v2.require_authenticated_user()
  order by e.sequence;
$$;

create or replace function david_v2.claim_provider_run(p_worker_key text)
returns table (
  run_id uuid,
  identity_id uuid,
  user_id uuid,
  twin_id uuid,
  conversation_id uuid,
  thread_id uuid,
  provider text,
  model_key text,
  request_text text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, david_v2
as $$
declare
  v_worker text := btrim(coalesce(p_worker_key, ''));
  v_row david_v2.provider_runs%rowtype;
begin
  perform david_v2.require_provider_router_enabled();
  if char_length(v_worker) not between 1 and 120 then
    raise exception 'DAVID provider worker key is invalid' using errcode = '22023';
  end if;

  select r.* into v_row
  from david_v2.provider_runs r
  where r.status = 'queued'
     or (r.status = 'processing' and r.lease_until <= now())
  order by r.created_at
  for update skip locked
  limit 1;

  if not found then return; end if;

  update david_v2.provider_runs r
  set
    status = 'processing',
    progress_stage = 'provider_connecting',
    progress_message = 'DAVID свързва личната provider сесия.',
    worker_key = v_worker,
    claimed_at = coalesce(r.claimed_at, now()),
    started_at = coalesce(r.started_at, now()),
    lease_until = now() + interval '2 minutes',
    attempt_count = r.attempt_count + 1
  where r.id = v_row.id
  returning r.* into v_row;

  insert into david_v2.provider_run_events (
    run_id, identity_id, user_id, twin_id, conversation_id, thread_id,
    sequence, stage, message
  ) values (
    v_row.id, v_row.identity_id, v_row.user_id, v_row.twin_id,
    v_row.conversation_id, v_row.thread_id,
    coalesce((select max(e.sequence) + 1 from david_v2.provider_run_events e where e.run_id = v_row.id), 1),
    'provider_connecting',
    'DAVID свързва личната provider сесия.'
  );

  return query
  select
    v_row.id,
    v_row.identity_id,
    v_row.user_id,
    v_row.twin_id,
    v_row.conversation_id,
    v_row.thread_id,
    c.provider,
    c.model_key,
    v_row.request_text,
    v_row.attempt_count
  from david_v2.conversations c
  where c.id = v_row.conversation_id;
end;
$$;

create or replace function david_v2.append_provider_run_event(
  p_run_id uuid,
  p_stage text,
  p_message text,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, david_v2
as $$
declare
  v_row david_v2.provider_runs%rowtype;
  v_sequence integer;
  v_stage text := btrim(coalesce(p_stage, ''));
  v_message text := btrim(coalesce(p_message, ''));
begin
  select * into v_row from david_v2.provider_runs where id = p_run_id for update;
  if not found then raise exception 'DAVID provider run was not found' using errcode = 'P0002'; end if;
  if v_row.status <> 'processing' then raise exception 'DAVID provider run is not processing' using errcode = '55000'; end if;
  if v_stage not in ('provider_connecting', 'provider_thinking', 'reading_answer', 'returning_answer') then
    raise exception 'DAVID provider progress stage is invalid' using errcode = '22023';
  end if;
  if char_length(v_message) not between 1 and 1000 then
    raise exception 'DAVID provider progress message is invalid' using errcode = '22023';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' or octet_length(p_details::text) > 8192 then
    raise exception 'DAVID provider progress details are invalid' using errcode = '22023';
  end if;

  select coalesce(max(sequence), 0) + 1 into v_sequence
  from david_v2.provider_run_events where run_id = p_run_id;

  update david_v2.provider_runs
  set progress_stage = v_stage,
      progress_message = v_message,
      lease_until = now() + interval '2 minutes'
  where id = p_run_id;

  insert into david_v2.provider_run_events (
    run_id, identity_id, user_id, twin_id, conversation_id, thread_id,
    sequence, stage, message, details
  ) values (
    v_row.id, v_row.identity_id, v_row.user_id, v_row.twin_id,
    v_row.conversation_id, v_row.thread_id,
    v_sequence, v_stage, v_message, p_details
  );
end;
$$;

create or replace function david_v2.complete_provider_run(
  p_run_id uuid,
  p_answer text,
  p_provider_request_id text default null,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, david_v2
as $$
declare
  v_row david_v2.provider_runs%rowtype;
  v_answer text := btrim(coalesce(p_answer, ''));
  v_sequence integer;
  v_provider text;
  v_model_key text;
begin
  select * into v_row from david_v2.provider_runs where id = p_run_id for update;
  if not found then raise exception 'DAVID provider run was not found' using errcode = 'P0002'; end if;
  if v_row.status <> 'processing' then raise exception 'DAVID provider run is not processing' using errcode = '55000'; end if;
  if char_length(v_answer) not between 1 and 65536 then
    raise exception 'DAVID provider answer is invalid' using errcode = '22023';
  end if;

  select c.provider, c.model_key into v_provider, v_model_key
  from david_v2.conversations c where c.id = v_row.conversation_id;

  update david_v2.provider_runs
  set status = 'completed',
      progress_stage = 'completed',
      progress_message = 'Отговорът е върнат в личния Soul чат.',
      provider_request_id = nullif(btrim(coalesce(p_provider_request_id, '')), ''),
      answer_text = v_answer,
      error_code = null,
      input_tokens = greatest(coalesce(p_input_tokens, 0), 0),
      output_tokens = greatest(coalesce(p_output_tokens, 0), 0),
      lease_until = null,
      completed_at = now()
  where id = p_run_id;

  select coalesce(max(sequence), 0) + 1 into v_sequence
  from david_v2.provider_run_events where run_id = p_run_id;

  insert into david_v2.provider_run_events (
    run_id, identity_id, user_id, twin_id, conversation_id, thread_id,
    sequence, stage, message
  ) values (
    v_row.id, v_row.identity_id, v_row.user_id, v_row.twin_id,
    v_row.conversation_id, v_row.thread_id,
    v_sequence, 'completed', 'Отговорът е върнат в личния Soul чат.'
  );

  insert into david_v2.provider_usage_daily (
    user_id, identity_id, usage_date, provider, model_key,
    request_count, input_tokens, output_tokens
  ) values (
    v_row.user_id, v_row.identity_id, current_date, v_provider, coalesce(v_model_key, 'unknown'),
    1, greatest(coalesce(p_input_tokens, 0), 0), greatest(coalesce(p_output_tokens, 0), 0)
  )
  on conflict (user_id, usage_date, provider, model_key)
  do update set
    request_count = david_v2.provider_usage_daily.request_count + 1,
    input_tokens = david_v2.provider_usage_daily.input_tokens + excluded.input_tokens,
    output_tokens = david_v2.provider_usage_daily.output_tokens + excluded.output_tokens,
    updated_at = now();
end;
$$;

create or replace function david_v2.fail_provider_run(
  p_run_id uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, david_v2
as $$
declare
  v_row david_v2.provider_runs%rowtype;
  v_error text := btrim(coalesce(p_error_code, ''));
  v_sequence integer;
begin
  select * into v_row from david_v2.provider_runs where id = p_run_id for update;
  if not found then raise exception 'DAVID provider run was not found' using errcode = 'P0002'; end if;
  if v_row.status not in ('queued', 'processing') then raise exception 'DAVID provider run is already terminal' using errcode = '55000'; end if;
  if char_length(v_error) not between 1 and 120 then
    raise exception 'DAVID provider error code is invalid' using errcode = '22023';
  end if;

  update david_v2.provider_runs
  set status = 'failed',
      progress_stage = 'failed',
      progress_message = 'DAVID не успя да завърши този чат ход.',
      answer_text = null,
      error_code = v_error,
      lease_until = null,
      completed_at = now()
  where id = p_run_id;

  select coalesce(max(sequence), 0) + 1 into v_sequence
  from david_v2.provider_run_events where run_id = p_run_id;

  insert into david_v2.provider_run_events (
    run_id, identity_id, user_id, twin_id, conversation_id, thread_id,
    sequence, stage, message, details
  ) values (
    v_row.id, v_row.identity_id, v_row.user_id, v_row.twin_id,
    v_row.conversation_id, v_row.thread_id,
    v_sequence, 'failed', 'DAVID не успя да завърши този чат ход.',
    jsonb_build_object('error_code', v_error)
  );
end;
$$;

revoke all on function public.david_v2_ensure_my_provider_conversation(uuid, text, text) from public, anon;
revoke all on function public.david_v2_create_my_provider_run(uuid, uuid, text, text) from public, anon;
revoke all on function public.david_v2_get_my_provider_run(uuid) from public, anon;
revoke all on function public.david_v2_list_my_provider_run_events(uuid) from public, anon;

grant execute on function public.david_v2_ensure_my_provider_conversation(uuid, text, text) to authenticated, service_role;
grant execute on function public.david_v2_create_my_provider_run(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function public.david_v2_get_my_provider_run(uuid) to authenticated, service_role;
grant execute on function public.david_v2_list_my_provider_run_events(uuid) to authenticated, service_role;

revoke all on function david_v2.require_provider_router_enabled() from public, anon, authenticated;
revoke all on function david_v2.claim_provider_run(text) from public, anon, authenticated;
revoke all on function david_v2.append_provider_run_event(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function david_v2.complete_provider_run(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function david_v2.fail_provider_run(uuid, text) from public, anon, authenticated;

grant execute on function david_v2.require_provider_router_enabled() to service_role;
grant execute on function david_v2.claim_provider_run(text) to service_role;
grant execute on function david_v2.append_provider_run_event(uuid, text, text, jsonb) to service_role;
grant execute on function david_v2.complete_provider_run(uuid, text, text, integer, integer) to service_role;
grant execute on function david_v2.fail_provider_run(uuid, text) to service_role;

update david_v2.system_config
set
  schema_version = 'david-v2-stage5-1',
  provider_router_enabled = false,
  metadata = metadata || jsonb_build_object(
    'stage', 5,
    'state', 'account_isolation_schema_prepared_disabled',
    'stage5_base_branch', 'feature/david-multi-user-v2-stage4-api-gateway',
    'stage5_base_commit', 'd69f4fef3e05657d4b23d9df25c330c6fbeb446d',
    'auth_identity_key', 'auth.uid',
    'gmail_is_login_not_primary_key', true,
    'provider_conversation_per_user_twin', true,
    'provider_run_progress_events', true,
    'provider_keys_server_only', true,
    'private_chat_urls_stored', false,
    'provider_calls_enabled', false
  )
where id = 1
  and multi_user_enabled = false
  and provider_enabled = false
  and gateway_enabled = false
  and electron_routing_enabled = false
  and rollout_limit = 0;

comment on table david_v2.user_limits is
  'Per-auth.uid DAVID limits. Gmail is only the login provider; auth.users.id is the isolation key.';
comment on table david_v2.provider_runs is
  'One owner-scoped provider message run bound to exactly one identity, Twin, conversation and SOUL thread.';
comment on table david_v2.provider_run_events is
  'Ordered progress events for showing received, connecting, thinking, reading and completed states per user run.';
comment on table david_v2.provider_usage_daily is
  'Owner-scoped provider usage counters for plan and cost control.';
comment on table david_v2.device_routes is
  'Optional per-account server or Electron route. Electron routing remains disabled by default.';
comment on function public.david_v2_ensure_my_provider_conversation(uuid, text, text) is
  'Creates or reuses exactly one provider conversation for auth.uid(), Twin and provider.';
comment on function public.david_v2_create_my_provider_run(uuid, uuid, text, text) is
  'Creates one idempotent provider run owned by auth.uid() with account limits and thread ownership checks.';

commit;
