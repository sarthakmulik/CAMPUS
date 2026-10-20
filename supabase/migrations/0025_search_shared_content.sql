-- =====================================================================
-- 0025 — Search covers shared cards & attachment names (follow-up).
--
-- Acceptance testing surfaced two search gaps:
--   1. search_all_chats required msg.body IS NOT NULL, so shared-card
--      messages (reels/posts/listings/events/profiles, body = NULL) and
--      file/voice attachments were invisible to global chat search,
--      and it searched messages a member had already "cleared" away.
--   2. search_chat (thread search) matched body + author only — shared
--      cards could not be found by their live title (e.g. "Clip 2").
--
-- Changes, read-only to data:
--   • search_all_chats now resolves the SHARED content's live title and
--     attachment file names, matches them, previews them truthfully
--     ("Reel: …", "Listing: …", "Attachment: <file>") and honours the
--     searcher's cleared-chat cutoff.
--   • search_chat additionally matches shared_title / shared_subtitle.
-- Role isolation (SECURITY DEFINER + auth.uid() membership) unchanged.
-- Idempotent; safe to re-run.
-- =====================================================================

drop function if exists public.search_all_chats(text, int);

create or replace function public.search_all_chats(
  p_query text,
  p_limit int default 30
)
returns table (
  message_id uuid,
  conversation_id uuid,
  kind text,
  conversation_title text,
  sender_id uuid,
  sender_name text,
  body text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_limit int;
begin
  if v_q is null then
    raise exception 'Type something to search.';
  end if;
  v_q := '%' || left(v_q, 60) || '%';
  v_limit := greatest(least(coalesce(p_limit, 30), 50), 1);

  return query
  select
    msg.id,
    msg.conversation_id,
    con.kind,
    case when con.kind = 'dm' then coalesce(dp.display_name, dp.username, 'Student') else con.title end,
    msg.sender_id,
    coalesce(sp_pr.display_name, sp_pr.username, 'Student'),
    coalesce(
      msg.body,
      case msg.shared_kind
        when 'reel'    then 'Reel: '    || coalesce(nullif(left(sp.body, 80), ''), 'shared reel')
        when 'post'    then 'Post: '    || coalesce(nullif(left(sp.body, 80), ''), 'shared post')
        when 'profile' then 'Profile: ' || coalesce(pf.display_name, pf.username, 'Student')
        when 'listing' then 'Listing: ' || coalesce(ml.title, 'shared listing')
        when 'event'   then 'Event: '   || coalesce(ev.title, 'shared event')
        else case
          when coalesce(jsonb_array_length(coalesce(msg.attachments, '[]'::jsonb)), 0) > 0
          then 'Attachment: ' || coalesce(msg.attachments -> 0 ->> 'name', 'file')
          else null
        end
      end,
      ''
    ),
    msg.created_at
  from public.chat_messages msg
  join public.conversations con on con.id = msg.conversation_id
  join public.conversation_members my
    on my.conversation_id = msg.conversation_id and my.user_id = auth.uid()
  left join lateral (
    select prx.* from public.conversation_members pm
    join public.profiles prx on prx.id = pm.user_id
    where pm.conversation_id = con.id and pm.user_id <> auth.uid()
    limit 1
  ) dp on con.kind = 'dm'
  left join public.profiles sp_pr on sp_pr.id = msg.sender_id
  /* shared-content resolution (mirrors chat_all's joins) */
  left join public.posts sp
    on msg.shared_kind in ('reel', 'post') and sp.id = msg.shared_id
  left join public.profiles pf on msg.shared_kind in ('reel', 'post', 'profile') and pf.id = msg.shared_id
  left join public.marketplace_listings ml on msg.shared_kind = 'listing' and ml.id = msg.shared_id
  left join public.events ev on msg.shared_kind = 'event' and ev.id = msg.shared_id
  where msg.deleted_at is null
    and con.kind in ('dm', 'group', 'club')
    /* honour the searcher's cleared-chat cutoff */
    and (my.cleared_at is null or msg.created_at > my.cleared_at)
    and (
      (msg.body is not null and msg.body ilike v_q)
      or (msg.attachments is not null and msg.attachments::text ilike v_q)
      or (sp.id is not null and coalesce(sp.body, '') ilike v_q)
      or (pf.id is not null and coalesce(nullif(pf.display_name, ''), pf.username, '') ilike v_q)
      or (ml.id is not null and coalesce(ml.title, '') ilike v_q)
      or (ev.id is not null and coalesce(ev.title, '') ilike v_q)
    )
  order by msg.created_at desc, msg.id desc
  limit v_limit;
end $$;

revoke all on function public.search_all_chats(text, int) from public, anon;
grant execute on function public.search_all_chats(text, int) to authenticated;

-- thread search: shared cards are findable by their live title/subtitle
drop function if exists public.search_chat(uuid, text, text, int, timestamptz);

create or replace function public.search_chat(
  p_conversation uuid,
  p_query text default '',
  p_hashtag text default '',
  p_limit int default 30,
  p_before timestamptz default null
)
returns setof public.chat_message_shape
language plpgsql stable security definer set search_path = public as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_tag text := nullif(btrim(coalesce(p_hashtag, '')), '');
  v_limit int;
begin
  if v_q is null and v_tag is null then
    raise exception 'Type a word or pick a hashtag to search.';
  end if;
  if char_length(v_q) > 60 then
    v_q := left(v_q, 60);
  end if;
  if v_tag is not null then
    v_tag := btrim(lower(v_tag), '#');
    if v_tag is null or v_tag = '' then
      raise exception 'Type a word after the # sign to search.';
    end if;
    if v_tag !~ '^[[:alnum:]_]{2,30}$' then
      raise exception 'That hashtag is malformed.';
    end if;
  end if;
  v_limit := greatest(least(coalesce(p_limit, 30), 50), 1);
  if not public.is_conversation_member(p_conversation) then
    raise exception 'You are not part of this conversation.';
  end if;

  return query
  select m.* from public.chat_all(p_conversation) m
  where m.deleted_at is null
    and (p_before is null or m.created_at < p_before)
    and (
      v_q is null
      or (m.body is not null and position(lower(v_q) in lower(m.body)) > 0)
      or position(lower(v_q) in lower(coalesce(m.sender_display_name, m.sender_username, ''))) > 0
      or position(lower(v_q) in lower(coalesce(m.sender_username, ''))) > 0
      or position(lower(v_q) in lower(coalesce(m.shared_title, ''))) > 0
      or position(lower(v_q) in lower(coalesce(m.shared_subtitle, ''))) > 0
      or (m.attachments is not null and position(lower(v_q) in lower(m.attachments::text)) > 0)
    )
    and (
      v_tag is null
      or m.body ~* ('(^|[^[:alnum:]_])' || v_tag || '($|[^[:alnum:]_])')
    )
  order by m.created_at desc, m.id desc
  limit v_limit;
end $$;

revoke all on function public.search_chat(uuid, text, text, int, timestamptz) from public, anon;
grant execute on function public.search_chat(uuid, text, text, int, timestamptz) to authenticated;
