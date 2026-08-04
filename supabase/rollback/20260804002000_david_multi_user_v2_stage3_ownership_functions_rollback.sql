begin;

do $$
declare
  v_config david_v2.system_config%rowtype;
begin
  select * into v_config
  from david_v2.system_config
  where id = 1
  for update;

  if v_config.multi_user_enabled
     or v_config.provider_enabled
     or v_config.electron_routing_enabled
     or v_config.rollout_limit <> 0 then
    raise exception 'DAVID v2 Stage 3 rollback refused while runtime or rollout is enabled'
      using errcode = '55000';
  end if;
end;
$$;

drop policy if exists david_v2_identities_owner_select on david_v2.identities;
drop policy if exists david_v2_conversations_owner_select on david_v2.conversations;
drop policy if exists david_v2_consents_owner_select on david_v2.user_consents;
drop policy if exists david_v2_threads_owner_select on david_v2.soul_threads;

drop function if exists public.david_v2_list_my_threads();
drop function if exists public.david_v2_create_my_thread(uuid, text, text);
drop function if exists public.david_v2_list_my_conversations();
drop function if exists public.david_v2_register_my_local_conversation(uuid, text);
drop function if exists public.david_v2_list_my_consents(uuid);
drop function if exists public.david_v2_set_my_consent(uuid, text, text, boolean, jsonb);
drop function if exists public.david_v2_get_my_identity();
drop function if exists public.david_v2_provision_my_identity();

drop function if exists david_v2.require_owned_conversation(uuid, uuid);
drop function if exists david_v2.require_owned_identity(uuid);
drop function if exists david_v2.assert_twin_owner(uuid, uuid);
drop function if exists david_v2.require_multi_user_enabled();
drop function if exists david_v2.require_authenticated_user();

update david_v2.system_config
set
  schema_version = 'david-v2-stage2-1',
  metadata = (metadata
    - 'stage3_base_branch'
    - 'stage3_base_commit'
    - 'ownership_rpc_count'
    - 'direct_client_table_access')
    || jsonb_build_object(
      'stage', 2,
      'state', 'installed_disabled',
      'stage3_rolled_back_at', now()
    )
where id = 1;

commit;
