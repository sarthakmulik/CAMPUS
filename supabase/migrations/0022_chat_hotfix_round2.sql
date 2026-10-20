-- =====================================================================
-- 0022 — hotfix round 2 (live-verified against production)
--
-- What broke:
-- 1. Reaction removal crashed (42883 operator does not exist: jsonb - jsonb):
--    v_uids - to_jsonb(v_me::text) is invalid — jsonb minus only accepts
--    text or text[] on the right — so removing any reaction failed.
-- 2. Sending to a nonexistent conversation returned 200 []: when the
--    conversation does not exist, select … into leaves v_member NULL and
--    `if not v_member` skips the guard; the insert then lands an orphan row.
--    Empirically this proved the chat_messages.conversation_id foreign key is
--    missing in the live DB (0006's `create table if not exists` never ran on
--    a table that already existed), so the insert succeeded.
-- 3. Anon could execute chat RPCs (Supabase default privileges grant
--    EXECUTE to anon directly on new functions, so revoke from public was
--    not enough): a direct `revoke from anon` is required.
--
-- What this does:
-- - Deletes orphan chat_messages rows with no parent conversation (the QA
--   probes created a few), then adds the missing FK (guarded, idempotent).
-- - Re-adds the conversation-existence guard to send_chat_message
--   (`if not found or not v_member`).
-- - Fixes toggle_chat_reaction removal with `v_uids - v_me::text`.
-- - Revokes EXECUTE from anon/public on every chat function; re-grants to
--   authenticated only.
-- Safe to run any time; idempotent.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. hygiene first: drop orphaned test rows before the FK lands
-- ---------------------------------------------------------------------
delete from public.chat_messages cm
where not exists (select 1 from public.conversations c where c.id = cm.conversation_id);

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chat_messages_conversation_id_fkey'
      and conrelid = 'public.chat_messages'::regclass
  ) then
    alter table public.chat_messages
      add constraint chat_messages_conversation_id_fkey
      foreign key (conversation_id) references public.conversations (id) on delete cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. send_chat_message: conversation-existence guard
-- ---------------------------------------------------------------------
create or replace function public.send_chat_message(
  p_conversation uuid,
  p_body text,
  p_parent_id uuid default null,
  p_attachments jsonb default '[]'::jsonb
)
returns setof public.chat_message_shape
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_body text;
  v_club uuid;
  v_member boolean;
  v_attachments jsonb := '[]'::jsonb;
  v_att jsonb;
  v_parent record;
  v_parent_id uuid;
  v_direct_author uuid;
  v_root_author uuid;
  v_notified uuid := null;
  v_id uuid;
  v_recent int;
  v_tags text[];
  v_mentioned uuid;
