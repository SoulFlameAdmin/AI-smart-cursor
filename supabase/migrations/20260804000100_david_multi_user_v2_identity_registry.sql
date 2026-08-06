begin;

create schema if not exists david_v2;

revoke all on schema david_v2 from public, anon, authenticated;
grant usage on schema david_v2 to service_role;

create table david_v2.system_config (
  id smallint primary key default 1 check (id = 1),
  schema_version text not null check (char_length(schema_version) between 1 and 80),
  multi_user_enabled boolean not null default false,
  provider_enabled boolean not null default false,
  electron_routing_enabled boolean not null default false,
  rollout_limit integer not null default 0 check (rollout_limit between 0 and 1000000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table david_v2.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  plan_key text not null default 'free' check (char_length(plan_key) between 1 and 40),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint identities_id_user_unique unique (id, user_id)
);

create table david_v2.conversations (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  twin_id uuid not null references public.sf_twin_profiles(id) on delete cascade,
  provider text not null default 'local' check (provider in ('local', 'openai', 'azure_openai', 'anthropic', 'other')),
  provider_conversation_id text,
  model_key text,
  status text not null default 'provisioning' check (status in ('provisioning', 'active', 'paused', 'archived', 'error')),
  last_error text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint conversations_identity_owner_fk
    foreign key (identity_id, user_id)
    references david_v2.identities(id, user_id)
    on delete cascade,
  constraint conversations_user_twin_provider_unique unique (user_id, twin_id, provider),
  constraint conversations_full_identity_unique unique (id, identity_id, user_id, twin_id),
  constraint conversations_provider_id_length check (
    provider_conversation_id is null or char_length(provider_conversation_id) between 1 and 512
  )
);

create unique index david_v2_conversations_provider_external_unique
  on david_v2.conversations(provider, provider_conversation_id)
  where provider_conversation_id is not null;

create index david_v2_conversations_owner_status_idx
  on david_v2.conversations(user_id, status, updated_at desc);

create table david_v2.user_consents (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  twin_id uuid not null references public.sf_twin_profiles(id) on delete cascade,
  consent_key text not null check (char_length(consent_key) between 1 and 80),
  consent_version text not null check (char_length(consent_version) between 1 and 40),
  granted boolean not null default false,
  scopes jsonb not null default '[]'::jsonb check (jsonb_typeof(scopes) = 'array'),
  source text not null default 'user' check (source in ('user', 'migration', 'admin')),
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_consents_identity_owner_fk
    foreign key (identity_id, user_id)
    references david_v2.identities(id, user_id)
    on delete cascade,
  constraint user_consents_version_unique unique (user_id, twin_id, consent_key, consent_version),
  constraint user_consents_time_state check (
    (granted and accepted_at is not null and withdrawn_at is null)
    or
    (not granted)
  )
);

create index david_v2_user_consents_owner_idx
  on david_v2.user_consents(user_id, twin_id, granted, updated_at desc);

create table david_v2.soul_threads (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  twin_id uuid not null references public.sf_twin_profiles(id) on delete cascade,
  conversation_id uuid not null,
  source_thread_id uuid references public.sf_soul_threads(id) on delete set null,
  title text not null default 'Разговор с DAVID' check (char_length(title) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'archived', 'deleted')),
  client_thread_key text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint soul_threads_conversation_owner_fk
    foreign key (conversation_id, identity_id, user_id, twin_id)
    references david_v2.conversations(id, identity_id, user_id, twin_id)
    on delete cascade,
  constraint soul_threads_client_key_length check (
    client_thread_key is null or char_length(client_thread_key) between 1 and 160
  )
);

create unique index david_v2_soul_threads_source_unique
  on david_v2.soul_threads(user_id, source_thread_id)
  where source_thread_id is not null;

create unique index david_v2_soul_threads_client_key_unique
  on david_v2.soul_threads(user_id, client_thread_key)
  where client_thread_key is not null;

create index david_v2_soul_threads_owner_idx
  on david_v2.soul_threads(user_id, twin_id, status, updated_at desc);

create or replace function david_v2.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function david_v2.enforce_twin_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.sf_twin_profiles t
    where t.id = new.twin_id
      and t.owner_id = new.user_id
  ) then
    raise exception 'DAVID v2 Twin does not belong to the selected user'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger david_v2_system_config_touch_updated_at
before update on david_v2.system_config
for each row execute function david_v2.touch_updated_at();

create trigger david_v2_identities_touch_updated_at
before update on david_v2.identities
for each row execute function david_v2.touch_updated_at();

create trigger david_v2_conversations_touch_updated_at
before update on david_v2.conversations
for each row execute function david_v2.touch_updated_at();

create trigger david_v2_consents_touch_updated_at
before update on david_v2.user_consents
for each row execute function david_v2.touch_updated_at();

create trigger david_v2_threads_touch_updated_at
before update on david_v2.soul_threads
for each row execute function david_v2.touch_updated_at();

create trigger david_v2_conversations_twin_owner
before insert or update of user_id, twin_id on david_v2.conversations
for each row execute function david_v2.enforce_twin_owner();

create trigger david_v2_consents_twin_owner
before insert or update of user_id, twin_id on david_v2.user_consents
for each row execute function david_v2.enforce_twin_owner();

create trigger david_v2_threads_twin_owner
before insert or update of user_id, twin_id on david_v2.soul_threads
for each row execute function david_v2.enforce_twin_owner();

alter table david_v2.system_config enable row level security;
alter table david_v2.system_config force row level security;
alter table david_v2.identities enable row level security;
alter table david_v2.identities force row level security;
alter table david_v2.conversations enable row level security;
alter table david_v2.conversations force row level security;
alter table david_v2.user_consents enable row level security;
alter table david_v2.user_consents force row level security;
alter table david_v2.soul_threads enable row level security;
alter table david_v2.soul_threads force row level security;

revoke all on all tables in schema david_v2 from public, anon, authenticated;
revoke all on all functions in schema david_v2 from public, anon, authenticated;

grant select, insert, update, delete on all tables in schema david_v2 to service_role;
grant execute on all functions in schema david_v2 to service_role;

alter default privileges in schema david_v2
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema david_v2
  revoke execute on functions from public, anon, authenticated;
alter default privileges in schema david_v2
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema david_v2
  grant execute on functions to service_role;

insert into david_v2.system_config (
  id,
  schema_version,
  multi_user_enabled,
  provider_enabled,
  electron_routing_enabled,
  rollout_limit,
  metadata
)
values (
  1,
  'david-v2-stage2-1',
  false,
  false,
  false,
  0,
  jsonb_build_object(
    'stage', 2,
    'state', 'installed_disabled',
    'base_release', 'stable/david-soul-chat-v1.0.1',
    'base_commit', '128a61af7243ef63749a0eaddcdb1a528b2ebadd'
  )
);

comment on schema david_v2 is
  'Private DAVID Multi-User v2 registry. Direct anon/authenticated access is intentionally denied.';
comment on table david_v2.identities is
  'One isolated DAVID v2 identity for one authenticated SoulFlame user.';
comment on table david_v2.conversations is
  'One isolated provider conversation per authenticated user, Twin and provider.';
comment on table david_v2.user_consents is
  'Versioned, Twin-scoped DAVID consent records owned by one authenticated user.';
comment on table david_v2.soul_threads is
  'DAVID v2 thread registry bound atomically to one identity, user, Twin and provider conversation.';
comment on table david_v2.system_config is
  'Singleton DAVID v2 feature lock. All runtime flags remain disabled at Stage 2.';

commit;
