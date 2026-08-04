begin;

create trigger david_v2_gateway_requests_twin_owner
before insert or update of user_id, twin_id on david_v2.gateway_requests
for each row
when (new.twin_id is not null)
execute function david_v2.enforce_twin_owner();

update david_v2.system_config
set metadata = metadata || jsonb_build_object(
  'gateway_twin_owner_trigger', true
)
where id = 1
  and gateway_enabled = false
  and multi_user_enabled = false
  and provider_enabled = false
  and electron_routing_enabled = false
  and rollout_limit = 0;

commit;
