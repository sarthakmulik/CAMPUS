-- =====================================================================
-- 0020 — Community chat 2.0: replies, reactions, attachments, pins,
--                       moderation, mention/tag search
--
-- Evolves the existing chats cluster (0006 + 0015 + 0016) additively. No
-- duplicate tables, no parallel messaging system: the community channel is
-- still conversations.kind = 'club', one conversation per community.
--
-- 0023 note: the send_chat_message / chat_all / list_conversations
-- definitions in THIS file are SUPERSEDED by 0023_direct_messaging_v2.sql,
-- which rebuilds them (chat-request enforcement, shared content, receipts,
-- voice/video MIME types). Run 0020/0022 first, then 0023 — 0023 always wins.
--
-- New on chat_messages (all columns additive, existing data untouched):
--   parent_message_id  — one-level replies; a reply always binds to its
--                        thread's ROOT so threads stay flat and readable
--   attachments        — jsonb [{path,name,mime,size}] in a PRIVATE bucket
--   reactions          — jsonb {"👍": [user ids…]} through an RPC only
--   pinned_at/pinned_by— moderator pinning
--   deleted_by         — distinguishes an unsend from a moderator removal
--
-- Authorization model: every write that needs judgment (reply integrity,
-- reaction state, attachments, pins, moderation, mentions) goes through
-- SECURITY DEFINER RPCs granted to authenticated only. RLS stays ON; the
-- existing member-only message policies stay exactly as they were.
-- Idempotent: safe to re-run.
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

/* ------------------------------------------------------------------ */
/* 1. Columns + constraints + indexes                                  */
/* ------------------------------------------------------------------ */

alter table public.chat_messages add column if not exists parent_message_id uuid;
alter table public.chat_messages add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.chat_messages add column if not exists reactions jsonb not null default '{}'::jsonb;
alter table public.chat_messages add column if not exists pinned_at timestamptz;
alter table public.chat_messages add column if not exists pinned_by uuid references auth.users (id) on delete set null;
alter table public.chat_messages add column if not exists deleted_by uuid references auth.users (id) on delete set null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_parent_fk') then
    alter table public.chat_messages
      add constraint chat_messages_parent_fk
      foreign key (parent_message_id) references public.chat_messages (id) on delete set null;
  end if;
end $$;

-- a normal message needs non-empty body ≤ 2000, OR 1..4 attachments with an
-- optional caption; body-less rows are tombstones and stay legal (the 0006
-- check passed null through char_length, unchanged behaviour)
alter table public.chat_messages drop constraint if exists chat_messages_body_len;
alter table public.chat_messages drop constraint if exists chat_messages_body_check;
alter table public.chat_messages add constraint chat_messages_body_check
  check (
    (body is null and jsonb_array_length(attachments) = 0)          -- tombstone
    or (jsonb_array_length(attachments) between 1 and 4 and char_length(body) <= 2000)
    or (char_length(body) between 1 and 2000)
  );

create index if not exists chat_messages_parent_idx
  on public.chat_messages (parent_message_id) where parent_message_id is not null;
create index if not exists chat_messages_conversation_pinned_idx
  on public.chat_messages (conversation_id, pinned_at desc) where pinned_at is not null;
create index if not exists chat_messages_body_trgm_idx
  on public.chat_messages using gin (body gin_trgm_ops) where deleted_at is null;

/* ------------------------------------------------------------------ */
/* 2. The shared message shape (composite type, reused by every reader)*/
/* ------------------------------------------------------------------ */

do $$ begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'chat_message_shape' and n.nspname = 'public'
  ) then
    create type public.chat_message_shape as (
      id uuid,
      conversation_id uuid,
      sender_id uuid,
      sender_username text,
      sender_display_name text,
      sender_avatar_url text,
      body text,
      created_at timestamptz,
      edited_at timestamptz,
      deleted_at timestamptz,
      deleted_by uuid,
      parent_message_id uuid,
      parent_author_name text,
      parent_excerpt text,
      attachments jsonb,
      reactions jsonb,
      pinned_at timestamptz,
      reply_count int
    );
  end if;
end $$;

/* ------------------------------------------------------------------ */
/* 3. Private attachment bucket — member-owned folders                 */
/*    Objects live under `<conversation_id>/<random>-<name>`; the      */
/*    public `media` bucket is NOT used for chat.                      */
/* ------------------------------------------------------------------ */

insert into storage.buckets (id, name, public)
values ('chat-media', 'chat-media', false)
on conflict (id) do nothing;

-- text → uuid without raising on stray folder names of other buckets
create or replace function public.uuid_or_null(raw text)
returns uuid language plpgsql stable as $$
begin
  begin
    return raw::uuid;
  exception when others then
    return null;
  end;
end $$;

drop policy if exists "chat media members read" on storage.objects;
create policy "chat media members read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-media'
    and public.is_conversation_member(public.uuid_or_null((storage.foldername(name))[1]))
  );

