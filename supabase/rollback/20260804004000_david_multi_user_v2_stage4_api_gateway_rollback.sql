begin;

do $$
declare
  v_config david_v2.system_config%rowtype;
  v_gateway_rows bigint;
begin
  select * into v_config
  from david_v2.system_config
  where id = 1
  for update;

  if v_config.multi_user_enabled
     or v_config.provider_enabled
     or v_config.electron_routing_enabled
     or coalesce(v_config.gateway_enabled, false)
     or v_config.rollout_limit <> 0 then
    raise exception 'Refusing DAVID v2 Stage 4 rollback while runtime or rollout is enabled';
  end if;

  select count(*) into v_gateway_rows
  from david_v2.gateway_requests;

  if v_gateway_rows <> 0 then
    raise exception 'Refusing DAVID v2 Stage 4 rollback while gateway request records exist';
  end if;
end;
$$;

drop function if exists public.david_v2_gateway_fail_my_request(uuid, integer, text);
drop function if exists public.david_v2_gateway_complete_my_request(uuid, integer, jsonb);
drop function if exists public.david_v2_gateway_begin_my_request(text, text, text, uuid, uuid);
drop function if exists public.david_v2_gateway_status();
drop function if exists david_v2.require_gateway_enabled();

drop table if exists david_v2.gateway_requests;

alter table david_v2.system_config
  drop column if exists gateway_enabled;

update david_v2.system_config
set
  schema_version = 'david-v2-stage3-1',
  metadata = metadata
    - 'gateway_request_ledger'
    - 'gateway_edge_function_deployed'
    - 'provider_calls_enabled'
    || jsonb_build_object(
      'stage', 3,
      'state', 'stage3_locked_verified_disabled',
      'stable_branch', 'stable/david-multi-user-v2-stage3',
      'stable_commit', 'f22e41cd84483d069eb6ea7acfc5b4871fb46088'
    )
where id = 1;

commit;
