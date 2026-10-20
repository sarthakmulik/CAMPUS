-- =====================================================================
-- 0024 — Clear-chat visibility hotfix (follow-up to 0023).
--
-- 0023's list_conversations honours cleared_at for the INBOX PREVIEW but
-- does not return it, so the thread view had no way to hide "cleared"
-- history on the clearer's side. "Clear" is delete-for-me: my view cuts
-- off here — the other side keeps everything.
--
-- Change: list_conversations also returns the CLEARER's cleared_at
-- timestamp. The client hides messages at or before it (list preview is
-- already server-side). Read-only change; same grants as 0023.
-- Re-runnable (idempotent).
--
-- v2 fix: "lm is not null" on a composite row means EVERY field must be
-- non-null — real messages always carry NULLs (parent_message_id,
-- shared_kind, deleted_at…), which made cleared chats disappear from the
-- inbox forever. All three composite tests now check lm.id instead.
-- =====================================================================

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
  last_preview text,
  last_sender_id uuid,
  last_at timestamptz,
  last_edited_at timestamptz,
  last_seen boolean,
  unread_count bigint,
  status text,
  i_requested boolean,
  pinned boolean,
  muted boolean,
  archived boolean,
  cleared_at timestamptz
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
    case
      when lm.id is null then null
      when lm.deleted_at is not null then 'Message unsent'
      when lm.is_system then lm.body
      when coalesce(jsonb_array_length(coalesce(lm.attachments, '[]'::jsonb)), 0) > 0 and lm.body is null then
        case
          when coalesce((lm.attachments -> 0 ->> 'mime'), '') like 'image/%' then 'Sent a photo'
          when coalesce((lm.attachments -> 0 ->> 'mime'), '') like 'video/%' then 'Sent a video'
          when coalesce((lm.attachments -> 0 ->> 'mime'), '') like 'audio/%' then 'Sent a voice message'
          else 'Sent a file'
        end
      when lm.shared_kind = 'reel' then 'Sent a reel'
      when lm.shared_kind = 'post' then 'Sent a post'
      when lm.shared_kind = 'profile' then 'Sent a profile'
      when lm.shared_kind = 'listing' then 'Sent a listing'
      when lm.shared_kind = 'event' then 'Sent an event'
      else lm.body
    end,
    lm.sender_id,
    lm.created_at,
    lm.edited_at,
    /* the other side has read MY newest message */
    (lm.id is not null and lm.sender_id = auth.uid()
      and peer_m.last_read_at >= lm.created_at),
    (
      select count(*) from public.chat_messages mm
      where mm.conversation_id = c.id
        and mm.sender_id is distinct from auth.uid()
        and mm.deleted_at is null
        and mm.created_at > m.last_read_at
        and mm.created_at > coalesce(m.cleared_at, '-infinity')
    ),
    c.status,
    c.kind = 'dm' and c.status <> 'accepted' and c.created_by = auth.uid(),
    m.pinned_at is not null,
    m.muted,
    m.archived_at is not null,
    m.cleared_at
  from public.conversations c
  join public.conversation_members m
    on m.conversation_id = c.id and m.user_id = auth.uid()
  left join lateral (
    select pm.user_id from public.conversation_members pm
    where pm.conversation_id = c.id and pm.user_id <> auth.uid()
    limit 1
  ) peer on c.kind = 'dm'
  left join public.conversation_members peer_m
    on c.kind = 'dm' and peer_m.conversation_id = c.id and peer_m.user_id = peer.user_id
  left join public.profiles pr on pr.id = peer.user_id
  left join lateral (
    select msg.*
    from public.chat_messages msg
    where msg.conversation_id = c.id
      and (m.cleared_at is null or msg.created_at > m.cleared_at)
    order by msg.created_at desc
    limit 1
  ) lm on true
  where c.kind in ('dm', 'group')
    and (m.cleared_at is null or lm.id is not null)
    and (
      status = 'accepted'
      or (c.kind = 'dm' and status = 'pending')
      or (c.kind = 'dm' and status = 'declined' and c.created_by = auth.uid())
    )
  order by
    m.pinned_at desc nulls last,
    (c.created_by <> auth.uid() and status = 'pending') desc,
    c.last_message_at desc nulls last, c.created_at desc
$$;

revoke all on function public.list_conversations() from public, anon;
grant execute on function public.list_conversations() to authenticated;
