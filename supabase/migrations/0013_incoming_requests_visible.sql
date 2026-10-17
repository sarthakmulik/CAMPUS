-- 0008 shipped a `list_conversations` that only showed pending and declined
-- requests to the member who CREATED them (created_by = auth.uid()). That made
-- an incoming chat request invisible to its recipient: their Chats list had
-- nothing to tap, so there was nowhere to accept or decline (Instagram shows
-- the request row first, with Accept / Decline once opened).
--
-- This replacement shows:
--   accepted chats        → both sides
--   pending requests      → BOTH sides (i_requested tells which side you are)
--   declined requests     → the creator only (the recipient never sees one)
-- Idempotent: safe to run again or after a fresh 0008.

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
    lm.body,
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
    select body, created_at, edited_at
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