begin
  if v_me is null then
    raise exception 'Sign in to send messages.';
  end if;

  select con.club_id, exists (
    select 1 from public.conversation_members m
    where m.conversation_id = con.id and m.user_id = v_me
  ) into v_club, v_member
  from public.conversations con
  where con.id = p_conversation;

  -- the existence of the conversation row matters as much as the seat:
  -- a select-into on an unknown id would otherwise pass with NULL
  if not found or not v_member then
    raise exception 'You are not part of this conversation.';
  end if;

  -- burst protection: 8 messages per 30 seconds per sender per channel
  select count(*) into v_recent
  from public.chat_messages
  where conversation_id = p_conversation
    and sender_id = v_me
    and created_at > now() - interval '30 seconds';
  if v_recent >= 8 then
    raise exception 'Sending too fast — wait a few seconds.';
  end if;

  -- attachments: ≤ 4, known types, ≤ 25 MB, folder of THIS conversation
  if p_attachments is not null and jsonb_typeof(p_attachments) = 'array' then
    if jsonb_array_length(p_attachments) > 4 then
      raise exception 'A message can carry at most 4 attachments.';
    end if;
    for v_att in select * from jsonb_array_elements(p_attachments) loop
      if not (v_att ? 'path' and v_att ? 'name') then
        raise exception 'That attachment is incomplete — try uploading it again.';
      end if;
      if (v_att->>'path') !~ ('^' || p_conversation::text || '/.+') then
        raise exception 'That attachment does not belong to this conversation.';
      end if;
      if (v_att->>'mime') not in (
        'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
        'text/plain', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ) then
        raise exception 'That file type is not supported.';
      end if;
      if coalesce((v_att->>'size')::numeric, 0) <= 0
        or coalesce((v_att->>'size')::numeric, 0) > 26214400 then
        raise exception 'Attachments can be at most 25 MB.';
      end if;
      if char_length(coalesce(v_att->>'name', '')) = 0
        or char_length(v_att->>'name') > 180 then
        raise exception 'That file name is invalid.';
      end if;
      v_attachments := v_attachments || jsonb_build_object(
        'path', v_att->>'path',
        'name', left(v_att->>'name', 180),
        'mime', v_att->>'mime',
        'size', (v_att->>'size')::numeric
      );
    end loop;
  end if;

  v_body := nullif(trim(coalesce(p_body, '')), '');
  if v_body is null and jsonb_array_length(v_attachments) = 0 then
    raise exception 'Write something first.';
  end if;
  if v_body is not null and char_length(v_body) > 2000 then
    raise exception 'Messages can be at most 2000 characters.';
  end if;

  -- reply integrity: target must exist, live in the SAME conversation and not
  -- be a tombstone. A reply always binds to its thread's ROOT (one flat level:
  -- replying to a reply joins that exchange instead of nesting deeper).
  if p_parent_id is not null then
    select pm.id, pm.parent_message_id, pm.sender_id into v_parent
    from public.chat_messages pm
    where pm.id = p_parent_id
      and pm.conversation_id = p_conversation
      and pm.deleted_at is null;
    if v_parent is null then
      raise exception 'That message can no longer be replied to.';
    end if;
    v_direct_author := v_parent.sender_id;
    if v_parent.parent_message_id is not null then
      p_parent_id := v_parent.parent_message_id;
      select pm.sender_id into v_root_author
      from public.chat_messages pm where pm.id = p_parent_id;
    else
      v_root_author := v_parent.sender_id;
      p_parent_id := v_parent.id;
    end if;
    v_parent_id := p_parent_id;
  end if;

  insert into public.chat_messages (conversation_id, sender_id, body, parent_message_id, attachments)
  values (p_conversation, v_me, v_body, v_parent_id, v_attachments)
  returning id into v_id;

  -- mentions: padded so a leading @ still matches; only ACTIVE members of
  -- THIS community get a notification — deduped by notify_member
  if v_club is not null and v_body is not null then
    select coalesce(array_agg(distinct rm[1]), '{}') into v_tags
    from regexp_matches(' ' || v_body, '(?:^|[^a-zA-Z0-9_.@-])@([a-z0-9_]{3,20})', 'g') rm;
    if array_length(v_tags, 1) > 10 then
      select array_agg(t) into v_tags
      from (select distinct t from unnest(v_tags) t order by t limit 10) s;
    end if;
    for i in 1 .. coalesce(array_length(v_tags, 1), 0) loop
      select pr.id into v_mentioned
      from public.profiles pr
      where lower(pr.username) = v_tags[i];
      if v_mentioned is not null and v_mentioned <> v_me
        and public.is_club_active_member(v_club, v_mentioned) then
        perform public.notify_member(v_mentioned, v_me, 'chat_mention', 'club_chat', v_id);
        if v_mentioned in (v_root_author, v_direct_author) then
          v_notified := coalesce(v_notified, v_mentioned);
        end if;
      end if;
    end loop;
  end if;

  -- reply notification: the author whose message was clicked AND the thread
  -- root's author (they can differ); skipped when a mention already covered
  -- them, and notify_member dedupes anything left
  if v_notified is distinct from v_direct_author and v_direct_author is not null
    and v_direct_author <> v_me
    and (v_club is null or public.is_club_active_member(v_club, v_direct_author)) then
    perform public.notify_member(v_direct_author, v_me, 'chat_reply', 'club_chat', v_id);
  end if;
  if v_notified is distinct from v_root_author and v_root_author is not null
    and v_root_author <> v_me
    and (v_club is null or public.is_club_active_member(v_club, v_root_author)) then
    perform public.notify_member(v_root_author, v_me, 'chat_reply', 'club_chat', v_id);
  end if;

  return query
  select m.* from public.chat_all(p_conversation) m where m.id = v_id;