drop policy if exists "chat media members upload" on storage.objects;
create policy "chat media members upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and public.is_conversation_member(public.uuid_or_null((storage.foldername(name))[1]))
    and coalesce((metadata->>'size')::numeric, 0) <= 26214400  -- 25 MB
  );

drop policy if exists "chat media uploader or moderator deletes" on storage.objects;
create policy "chat media uploader or moderator deletes" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat-media'
    and (
      owner_id = auth.uid()::text
      or public.is_club_moderator(
        (
          select con.club_id from public.conversations con
          where con.id = public.uuid_or_null((storage.foldername(name))[1])
        ),
        auth.uid()
      )
    )
  );

/* ------------------------------------------------------------------ */
/* 4. chat_all — the one reader every list/search/thread/pin view uses */
/*    Members only; tombstones carry no body, attachments or reactions. */
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
    ) end
  from public.chat_messages msg
  left join public.profiles pr on pr.id = msg.sender_id
  left join public.chat_messages par on par.id = msg.parent_message_id
  left join public.profiles par_pr on par_pr.id = par.sender_id
  where msg.conversation_id = p_conversation
    and auth.uid() in (
      select user_id from public.conversation_members
      where conversation_id = p_conversation
    )
  order by msg.created_at desc, msg.id desc
$$;

/* ------------------------------------------------------------------ */
/* 5. Paginated history (cursor = created_at; stable `id` tiebreak)     */
/* ------------------------------------------------------------------ */

drop function if exists public.list_chat_messages(uuid, int, timestamptz);
create or replace function public.list_chat_messages(
  p_conversation uuid,
  p_limit int default 40,
  p_before timestamptz default null
)
returns setof public.chat_message_shape
language sql stable security definer set search_path = public as $$
  select m.* from public.chat_all(p_conversation) m
  where (p_before is null or m.created_at < p_before)
  limit greatest(least(coalesce(p_limit, 40), 100), 1)
$$;

/* ------------------------------------------------------------------ */
/* 6. Sending: one trusted path for text, replies, attachments,        */
/*    mentions and reply notifications                                 */
/* ------------------------------------------------------------------ */

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
  -- the conversation ROW existing matters as much as the seat: a select-into
  -- on an unknown id would otherwise pass with a NULL membership and insert
  -- an orphan row
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

/* ------------------------------------------------------------------ */
/* 7. Reactions: atomic toggle in the message row itself — the         */
/*    existing chat_messages realtime UPDATE channel carries them      */
/* ------------------------------------------------------------------ */

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
    -- jsonb minus takes a TEXT key (never another jsonb value)
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

/* ------------------------------------------------------------------ */
/* 8. Edit / unsend / moderator remove                                 */
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

  update public.chat_messages
    set body = null, deleted_at = now(), deleted_by = v_me,
        attachments = '[]'::jsonb, reactions = '{}'::jsonb, pinned_at = null
  where public.chat_messages.id = p_message;

  return now();
end $$;

