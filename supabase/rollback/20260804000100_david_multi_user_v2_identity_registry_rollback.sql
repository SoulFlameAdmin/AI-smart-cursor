begin;

do $$
declare
  v_multi_user_enabled boolean;
  v_provider_enabled boolean;
  v_electron_routing_enabled boolean;
begin
  if to_regclass('david_v2.system_config') is null then
    return;
  end if;

  select
    multi_user_enabled,
    provider_enabled,
    electron_routing_enabled
  into
    v_multi_user_enabled,
    v_provider_enabled,
    v_electron_routing_enabled
  from david_v2.system_config
  where id = 1;

  if coalesce(v_multi_user_enabled, false)
     or coalesce(v_provider_enabled, false)
     or coalesce(v_electron_routing_enabled, false) then
    raise exception 'DAVID v2 rollback refused because one or more runtime feature flags are enabled';
  end if;
end;
$$;

drop schema if exists david_v2 cascade;

commit;