end $$;

-- ---------------------------------------------------------------------
-- 3. toggle_chat_reaction: fix the broken removal path
-- ---------------------------------------------------------------------
create or replace function public.toggle_chat_reaction(p_message uuid, p_emoji text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg record;
  v_reactions jsonb;
  v_uids jsonb;
  v_options text[] := array['👍','❤️','😂','🎉','🙏','🔥','👀','💯'];
begin
  if v_me is null then
    raise exception 'Sign in to react.';
  end if;
  if not (p_emoji = any(v_options)) then
    raise exception 'That reaction is not available.';
  end if;

  select conversation_id, deleted_at into v_msg
  from public.chat_messages where id = p_message;
  if v_msg is null then
    raise exception 'That message does not exist.';
  end if;
  if not public.is_conversation_member(v_msg.conversation_id) then
    raise exception 'Only members can react.';
  end if;
  if v_msg.deleted_at is not null then
    raise exception 'Unsent messages cannot be reacted to.';
  end if;

  -- row lock serializes concurrent toggles on the same message
  select reactions into v_reactions
  from public.chat_messages where id = p_message for update;

  v_uids := coalesce(v_reactions -> p_emoji, '[]'::jsonb);
  if v_uids @> to_jsonb(v_me::text) then
    -- jsonb minus accepts a TEXT key (NOT another jsonb value — the old
    -- `v_uids - to_jsonb(…)` crashed with 42883 on the removal path)
    v_uids := v_uids - v_me::text;
    if jsonb_array_length(v_uids) = 0 then
      v_reactions := v_reactions - p_emoji;
    else
      v_reactions := jsonb_set(v_reactions, array[p_emoji], v_uids);
    end if;
  else
    v_reactions := jsonb_set(v_reactions, array[p_emoji], v_uids || to_jsonb(v_me::text));
  end if;

  update public.chat_messages set reactions = v_reactions where id = p_message;
  return v_reactions;
end $$;

-- ---------------------------------------------------------------------
-- 4. grants: authenticated only — Supabase default privileges grant EXECUTE
--    to anon directly on new functions, so revoke from anon explicitly
-- ---------------------------------------------------------------------
revoke all on function public.chat_all(uuid)                              from public, anon;
revoke all on function public.list_chat_messages(uuid, int, timestamptz)  from public, anon;
revoke all on function public.send_chat_message(uuid, text, uuid, jsonb)  from public, anon;
revoke all on function public.toggle_chat_reaction(uuid, text)            from public, anon;
revoke all on function public.edit_chat_message(uuid, text)               from public, anon;
revoke all on function public.unsend_chat_message(uuid)                   from public, anon;
revoke all on function public.moderate_delete_chat_message(uuid)          from public, anon;
revoke all on function public.set_chat_message_pin(uuid, boolean)         from public, anon;
revoke all on function public.list_chat_pins(uuid)                        from public, anon;
revoke all on function public.list_chat_thread(uuid)                      from public, anon;
revoke all on function public.search_chat(uuid, text, text, int, timestamptz) from public, anon;
revoke all on function public.list_chat_mention_targets(uuid, text)       from public, anon;

grant execute on function public.list_chat_messages(uuid, int, timestamptz)      to authenticated;
grant execute on function public.send_chat_message(uuid, text, uuid, jsonb)      to authenticated;
grant execute on function public.toggle_chat_reaction(uuid, text)                to authenticated;
grant execute on function public.edit_chat_message(uuid, text)                   to authenticated;
grant execute on function public.unsend_chat_message(uuid)                       to authenticated;
grant execute on function public.moderate_delete_chat_message(uuid)              to authenticated;
grant execute on function public.set_chat_message_pin(uuid, boolean)             to authenticated;
grant execute on function public.list_chat_pins(uuid)                            to authenticated;
grant execute on function public.list_chat_thread(uuid)                          to authenticated;
grant execute on function public.search_chat(uuid, text, text, int, timestamptz) to authenticated;
grant execute on function public.list_chat_mention_targets(uuid, text)           to authenticated;

commit;
