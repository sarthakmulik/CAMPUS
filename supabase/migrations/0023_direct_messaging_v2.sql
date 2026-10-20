-- =====================================================================
-- 0023 — Direct messaging 2.0: shared CAMPUS content references,
-- premium DM/group features, inbox preferences, receipts, notifications.
--
-- Evolves the SAME chats cluster (0006 + 0008 + 0015 + 0020 + 0022)
-- additively — no parallel messaging system. What is new:
--
--   1. chat_messages.shared_kind / shared_id  — a REFERENCE to existing
--      CAMPUS content (reel/post/profile/listing/event). No duplicate
--      media, no second content table; the referenced record stays the
--      only source of truth. chat_all resolves a safe live preview +
--      honest availability at read time.
--   2. conversation_members.pinned_at / muted / archived_at / cleared_at
--      — per-USER inbox preferences; the other side's list is untouched.
--   3. chat_message_shape extensions (ALTER TYPE … ADD ATTRIBUTE):
--      shared_* preview columns + seen_at / seen_count read receipts.
--   4. send_chat_message rebuilt: DM chat-request status is enforced
--      HERE as well (this SECURITY DEFINER path bypasses RLS, and the
--      "one opening note" rule previously lived only in RLS), voice/
--      audio/video MIME types join the allowlist, and shared content is
--      validated at send time. The 4-argument signature is replaced.
--   5. New RPCs: per-conversation preferences, group management (add /
--      remove / leave / rename + honest system messages), forwarding,
--      cross-chat search, member directory.
--   6. list_conversations rebuilt: previews understand attachments and
--      shared content, honour cleared_at, and return pin/mute/archive
--      state plus DM read-receipt data.
--   7. Notifications: an AFTER INSERT trigger notifies dm/group members
--      about new messages (never your own, never muted chats, blocked
--      users skipped, deduped by notify_member). Clubs keep their
--      mention/reply notifications from send_chat_message.
--
-- Authorization model unchanged: RLS stays ON everywhere; every write
-- that needs judgment goes through SECURITY DEFINER RPCs granted to
-- `authenticated` only. Re-runnable (idempotent).
-- =====================================================================

create extension if not exists pgcrypto;

/* ------------------------------------------------------------------ */
/* 1. Shared content references on chat_messages                       */
/* ------------------------------------------------------------------ */

alter table public.chat_messages
  add column if not exists shared_kind text;
alter table public.chat_messages
  add column if not exists shared_id uuid;

alter table public.chat_messages
  add column if not exists is_system boolean not null default false;

alter table public.chat_messages
  drop constraint if exists chat_messages_shared_kind_check;
alter table public.chat_messages
  add constraint chat_messages_shared_kind_check
  check (
    shared_kind is null
    or shared_kind in ('reel', 'post', 'profile', 'listing', 'event')
  );

alter table public.chat_messages
  drop constraint if exists chat_messages_shared_ref_check;
alter table public.chat_messages
  add constraint chat_messages_shared_ref_check
  check ((shared_kind is null) = (shared_id is null));

/* ------------------------------------------------------------------ */
/* 2. Extend the shared message shape                                  */
/*    ALTER TYPE … ADD ATTRIBUTE appends — the rebuilt chat_all below  */
/*    must output the same attributes in the same appended order.      */
/* ------------------------------------------------------------------ */

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('shared_kind',     'text'),
      ('shared_id',       'uuid'),
      ('shared_title',    'text'),
      ('shared_subtitle', 'text'),
      ('shared_author',   'text'),
      ('shared_image',    'text'),
      ('shared_slug',     'text'),
      ('shared_available','boolean'),
      ('seen_at',         'timestamptz'),
      ('seen_count',      'integer')
    ) as t(attr, typ)
  loop
    if not exists (
      select 1 from pg_attribute a
      join pg_type ty on ty.oid = a.atttypid
      join pg_namespace n on n.oid = ty.typnamespace
      where ty.typname = 'chat_message_shape'
        and n.nspname = 'public'
        and a.attname = r.attr
        and a.attnum > 0
    ) then
      execute format('alter type public.chat_message_shape add attribute %I %s cascade', r.attr, r.typ);
    end if;
  end loop;
end $$;

/* ------------------------------------------------------------------ */
/* 3. Per-USER inbox preferences (never affects the other side)        */
/* ------------------------------------------------------------------ */