-- sender self-removal or community-moderator removal. deleted_by <> sender
-- lets the client show an honest "removed by moderators" tombstone.
create or replace function public.moderate_delete_chat_message(p_message uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg record;
begin
  if v_me is null then
    raise exception 'Sign in first.';
  end if;

  select msg.sender_id, msg.deleted_at, con.club_id into v_msg
  from public.chat_messages msg
  join public.conversations con on con.id = msg.conversation_id
  where msg.id = p_message;

  if v_msg is null or v_msg.deleted_at is not null then
    raise exception 'That message does not exist.';
  end if;
  if v_msg.sender_id <> v_me
    and (v_msg.club_id is null or not public.is_club_moderator(v_msg.club_id, v_me)) then
    raise exception 'Only the sender or a community moderator can remove a message.';
  end if;

  update public.chat_messages
    set body = null, deleted_at = now(), deleted_by = v_me,
        attachments = '[]'::jsonb, reactions = '{}'::jsonb, pinned_at = null
  where public.chat_messages.id = p_message;

  return now();
end $$;

/* ------------------------------------------------------------------ */
/* 9. Pins (community moderators) + the pinned banner                  */
/* ------------------------------------------------------------------ */

create or replace function public.set_chat_message_pin(p_message uuid, p_pinned boolean)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg record;
begin
  if v_me is null then
    raise exception 'Sign in first.';
  end if;

  select msg.deleted_at, con.club_id into v_msg
  from public.chat_messages msg
  join public.conversations con on con.id = msg.conversation_id
  where msg.id = p_message;

  if v_msg is null or v_msg.club_id is null then
    raise exception 'Pinning works only inside community chats.';
  end if;
  if not public.is_club_moderator(v_msg.club_id, v_me) then
    raise exception 'Only owners and moderators pin messages.';
  end if;
  if v_msg.deleted_at is not null then
    raise exception 'Unsent messages cannot be pinned.';
  end if;

  update public.chat_messages
    set pinned_at = case when p_pinned then now() else null end,
        pinned_by = case when p_pinned then v_me else null end
  where public.chat_messages.id = p_message;

  return case when p_pinned then now() else null end;
end $$;

-- the pinned banner: newest pins of this conversation
create or replace function public.list_chat_pins(p_conversation uuid)
returns setof public.chat_message_shape
language sql stable security definer set search_path = public as $$
  select m.* from public.chat_all(p_conversation) m
  where m.pinned_at is not null and m.deleted_at is null
  order by m.pinned_at desc
  limit 3
$$;

/* ------------------------------------------------------------------ */
/* 10. Thread view: the root + every message bound to it, oldest first */
/* ------------------------------------------------------------------ */

create or replace function public.list_chat_thread(p_message uuid)
returns setof public.chat_message_shape
language plpgsql stable security definer set search_path = public as $$
declare
  v_root uuid;
  v_conversation uuid;
begin
  select case
    when m.parent_message_id is not null then m.parent_message_id
    else m.id
  end, m.conversation_id into v_root, v_conversation
  from public.chat_messages m where m.id = p_message;

  if v_root is null then
    raise exception 'That message does not exist.';
  end if;
  if not public.is_conversation_member(v_conversation) then
    raise exception 'You are not part of this conversation.';
  end if;

  return query
  select m.* from public.chat_all(v_conversation) m
  where m.id = v_root or m.parent_message_id = v_root
  order by (m.id <> v_root), m.created_at asc, m.id asc
  limit 201;
end $$;

/* ------------------------------------------------------------------ */
/* 11. Search: text + author + hashtag, never beyond membership        */
/* ------------------------------------------------------------------ */

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

  return query
  select m.* from public.chat_all(p_conversation) m
  where m.deleted_at is null
    and (p_before is null or m.created_at < p_before)
    and (
      v_q is null
      or (m.body is not null and position(lower(v_q) in lower(m.body)) > 0)
      or position(lower(v_q) in lower(coalesce(m.sender_display_name, m.sender_username, ''))) > 0
      or position(lower(v_q) in lower(coalesce(m.sender_username, ''))) > 0
    )
    and (
      v_tag is null
      or m.body ~* ('(^|[^[:alnum:]_])' || v_tag || '($|[^[:alnum:]_])')
    )
  order by m.created_at desc, m.id desc
  limit v_limit;
end $$;

/* ------------------------------------------------------------------ */
/* 12. Mention autocomplete: members of THIS conversation              */
/* ------------------------------------------------------------------ */

create or replace function public.list_chat_mention_targets(
  p_conversation uuid,
  p_query text default ''
)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text
)
language sql stable security definer set search_path = public as $$
  select pr.id, pr.username, coalesce(pr.display_name, pr.username, 'Student'), pr.avatar_url
  from public.conversation_members m
  join public.profiles pr on pr.id = m.user_id
  where m.conversation_id = p_conversation
    and m.user_id <> auth.uid()
    and (
      btrim(coalesce(p_query, '')) = ''
      or pr.username ilike btrim(p_query, '@') || '%'
      or coalesce(pr.display_name, '') ilike '%' || btrim(p_query, '@') || '%'
    )
  order by
    (pr.username ilike btrim(p_query, '@') || '%') desc,
    pr.username
  limit 8
$$;

/* ------------------------------------------------------------------ */
/* 13. Grants: authenticated only, nothing to anon or public           */
/* ------------------------------------------------------------------ */

revoke all on function public.chat_all(uuid) from public, anon;
revoke all on function public.list_chat_messages(uuid, int, timestamptz) from public, anon;
revoke all on function public.send_chat_message(uuid, text, uuid, jsonb) from public, anon;
revoke all on function public.toggle_chat_reaction(uuid, text) from public, anon;
revoke all on function public.edit_chat_message(uuid, text) from public, anon;
revoke all on function public.unsend_chat_message(uuid) from public, anon;
revoke all on function public.moderate_delete_chat_message(uuid) from public, anon;
revoke all on function public.set_chat_message_pin(uuid, boolean) from public, anon;
revoke all on function public.list_chat_pins(uuid) from public, anon;
revoke all on function public.list_chat_thread(uuid) from public, anon;
revoke all on function public.search_chat(uuid, text, text, int, timestamptz) from public, anon;
revoke all on function public.list_chat_mention_targets(uuid, text) from public, anon;

grant execute on function public.list_chat_messages(uuid, int, timestamptz) to authenticated;
grant execute on function public.send_chat_message(uuid, text, uuid, jsonb) to authenticated;
grant execute on function public.toggle_chat_reaction(uuid, text) to authenticated;
grant execute on function public.edit_chat_message(uuid, text) to authenticated;
grant execute on function public.unsend_chat_message(uuid) to authenticated;
grant execute on function public.moderate_delete_chat_message(uuid) to authenticated;
grant execute on function public.set_chat_message_pin(uuid, boolean) to authenticated;
grant execute on function public.list_chat_pins(uuid) to authenticated;
grant execute on function public.list_chat_thread(uuid) to authenticated;
grant execute on function public.search_chat(uuid, text, text, int, timestamptz) to authenticated;
grant execute on function public.list_chat_mention_targets(uuid, text) to authenticated;
