begin;

create index if not exists david_v2_conversations_identity_owner_idx
  on david_v2.conversations(identity_id, user_id);

create index if not exists david_v2_conversations_twin_idx
  on david_v2.conversations(twin_id);

create index if not exists david_v2_user_consents_identity_owner_idx
  on david_v2.user_consents(identity_id, user_id);

create index if not exists david_v2_user_consents_twin_idx
  on david_v2.user_consents(twin_id);

create index if not exists david_v2_soul_threads_conversation_owner_idx
  on david_v2.soul_threads(conversation_id, identity_id, user_id, twin_id);

create index if not exists david_v2_soul_threads_source_thread_idx
  on david_v2.soul_threads(source_thread_id)
  where source_thread_id is not null;

create index if not exists david_v2_soul_threads_twin_idx
  on david_v2.soul_threads(twin_id);

commit;
