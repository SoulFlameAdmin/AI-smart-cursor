begin;

do $$
declare
  v_config david_v2.system_config%rowtype;
  v_rows bigint;
begin
  select * into v_config from david_v2.system_config where id = 1;

  if coalesce(v_config.provider_router_enabled, false)
     or coalesce(v_config.provider_enabled, false)
     or coalesce(v_config.multi_user_enabled, false)
     or coalesce(v_config.gateway_enabled, false)
     or coalesce(v_config.electron_routing_enabled, false)
     or coalesce(v_config.rollout_limit, 0) <> 0 then
    raise exception 'Refusing Stage 5 rollback while DAVID v2 runtime flags or rollout are enabled';
  end if;

  select
    (select count(*) from david_v2.provider_runs)
    + (select count(*) from david_v2.provider_run_events)
    + (select count(*) from david_v2.provider_usage_daily)
    + (select count(*) from david_v2.device_routes)
    + (select count(*) from david_v2.user_limits)
  into v_rows;

  if v_rows <> 0 then
    raise exception 'Refusing Stage 5 rollback while Stage 5 rows exist';
  end if;
end;
$$;

drop function if exists public.david_v2_list_my_provider_run_events(uuid);
drop function if exists public.david_v2_get_my_provider_run(uuid);
drop function if exists public.david_v2_create_my_provider_run(uuid, uuid, text, text);
drop function if exists public.david_v2_ensure_my_provider_conversation(uuid, text, text);

drop function if exists david_v2.fail_provider_run(uuid, text);
drop function if exists david_v2.complete_provider_run(uuid, text, text, integer, integer);
drop function if exists david_v2.append_provider_run_event(uuid, text, text, jsonb);
drop function if exists david_v2.claim_provider_run(text);
drop function if exists david_v2.require_provider_router_enabled();

drop table if exists david_v2.provider_run_events;
drop table if exists david_v2.provider_runs;
drop table if exists david_v2.provider_usage_daily;
drop table if exists david_v2.device_routes;
drop table if exists david_v2.user_limits;

alter table david_v2.soul_threads
  drop constraint if exists soul_threads_full_identity_unique;

alter table david_v2.system_config
  drop column if exists provider_router_enabled;

update david_v2.system_config
set
  schema_version = 'david-v2-stage4-1',
  metadata = (metadata - 'stage5_base_branch' - 'stage5_base_commit'
    - 'auth_identity_key' - 'gmail_is_login_not_primary_key'
    - 'provider_conversation_per_user_twin' - 'provider_run_progress_events'
    - 'provider_keys_server_only' - 'private_chat_urls_stored')
    || jsonb_build_object(
      'stage', 4,
      'state', 'api_gateway_schema_installed_disabled',
      'provider_calls_enabled', false
    )
where id = 1;

commit;