-- pinned_at  : pinned to the top of MY list
-- muted      : no new-message notifications for me
-- archived_at: moved to my archive; a new message brings it back
-- cleared_at : "delete for me" — my history and list preview cut off
--              here; the other side's chat is untouched
alter table public.conversation_members
  add column if not exists pinned_at timestamptz;
alter table public.conversation_members
  add column if not exists muted boolean not null default false;
alter table public.conversation_members
  add column if not exists archived_at timestamptz;
alter table public.conversation_members
  add column if not exists cleared_at timestamptz;

create index if not exists conversation_members_user_prefs_idx
  on public.conversation_members (user_id, pinned_at desc nulls last);

/* ------------------------------------------------------------------ */
/* 4. chat_all — the one reader every view uses. Now resolves safe     */
/*    shared-content previews for the READER and read-receipt data.    */
/* ------------------------------------------------------------------ */

drop function if exists public.chat_all(uuid);
create or replace function public.chat_all(p_conversation uuid)
returns setof public.chat_message_shape
language sql stable security definer set search_path = public as $$
  select
    msg.id,
    msg.conversation_id,
    msg.sender_id,
    pr.username,
    coalesce(pr.display_name, 'Student'),
    pr.avatar_url,
    msg.body,
    msg.created_at,
    msg.edited_at,
    msg.deleted_at,
    msg.deleted_by,
    msg.parent_message_id,
    case
      when msg.parent_message_id is null then null
      when par.deleted_at is not null then 'Message unsent'
      else coalesce(par_pr.display_name, par_pr.username, 'Student')
    end,
    case
      when msg.parent_message_id is null or par.deleted_at is not null then null
      else coalesce(nullif(left(par.body, 96), ''), '(attachment)')
    end,
    case when msg.deleted_at is not null then '[]'::jsonb else msg.attachments end,
    case when msg.deleted_at is not null then '{}'::jsonb else msg.reactions end,
    case when msg.deleted_at is not null then null else msg.pinned_at end,
    case when msg.deleted_at is not null then 0 else (
      select count(*) from public.chat_messages r
      where r.parent_message_id = msg.id and r.deleted_at is null
    ) end,
    /* ---- shared-content preview (resolved live for the reader) ------ */
    msg.shared_kind,
    case when msg.deleted_at is not null then null else msg.shared_id end,
    case msg.shared_kind
      when 'reel'    then coalesce(nullif(left(sp.body, 80), ''), 'Reel')
      when 'post'    then coalesce(nullif(left(sp.body, 80), ''), 'Post')
      when 'profile' then coalesce(pf.display_name, 'Student')
      when 'listing' then ml.title
      when 'event'   then ev.title
      else null
    end,
    /* accent line under the title */
    case msg.shared_kind
      when 'reel'  then coalesce(pf.display_name, pf.username, 'Anonymous')
      when 'post'  then coalesce(pf.display_name, pf.username, 'Anonymous')
      when 'profile' then '@' || coalesce(pf.username, 'student')
      when 'listing' then ml.category
      when 'event'   then coalesce(ev.venue, to_char(ev.starts_at, 'DD Mon YYYY'))
      else null
    end,
    /* original creator attribution */
    case msg.shared_kind
      when 'reel'  then case when sp.is_anonymous then null else pf.display_name end
      when 'post'  then case when sp.is_anonymous then null else pf.display_name end
      when 'listing' then coalesce(ml_pr.display_name, ml_pr.username)
      when 'event'   then coalesce(ev_pr.display_name, ev_pr.username)
      else null
    end,
    case msg.shared_kind
      when 'reel'  then sp.media_urls[1]
      when 'post'  then sp.media_urls[1]
      when 'profile' then pf.avatar_url
      when 'listing' then ml.images[1]
      when 'event'   then ev.cover_url
      else null
    end,
    case msg.shared_kind
      when 'listing' then ml.slug
      when 'event'   then ev.slug
      else null
    end,
    /* is the referenced content still available for THIS reader? */
    case msg.shared_kind
      when 'reel'  then sp.is_published
      when 'post'  then sp.is_published
      when 'profile' then coalesce(not pf.is_private or pf.id = auth.uid(), false)
      when 'listing' then ml.status = 'active' and ml.moderation_status = 'clean'
      when 'event'   then coalesce(ev.published, true)
      else false
    end,
    /* ---- read receipts: did (someone else in this chat) read it? ---- */
    case when msg.sender_id is not null then (
      select max(m2.last_read_at) from public.conversation_members m2
      where m2.conversation_id = msg.conversation_id
        and m2.user_id <> msg.sender_id
    ) end,
    case when msg.sender_id is not null then (
      select count(*) from public.conversation_members m2
      where m2.conversation_id = msg.conversation_id
        and m2.user_id <> msg.sender_id
        and m2.last_read_at >= msg.created_at
    ) else 0 end
  from public.chat_messages msg
  left join public.profiles pr on pr.id = msg.sender_id
  left join public.chat_messages par on par.id = msg.parent_message_id
  left join public.profiles par_pr on par_pr.id = par.sender_id
  /* shared-content joins — all keyed so the plain path stays cheap */
  left join public.posts sp
    on msg.shared_kind in ('reel', 'post') and sp.id = msg.shared_id
  left join public.profiles pf on pf.id = case
    when msg.shared_kind in ('reel', 'post') then sp.author_id
    when msg.shared_kind = 'profile' then msg.shared_id
  end
  left join public.marketplace_listings ml
    on msg.shared_kind = 'listing' and ml.id = msg.shared_id
  left join public.profiles ml_pr on ml_pr.id = ml.owner_id
  left join public.events ev
    on msg.shared_kind = 'event' and ev.id = msg.shared_id
  left join public.profiles ev_pr on ev_pr.id = ev.created_by
  where msg.conversation_id = p_conversation
    and auth.uid() in (
      select user_id from public.conversation_members
      where conversation_id = p_conversation
    )
  order by msg.created_at desc, msg.id desc
