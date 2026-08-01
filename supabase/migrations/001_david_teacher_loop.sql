begin;

create extension if not exists pgcrypto;

create table if not exists public.devices (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  platform text not null,
  app_version text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.training_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  command_text text not null check (char_length(command_text) between 1 and 2000),
  context jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'planning', 'planned', 'testing', 'success', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.skills (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  skill_key text not null,
  title text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, skill_key)
);

create table if not exists public.skill_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  skill_id uuid not null references public.skills(id) on delete cascade,
  version integer not null check (version > 0),
  status text not null default 'candidate'
    check (status in ('candidate', 'local_verified', 'approved', 'rejected')),
  risk_level text not null
    check (risk_level in ('low', 'medium', 'high')),
  definition jsonb not null,
  teacher_model text,
  created_at timestamptz not null default now(),
  unique (skill_id, version)
);

create table if not exists public.training_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  request_id uuid not null references public.training_requests(id) on delete cascade,
  skill_version_id uuid not null references public.skill_versions(id) on delete cascade,
  command_text text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'running', 'success', 'failed', 'cancelled')),
  result jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.training_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  request_id uuid references public.training_requests(id) on delete set null,
  job_id uuid references public.training_jobs(id) on delete set null,
  skill_version_id uuid references public.skill_versions(id) on delete set null,
  command_text text not null default '',
  status text not null check (status in ('success', 'failed')),
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists devices_owner_idx
  on public.devices(owner_id);

create index if not exists training_requests_owner_status_idx
  on public.training_requests(owner_id, status, created_at desc);

create index if not exists skill_versions_owner_status_idx
  on public.skill_versions(owner_id, status, created_at desc);

create index if not exists training_jobs_device_status_idx
  on public.training_jobs(device_id, status, created_at desc);

create index if not exists training_runs_owner_created_idx
  on public.training_runs(owner_id, created_at desc);

alter table public.devices enable row level security;
alter table public.training_requests enable row level security;
alter table public.skills enable row level security;
alter table public.skill_versions enable row level security;
alter table public.training_jobs enable row level security;
alter table public.training_runs enable row level security;

drop policy if exists devices_owner_all on public.devices;
create policy devices_owner_all
on public.devices
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists training_requests_owner_all on public.training_requests;
create policy training_requests_owner_all
on public.training_requests
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists skills_owner_all on public.skills;
create policy skills_owner_all
on public.skills
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists skill_versions_owner_all on public.skill_versions;
create policy skill_versions_owner_all
on public.skill_versions
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists training_jobs_owner_all on public.training_jobs;
create policy training_jobs_owner_all
on public.training_jobs
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists training_runs_owner_all on public.training_runs;
create policy training_runs_owner_all
on public.training_runs
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

grant select, insert, update, delete
on public.devices,
   public.training_requests,
   public.skills,
   public.skill_versions,
   public.training_jobs,
   public.training_runs
to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.training_jobs;
exception
  when duplicate_object then null;
end $$;

commit;
