-- Check what data is inside the legacy chats cluster before 0006 replaces it.
select
  (select count(*) from pg_constraint
    where conname in ('messages_conversation_id_fkey', 'conversation_members_conversation_id_fkey')) as legacy_fk_count,
  (select to_regclass('public.messages') is not null) as has_messages,
  (select to_regclass('public.conversation_members') is not null) as has_conversation_members,
  (select to_regclass('public.conversations') is not null) as has_conversations,
  (select to_regclass('public.chat_messages') is not null) as has_chat_messages;