$$;

/* ------------------------------------------------------------------ */
/* 5. Sending: rebuilt with DM request enforcement, voice/video MIME   */
/*    types and shared-content validation. The 4-argument signature    */
/*    from 0020/0022 is dropped — the client always passes 6 named     */
/*    arguments, defaults exist for older callers.                     */
/* ------------------------------------------------------------------ */

drop function if exists public.send_chat_message(uuid, text, uuid, jsonb);

create or replace function public.send_chat_message(
  p_conversation uuid,
  p_body text,
  p_parent_id uuid default null,
  p_attachments jsonb default '[]'::jsonb,
  p_shared_kind text default null,
  p_shared_id uuid default null
)
returns setof public.chat_message_shape
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_body text;
  v_club uuid;
  v_kind text;
  v_status text;
  v_created_by uuid;
  v_member boolean;
  v_attachments jsonb := '[]'::jsonb;
  v_att jsonb;
  v_parent record;
  v_parent_id uuid;
  v_id uuid;
  v_recent int;
  v_tags text[];
  v_mentioned uuid;
  v_college uuid;
begin
  if v_me is null then
    raise exception 'Sign in to send messages.';
  end if;

  select con.club_id, con.kind, con.status, con.created_by, exists (
    select 1 from public.conversation_members m
    where m.conversation_id = con.id and m.user_id = v_me
  ) into v_club, v_kind, v_status, v_created_by, v_member
  from public.conversations con
  where con.id = p_conversation;

  -- the existence of the conversation row matters as much as the seat:
  -- a select-into on an unknown id would otherwise pass with NULL
  if not found or not v_member then
    raise exception 'You are not part of this conversation.';
  end if;

  -- chat-request rules enforced here too: this RPC is SECURITY DEFINER,
  -- so RLS cannot be the only guard for the pending/declined states.
  if v_status is distinct from 'accepted' then
    if v_kind = 'dm' and v_status = 'pending' then
      -- the requester may push exactly ONE opening note through
      if v_created_by <> v_me
        or exists (
          select 1 from public.chat_messages m
          where m.conversation_id = p_conversation and m.sender_id = v_me
        ) then
        raise exception 'Chat request sent — % needs to accept before you can send more.', coalesce(
          (select coalesce(prx.display_name, prx.username, 'your classmate')
             from public.conversation_members mm
             join public.profiles prx on prx.id = mm.user_id
             where mm.conversation_id = p_conversation and mm.user_id <> v_me
             limit 1), 'your classmate');
      end if;
    elsif v_kind = 'dm' and v_status = 'declined' then
      raise exception 'This chat request was declined — sending is closed.';
    else
      raise exception 'This conversation is not open yet.';
    end if;
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

  -- attachments: ≤ 4, known types, ≤ 25 MB, folder of THIS conversation.
  -- audio/* makes voice messages possible; video/* joins ordinary chat
  -- attachments (reels are never re-uploaded — they are referenced).
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
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'video/mp4', 'video/webm', 'video/quicktime',
        'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'
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

  -- shared content: a REFERENCE to existing CAMPUS content the sender can
  -- actually see (posts/reels published, listings live, events visible to
  -- the sender). The recipient's access is re-checked at read time.
  if p_shared_kind is not null then
    if p_shared_kind not in ('reel', 'post', 'profile', 'listing', 'event')
      or p_shared_id is null then
      raise exception 'That content cannot be shared.';
    end if;
    if jsonb_array_length(v_attachments) > 0 then
      raise exception 'A shared card cannot carry file attachments too.';
    end if;
    if p_parent_id is not null then
      raise exception 'A shared card cannot be a reply at the same time.';
    end if;

    select coalesce(cpr.college_id, null) into v_college
    from public.profiles cpr where cpr.id = v_me;

    if p_shared_kind in ('reel', 'post') then
      if not exists (
        select 1 from public.posts sp
        where sp.id = p_shared_id and sp.is_published = true
      ) then
        raise exception 'That content is not available.';
      end if;
    elsif p_shared_kind = 'profile' then
      if not exists (
        select 1 from public.profiles pp where pp.id = p_shared_id
      ) then
        raise exception 'That profile is not available.';
      end if;
    elsif p_shared_kind = 'listing' then
      if not exists (
        select 1 from public.marketplace_listings ml
        where ml.id = p_shared_id and ml.status = 'active'
          and ml.moderation_status = 'clean'
          and (ml.owner_id = v_me
            or ml.audience = 'global'
            or (ml.college_id is not null and ml.college_id = v_college))
      ) then
        raise exception 'That listing is not available to share.';
      end if;
    elsif p_shared_kind = 'event' then
      if not exists (
        select 1 from public.events ev
        where ev.id = p_shared_id and coalesce(ev.published, true)
          and (ev.created_by = v_me
            or ev.audience = 'public'
            or (ev.audience = 'college' and ev.college_id is not null and ev.college_id = v_college)
            or (ev.audience = 'community' and ev.club_id is not null
              and public.is_club_active_member(ev.club_id, v_me)))
      ) then
        raise exception 'That event is not available to share.';
      end if;
    end if;
  end if;

  v_body := nullif(trim(coalesce(p_body, '')), '');
  if v_body is null and jsonb_array_length(v_attachments) = 0 and p_shared_kind is null then
    raise exception 'Write something first.';
  end if;
  if v_body is not null and char_length(v_body) > 2000 then
    raise exception 'Messages can be at most 2000 characters.';
  end if;

  -- reply integrity: target must exist, live in the SAME conversation and not
  -- be a tombstone. A reply always binds to its thread's ROOT (one flat level:
  -- replying to a reply joins that exchange instead of nesting deeper).
  if p_parent_id is not null then
    select pm.id, pm.parent_message_id into v_parent
    from public.chat_messages pm
    where pm.id = p_parent_id
      and pm.conversation_id = p_conversation
      and pm.deleted_at is null;
    if v_parent is null then
      raise exception 'That message can no longer be replied to.';
    end if;
    if v_parent.parent_message_id is not null then
      p_parent_id := v_parent.parent_message_id;
    else
      p_parent_id := v_parent.id;
    end if;
    v_parent_id := p_parent_id;
  end if;

  insert into public.chat_messages (conversation_id, sender_id, body, parent_message_id, attachments, shared_kind, shared_id)
  values (p_conversation, v_me, v_body, v_parent_id, v_attachments, p_shared_kind, p_shared_id)
  returning id into v_id;

  -- mentions: club channels only — only ACTIVE members of THIS community
  -- get a notification — deduped by notify_member. DM/group notifications
  -- come exclusively from the message trigger (section 10).
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
      end if;
    end loop;
  end if;

  return query
  select m.* from public.chat_all(p_conversation) m where m.id = v_id;
end $$;

-- 0020/0022 versions of send_chat_message and chat_all are superseded
-- by the definitions in THIS migration from 0023 onwards.

/* ------------------------------------------------------------------ */
/* 6. Per-conversation preferences (per user; never the other side)    */
/* ------------------------------------------------------------------ */

