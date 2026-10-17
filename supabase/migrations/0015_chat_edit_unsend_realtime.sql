-- 0006 already put chat_messages into supabase_realtime, but only changed one
-- thing: nothing listened to the conversation LIST, and messages could never
-- be edited or unsent. Instagram-grade messaging needs:
--   1. Edit       — the sender can edit their own message within 24 hours
--                   (body + edited_at; the bubble then shows "edited")
--   2. Unsend     — the sender removes their own message: the text leaves the
--                   database (body → null) and both sides see a tombstone
--   3. The thread AND the chats list hear edits/unsends live via realtime
--      UPDATE events (publication already covers the table)
-- All rules live in two security-definer RPCs; RLS stays closed for direct
-- UPDATE, so only these rules can ever change a sent message. Idempotent.

/* ------------------------------------------------------------------ */
/* 1. Editing                                                          */
/* ------------------------------------------------------------------ */

create or replace function public.edit_chat_message(p_message uuid, p_body text)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_sender uuid;
  v_created timestamptz;
  v_deleted timestamptz;
  v_body text;
begin
  if v_me is null then
    raise exception 'Sign in to edit your messages.';
  end if;
  v_body := nullif(trim(coalesce(p_body, '')), '');
  if v_body is null then
    raise exception 'Write something first.';
  end if;
  if length(v_body) > 2000 then
    raise exception 'Messages can be at most 2000 characters.';
  end if;

  select msg.sender_id, msg.created_at, msg.deleted_at
    into v_sender, v_created, v_deleted
  from public.chat_messages msg
  where msg.id = p_message;

  if v_sender is null then
    raise exception 'That message does not exist.';
  end if;
  if v_sender <> v_me then
    raise exception 'Only the message you sent can be edited.';
  end if;
  if v_deleted is not null then
    raise exception 'Unsent messages cannot be edited.';
  end if;
  if v_created < now() - interval '24 hours' then
    raise exception 'Messages can be edited for 24 hours after sending.';
  end if;

  update public.chat_messages
    set body = v_body, edited_at = now()
  where public.chat_messages.id = p_message;

  return now();
end $$;

/* ------------------------------------------------------------------ */
/* 2. Unsending (Instagram's "unsend")                                 */
/* ------------------------------------------------------------------ */

/* the tombstone keeps the row; the text itself leaves the table. Chat
   messages are the only place body may become null. */
alter table public.chat_messages alter column body drop not null;

create or replace function public.unsend_chat_message(p_message uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_sender uuid;
  v_deleted timestamptz;
begin
  if v_me is null then
    raise exception 'Sign in to unsend your messages.';
  end if;

  select msg.sender_id, msg.deleted_at
    into v_sender, v_deleted
  from public.chat_messages msg
  where msg.id = p_message;

  if v_sender is null then
    raise exception 'That message does not exist.';
  end if;
  if v_sender <> v_me then
    raise exception 'Only the message you sent can be unsent.';
  end if;
  if v_deleted is not null then
    raise exception 'That message was already unsent.';
  end if;

  /* the text leaves the table itself — a tombstone remains on both sides */
  update public.chat_messages
    set body = null, deleted_at = now()
  where public.chat_messages.id = p_message;

  return now();
end $$;

revoke all on function public.edit_chat_message(uuid, text) from public;
revoke all on function public.unsend_chat_message(uuid) from public;
grant execute on function public.edit_chat_message(uuid, text) to authenticated;
grant execute on function public.unsend_chat_message(uuid) to authenticated;

/* direct UPDATE stays closed — every change goes through the rules above */

/* ------------------------------------------------------------------ */
/* 3. History reads tombstones and edit stamps                         */
/* ------------------------------------------------------------------ */

drop function if exists public.list_chat_messages(uuid, int, timestamptz);
create or replace function public.list_chat_messages(
  p_conversation uuid,
  p_limit int default 40,
  p_before timestamptz default null
)
returns table (
  id uuid,
  conversation_id uuid,
  sender_id uuid,
  sender_username text,
  sender_display_name text,
  body text,
  created_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    msg.id,
    msg.conversation_id,
    msg.sender_id,
    pr.username,
    coalesce(pr.display_name, 'Student'),
    msg.body,
    msg.created_at,
    msg.edited_at,
    msg.deleted_at
  from public.chat_messages msg
  left join public.profiles pr on pr.id = msg.sender_id
  where msg.conversation_id = p_conversation
    and (p_before is null or msg.created_at < p_before)
    and auth.uid() in (
      select user_id from public.conversation_members
      where conversation_id = p_conversation
    )
  order by msg.created_at desc
  limit greatest(least(p_limit, 100), 1)
$$;

/* ------------------------------------------------------------------ */
/* 4. Chats-list preview understands "unsent"                          */
/* ------------------------------------------------------------------ */

drop function if exists public.list_conversations();
create or replace function public.list_conversations()
returns table (
  conversation_id uuid,
  kind text,
  title text,
  peer_id uuid,
  peer_username text,
  display_name text,
  avatar_url text,
  member_count int,
  last_body text,
  last_at timestamptz,
  last_edited_at timestamptz,
  unread_count bigint,
  status text,
  i_requested boolean
)
language sql stable security definer set search_path = public as $$
  select
    c.id,
    c.kind,
    c.title,
    case when c.kind = 'dm' then peer.user_id end,
    case when c.kind = 'dm' then pr.username end,
    case
      when c.kind = 'dm' then coalesce(pr.display_name, pr.username, 'Student')
      else c.title
    end,
    case when c.kind = 'dm' then pr.avatar_url end,
    (select count(*) from public.conversation_members cm where cm.conversation_id = c.id),
    case when lm.deleted_at is not null then 'Message unsent' else lm.body end,
    lm.created_at,
    lm.edited_at,
    (
      select count(*) from public.chat_messages mm
      where mm.conversation_id = c.id
        and mm.sender_id <> auth.uid()
        and mm.created_at > m.last_read_at
    ),
    c.status,
    c.kind = 'dm' and c.status <> 'accepted' and c.created_by = auth.uid()
  from public.conversations c
  join public.conversation_members m
    on m.conversation_id = c.id and m.user_id = auth.uid()
  left join lateral (
    select pm.user_id from public.conversation_members pm
    where pm.conversation_id = c.id and pm.user_id <> auth.uid()
    limit 1
  ) peer on c.kind = 'dm'
  left join public.profiles pr on pr.id = peer.user_id
  left join lateral (
    select body, created_at, edited_at, deleted_at
    from public.chat_messages msg
    where msg.conversation_id = c.id
    order by msg.created_at desc
    limit 1
  ) lm on true
  where c.kind in ('dm', 'group')
    and (
      c.status = 'accepted'
      or (c.kind = 'dm' and c.status = 'pending') -- outgoing AND incoming requests
      or (c.kind = 'dm' and c.status = 'declined' and c.created_by = auth.uid())
    )
  order by
    (c.created_by <> auth.uid() and c.status = 'pending') desc, -- incoming requests first
    c.last_message_at desc nulls last, c.created_at desc
$$;

revoke all on function public.list_conversations() from public;
grant execute on function public.list_conversations() to anon, authenticated;
