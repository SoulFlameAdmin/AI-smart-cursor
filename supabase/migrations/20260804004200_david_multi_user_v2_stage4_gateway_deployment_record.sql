begin;

update david_v2.system_config
set metadata = metadata || jsonb_build_object(
  'gateway_edge_function_deployed', true,
  'gateway_edge_function_slug', 'david-api-gateway-v2',
  'gateway_edge_function_version', 1,
  'gateway_edge_function_verify_jwt', true,
  'gateway_edge_function_sha256', 'bbab53490b2d1ff3dc92a015e9451ce7922eb732d051ee852c8b7f7dadf23cce',
  'gateway_browser_origins_configured', false,
  'gateway_live_user_test', false
)
where id = 1
  and gateway_enabled = false
  and multi_user_enabled = false
  and provider_enabled = false
  and electron_routing_enabled = false
  and rollout_limit = 0
  and not exists (select 1 from david_v2.gateway_requests);

commit;