create or replace function public.set_conversation_prefs(
  p_conversation uuid,
  p_action text
)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_mark timestamptz;
begin
  if v_me is null then
    raise exception 'Sign in first.';
  end if;
  if not public.is_conversation_member(p_conversation) then
    raise exception 'You are not part of this conversation.';
  end if;

  case p_action
    when 'pin' then
      update public.conversation_members
        set pinned_at = now(), archived_at = null
      where conversation_id = p_conversation and user_id = v_me;
    when 'unpin' then
      update public.conversation_members
        set pinned_at = null
      where conversation_id = p_conversation and user_id = v_me;
    when 'mute' then
      update public.conversation_members
        set muted = true
      where conversation_id = p_conversation and user_id = v_me;
    when 'unmute' then
      update public.conversation_members
        set muted = false
      where conversation_id = p_conversation and user_id = v_me;
    when 'archive' then
      update public.conversation_members
        set archived_at = now(), pinned_at = null
      where conversation_id = p_conversation and user_id = v_me;
    when 'unarchive' then
      update public.conversation_members
        set archived_at = null
      where conversation_id = p_conversation and user_id = v_me;
    when 'mark_unread' then
      /* the latest messages from the others become "unread" again */
      select max(created_at) - interval '1 microsecond' into v_mark
      from public.chat_messages msg
      where msg.conversation_id = p_conversation
        and msg.sender_id is distinct from v_me
        and msg.deleted_at is null;
      if v_mark is not null then
        update public.conversation_members
          set last_read_at = v_mark
          where conversation_id = p_conversation and user_id = v_me;
      end if;
    when 'clear' then
      /* delete for me: my view cuts off here; the others keep theirs */
      update public.conversation_members
        set cleared_at = now(), last_read_at = now()
      where conversation_id = p_conversation and user_id = v_me;
    else
      raise exception 'Unknown conversation action.';
  end case;

  return coalesce(
    (select m.last_read_at from public.conversation_members m
      where m.conversation_id = p_conversation and m.user_id = v_me),
    now()
  );
end $$;

/* ------------------------------------------------------------------ */
/* 7. Group management: member directory, add/remove/leave/rename      */
/* ------------------------------------------------------------------ */

create or replace function public.get_conversation_members(p_conversation uuid)
returns table (
  user_id uuid,
  username text,
  display_name text,
  avatar_url text,
  role text,
  joined_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select m.user_id, pr.username, coalesce(pr.display_name, pr.username, 'Student'),
         pr.avatar_url, m.role, m.joined_at
  from public.conversation_members m
  join public.profiles pr on pr.id = m.user_id
  where m.conversation_id = p_conversation
    and public.is_conversation_member(p_conversation)
  order by (m.role = 'admin') desc, pr.username
  limit 100
$$;

create or replace function public.add_group_members(
  p_conversation uuid,
  p_user_ids uuid[]
)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_kind text;
  v_added int := 0;
  v_names text[] := '{}';
  v_name text;
  u uuid;
  v_actor text;
begin
  if v_me is null then
    raise exception 'Sign in first.';
  end if;
  select cm.role, con.kind into v_role, v_kind
  from public.conversation_members cm
  join public.conversations con on con.id = cm.conversation_id
  where cm.conversation_id = p_conversation and cm.user_id = v_me;
  if v_role is null then
    raise exception 'You are not part of this conversation.';
  end if;
  if v_kind <> 'group' then
    raise exception 'Only group chats can take new members.';
  end if;
  if v_role <> 'admin' then
    raise exception 'Only the group admin can add members.';
  end if;

  if (select count(*) from public.conversation_members where conversation_id = p_conversation)
    + coalesce(array_length(array(select distinct u0 from unnest(coalesce(p_user_ids, '{}')) u0 where u0 is not null and u0 <> v_me), 1), 0)
    > 50 then
    raise exception 'A group can hold up to 50 classmates.';
  end if;

  for u in select distinct un from unnest(coalesce(p_user_ids, '{}')) un
    where un is not null and un <> v_me loop
    if exists (select 1 from public.user_blocks b
      where (b.blocker_id = u and b.blocked_id = v_me)
         or (b.blocker_id = v_me and b.blocked_id = u)) then
      continue; -- blocked pairs stay invisible to each other, like ghosts
    end if;
    insert into public.conversation_members (conversation_id, user_id)
      values (p_conversation, u)
    on conflict (conversation_id, user_id) do nothing;
    if found then
      select coalesce(pr.display_name, pr.username, 'a classmate') into v_name
      from public.profiles pr where pr.id = u;
      v_names := v_names || coalesce(v_name, 'a classmate');
      v_added := v_added + 1;
    end if;
  end loop;

  -- a system line keeps the group's history honest
  if v_added > 0 then
    select coalesce(pr.display_name, pr.username, 'A classmate') into v_actor
    from public.profiles pr where pr.id = v_me;
    insert into public.chat_messages (conversation_id, sender_id, is_system, body)
    values (p_conversation, v_me, true,
      case when v_added = 1
        then v_actor || ' added ' || v_names[1]
        else v_actor || ' added ' || v_added || ' classmates'
      end);
  end if;

  return v_added;
end $$;

create or replace function public.remove_group_member(
  p_conversation uuid,
  p_user_id uuid
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_kind text;
  v_name text;
  v_actor text;
begin
  if v_me is null then
    raise exception 'Sign in first.';
  end if;
  select cm.role, con.kind into v_role, v_kind
  from public.conversation_members cm
  join public.conversations con on con.id = cm.conversation_id
  where cm.conversation_id = p_conversation and cm.user_id = v_me;
  if v_role is null or v_role <> 'admin' or v_kind <> 'group' then
    raise exception 'Only the group admin can remove members.';
  end if;
  if p_user_id = v_me then
    raise exception 'Use “Leave group” to remove yourself.';
  end if;

  delete from public.conversation_members
    where conversation_id = p_conversation and user_id = p_user_id;
  if found then
    select coalesce(pr.display_name, pr.username, 'A classmate') into v_name
      from public.profiles pr where pr.id = p_user_id;
    select coalesce(pr.display_name, pr.username, 'The admin') into v_actor
      from public.profiles pr where pr.id = v_me;
    insert into public.chat_messages (conversation_id, sender_id, is_system, body)
    values (p_conversation, v_me, true, v_actor || ' removed ' || coalesce(v_name, 'a classmate'));
  end if;
end $$;

create or replace function public.leave_group(p_conversation uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_next uuid;
begin
  if v_me is null then
    raise exception 'Sign in first.';
  end if;
  if not public.is_conversation_member(p_conversation) then
    raise exception 'You are not part of this conversation.';
  end if;

  -- keep an honest system line on the way out
  insert into public.chat_messages (conversation_id, sender_id, is_system, body)
  values (p_conversation, v_me, true,
    coalesce((select pr.display_name from public.profiles pr where pr.id = v_me), 'A classmate')
    || ' left the group');

  delete from public.conversation_members
    where conversation_id = p_conversation and user_id = v_me;

  -- if the last admin left, promote the earliest remaining member so the
  -- group stays manageable
  if exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation
  ) and not exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation and role = 'admin'
  ) then
    select user_id into v_next
    from public.conversation_members
    where conversation_id = p_conversation
    order by joined_at asc, user_id asc
    limit 1;
    update public.conversation_members
      set role = 'admin'
      where conversation_id = p_conversation and user_id = v_next;
  end if;
end $$;

create or replace function public.rename_group(
  p_conversation uuid,
  p_title text
)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_old text;
  v_title text;
begin
  if v_me is null then
    raise exception 'Sign in first.';
  end if;
  v_title := nullif(btrim(coalesce(p_title, '')), '');
  if v_title is null then
    raise exception 'A group needs a name.';
  end if;
  if char_length(v_title) > 60 then
    raise exception 'Group names can be at most 60 characters.';
  end if;
  select cm.role, con.title into v_role, v_old
  from public.conversation_members cm
  join public.conversations con on con.id = cm.conversation_id
  where cm.conversation_id = p_conversation and cm.user_id = v_me
    and con.kind = 'group';
  if v_role is null or v_role <> 'admin' then
    raise exception 'Only the group admin can rename the group.';
  end if;
  if v_old = v_title then
    return v_old;
  end if;

  update public.conversations set title = v_title where id = p_conversation;
  insert into public.chat_messages (conversation_id, sender_id, is_system, body)
  values (p_conversation, v_me, true,
    coalesce((select pr.display_name from public.profiles pr where pr.id = v_me), 'The admin')
    || ' renamed this group to “' || v_title || '”');
  return v_title;
end $$;

/* ------------------------------------------------------------------ */
/* 8. Forwarding a message into another of your conversations          */
/* ------------------------------------------------------------------ */

create or replace function public.forward_chat_message(
  p_message uuid,
  p_target uuid,
  p_attachments jsonb default null
)
returns setof public.chat_message_shape
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_src record;
  v_status text;
  v_created_by uuid;
  v_kind text;
  v_member boolean;
  v_att jsonb := '[]'::jsonb;
  v_att_item jsonb;
  v_id uuid;
begin
  if v_me is null then
    raise exception 'Sign in first.';
  end if;

  -- the source message must live in one of MY conversations and still
  -- have content; unsent and system rows never travel
  select msg.* into v_src
  from public.chat_messages msg
  join public.conversation_members cm on cm.conversation_id = msg.conversation_id
  where msg.id = p_message and cm.user_id = v_me and cm.conversation_id <> p_target;
  if v_src is null then
    raise exception 'That message is not yours to forward.';
  end if;
  if v_src.deleted_at is not null or v_src.is_system then
    raise exception 'That message cannot be forwarded.';
  end if;

  -- the target must be one of MY open conversations, with the same
  -- chat-request rules as a normal send
  select con.status, con.created_by, con.kind, exists (
    select 1 from public.conversation_members m
    where m.conversation_id = con.id and m.user_id = v_me
  ) into v_status, v_created_by, v_kind, v_member
  from public.conversations con where con.id = p_target;
  if not found or not v_member then
    raise exception 'You are not part of that conversation.';
  end if;
  if v_status is distinct from 'accepted' then
    if not (v_kind = 'dm' and v_status = 'pending' and v_created_by = v_me
      and not exists (
        select 1 from public.chat_messages m
        where m.conversation_id = p_target and m.sender_id = v_me
      )) then
      raise exception 'That conversation is not open for new messages.';
    end if;
  end if;

  -- attachments: ONLY freshly copied paths inside the TARGET folder (the
  -- client copies the objects first); raw reuse of another chat's files
  -- would leak them to non-members of the source conversation
  if v_src.attachments is not null and jsonb_array_length(v_src.attachments) > 0 then
    if p_attachments is null or jsonb_typeof(p_attachments) <> 'array'
      or jsonb_array_length(p_attachments) = 0 then
      raise exception 'Copy the files into this conversation before forwarding.';
    end if;
    if jsonb_array_length(p_attachments) > 4 then
      raise exception 'A message can carry at most 4 attachments.';
    end if;
    for v_att_item in select * from jsonb_array_elements(p_attachments) loop
      if not (v_att_item ? 'path' and v_att_item ? 'name') then
        raise exception 'That attachment is incomplete.';
      end if;
      if (v_att_item->>'path') !~ ('^' || p_target::text || '/.+') then
        raise exception 'That attachment does not belong to this conversation.';
      end if;
      if coalesce((v_att_item->>'size')::numeric, 0) <= 0
        or coalesce((v_att_item->>'size')::numeric, 0) > 26214400 then
        raise exception 'Attachments can be at most 25 MB.';
      end if;
      v_att := v_att || jsonb_build_object(
        'path', v_att_item->>'path',
        'name', left(v_att_item->>'name', 180),
        'mime', v_att_item->>'mime',
        'size', (v_att_item->>'size')::numeric
      );
    end loop;
  end if;

  -- shared references travel, but the referenced record must still exist
  if v_src.shared_kind is not null then
    if v_src.shared_kind in ('reel', 'post') then
      if not exists (select 1 from public.posts sp
        where sp.id = v_src.shared_id and sp.is_published = true) then
        raise exception 'That content is not available anymore.';
      end if;
    elsif v_src.shared_kind = 'profile' then
      if not exists (select 1 from public.profiles pp where pp.id = v_src.shared_id) then
        raise exception 'That profile is not available anymore.';
      end if;
    elsif v_src.shared_kind = 'listing' then
      if not exists (select 1 from public.marketplace_listings ml
        where ml.id = v_src.shared_id and ml.status = 'active'
          and ml.moderation_status = 'clean') then
        raise exception 'That listing is not available anymore.';
      end if;
    elsif v_src.shared_kind = 'event' then
      if not exists (select 1 from public.events ev
        where ev.id = v_src.shared_id and coalesce(ev.published, true)) then
        raise exception 'That event is not available anymore.';
      end if;
    end if;
  end if;

  insert into public.chat_messages (conversation_id, sender_id, body, attachments, shared_kind, shared_id)
  values (p_target, v_me, v_src.body, v_att, v_src.shared_kind, v_src.shared_id)
  returning id into v_id;

  return query
  select m.* from public.chat_all(p_target) m where m.id = v_id;
end $$;

/* ------------------------------------------------------------------ */
/* 9. Cross-chat search: your messages across all your conversations   */
/* ------------------------------------------------------------------ */

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
    coalesce(sp.display_name, sp.username, 'Student'),
    msg.body,
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
  left join public.profiles sp on sp.id = msg.sender_id
  where msg.deleted_at is null
    and msg.body is not null
    and msg.body ilike v_q
    and con.kind in ('dm', 'group', 'club')
  order by msg.created_at desc, msg.id desc
  limit v_limit;
end $$;

/* ------------------------------------------------------------------ */
/* 10. Notifications: dm/group new messages (trigger)                  */
/* ------------------------------------------------------------------ */

create or replace function public.notify_chat_message()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_kind text;
  v_status text;
  r record;
begin
  if new.is_system or new.sender_id is null then
    return null;
  end if;

  select con.kind, con.status into v_kind, v_status
  from public.conversations con
  where con.id = new.conversation_id;
  if v_kind = 'club' or v_status is distinct from 'accepted' then
    return null; -- clubs keep their mention/reply notifications from send_chat_message;
                 -- pending/declined requests surface in the Chats list itself
  end if;

  for r in
    select m.user_id
    from public.conversation_members m
    where m.conversation_id = new.conversation_id
      and m.user_id <> new.sender_id
      and m.muted = false
      and not exists (
        select 1 from public.user_blocks b
        where (b.blocker_id = m.user_id and b.blocked_id = new.sender_id)
           or (b.blocker_id = new.sender_id and b.blocked_id = m.user_id)
      )
  loop
    perform public.notify_member(
      r.user_id, new.sender_id, 'chat_message',
      case v_kind when 'dm' then 'dm_chat' else 'group_chat' end,
      new.conversation_id
    );
  end loop;

  return null;
end $$;

drop trigger if exists chat_messages_notify on public.chat_messages;
create trigger chat_messages_notify
  after insert on public.chat_messages
  for each row execute function public.notify_chat_message();

/* ------------------------------------------------------------------ */
/* 11. list_conversations — previews, prefs, receipts                  */
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
  archived boolean
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
    m.archived_at is not null
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

/* ------------------------------------------------------------------ */
/* 12. Grants: authenticated only, nothing for anon or public          */
/* ------------------------------------------------------------------ */

revoke all on function public.chat_all(uuid) from public, anon;
revoke all on function public.send_chat_message(uuid, text, uuid, jsonb, text, uuid) from public, anon;
revoke all on function public.set_conversation_prefs(uuid, text) from public, anon;
revoke all on function public.get_conversation_members(uuid) from public, anon;
revoke all on function public.add_group_members(uuid, uuid[]) from public, anon;
revoke all on function public.remove_group_member(uuid, uuid) from public, anon;
revoke all on function public.leave_group(uuid) from public, anon;
revoke all on function public.rename_group(uuid, text) from public, anon;
revoke all on function public.forward_chat_message(uuid, uuid, jsonb) from public, anon;
revoke all on function public.search_all_chats(text, int) from public, anon;
revoke all on function public.list_conversations() from public, anon;

grant execute on function public.chat_all(uuid) to authenticated;
grant execute on function public.send_chat_message(uuid, text, uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.set_conversation_prefs(uuid, text) to authenticated;
grant execute on function public.get_conversation_members(uuid) to authenticated;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
grant execute on function public.rename_group(uuid, text) to authenticated;
grant execute on function public.forward_chat_message(uuid, uuid, jsonb) to authenticated;
grant execute on function public.search_all_chats(text, int) to authenticated;
grant execute on function public.list_conversations() to authenticated;
