-- =====================================================================
-- 0008 — Chat requests + follows
--
-- Instagram's DM logic, CAMPUS wording, own visual language:
--   • A fresh 1:1 chat starts as a "pending" chat REQUEST.
--   • The requester gets exactly ONE message through (their opening note);
--     nothing after that until the recipient accepts.
--   • The recipient sees the request in Chats: Accept → full chat, or
--     Decline → neither side can send any further.
--   • Mutual follows skip the request — classmates who follow each other
--     can chat directly (like Instagram's mutual-follower rule).
--   • Groups are always 'accepted'; club channels only exist later.
--
-- Also lays the foundations for the Profile page: a real follows table.
-- =====================================================================

/* ------------------------------------------------------------------ */
/* 1. Chat request state                                               */
/* ------------------------------------------------------------------ */

alter table public.conversations
  add column if not exists status text not null default 'accepted';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversations_status_check'
  ) then
    alter table public.conversations
      add constraint conversations_status_check
      check (status in ('pending', 'accepted', 'declined'));
  end if;
end $$;

-- Open (or reuse) the 1:1 chat between caller and another member.
-- Mutual followers open as 'accepted'; everyone else starts a request.
drop function if exists public.open_dm(uuid);
create or replace function public.open_dm(p_other uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_status text;
  v_conv uuid;
begin
  if v_me is null then
    raise exception 'Sign in to start a chat.';
  end if;
  if p_other is null or p_other = v_me then
    raise exception 'Choose a classmate to chat with.';
  end if;

  select m1.conversation_id into v_conv
  from public.conversation_members m1
  join public.conversation_members m2
    on m2.conversation_id = m1.conversation_id and m2.user_id = p_other
  join public.conversations c
    on c.id = m1.conversation_id and c.kind = 'dm'
  where m1.user_id = v_me
  limit 1;

  if v_conv is null then
    select case
      when exists (
        select 1 from public.follows f
        where f.follower_id = v_me and f.followed_id = p_other
      ) and exists (
        select 1 from public.follows f2
        where f2.follower_id = p_other and f2.followed_id = v_me
      )
      then 'accepted' else 'pending'
    end into v_status;

    insert into public.conversations (kind, created_by, status)
    values ('dm', v_me, v_status)
    returning id into v_conv;

    insert into public.conversation_members (conversation_id, user_id)
    values (v_conv, v_me), (v_conv, p_other);
  end if;

  return v_conv;
end $$;

-- Recipient answers a chat request. Only the non-recipient creator's
-- counterpart may respond, and only while the request is pending.
create or replace function public.respond_dm(p_conversation uuid, p_action text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_status text;
  v_creator uuid;
begin
  if v_me is null then
    raise exception 'Sign in first.';
  end if;
  if p_action not in ('accept', 'decline') then
    raise exception 'Unknown chat request action.';
  end if;

  select c.status, c.created_by
    into v_status, v_creator
  from public.conversations c
  where c.id = p_conversation
    and c.kind = 'dm'
    and exists (
      select 1 from public.conversation_members m
      where m.conversation_id = p_conversation and m.user_id = v_me
    );

  if v_status is null then
    raise exception 'Chat not found.';
  end if;
  if v_status <> 'pending' then
    raise exception 'That chat request was already handled.';
  end if;
  if v_creator = v_me then
    raise exception 'Only the classmate receiving the request can accept or decline it.';
  end if;

  update public.conversations
  set status = case p_action when 'accept' then 'accepted' else 'declined' end
  where id = p_conversation;

  return case p_action when 'accept' then 'accepted' else 'declined' end;
end $$;

revoke all on function public.respond_dm(uuid, text) from public;
grant execute on function public.respond_dm(uuid, text) to authenticated;

-- Sending rules (RLS): members whose chat is accepted; or the request
-- creator's single opening note; never a pending recipient; never declined.
-- All send rules live in ONE security-definer helper (bypasses RLS in its
-- own evaluation — the caller still has to be the sender in the policy).
create or replace function public.can_send_chat(p_conversation uuid, p_sender uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_conversation and m.user_id = p_sender
  ) and (
    exists (
      select 1 from public.conversations c
      where c.id = p_conversation and c.status = 'accepted'
    )
    -- the request creator may send exactly one opening note
    or exists (
      select 1 from public.conversations c
      where c.id = p_conversation
        and c.status = 'pending'
        and c.created_by = p_sender
        and not exists (
          select 1 from public.chat_messages msg
          where msg.conversation_id = p_conversation
            and msg.sender_id = p_sender
        )
    )
  )
$$;

drop policy if exists "members send messages" on public.chat_messages;
drop policy if exists "chat message send rules" on public.chat_messages;
create policy "chat message send rules" on public.chat_messages
for insert to authenticated
with check (
  sender_id = auth.uid()
  and public.can_send_chat(conversation_id, auth.uid())
);

/* ------------------------------------------------------------------ */
/* 2. The Chats list: requests included, declined hidden appropriately  */
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
      or (c.kind = 'dm' and c.created_by = auth.uid()) -- my pending/declined requests stay visible to me
    )
  order by
    (c.created_by <> auth.uid() and c.status = 'pending') desc, -- incoming requests first
    c.last_message_at desc nulls last, c.created_at desc
$$;

/* ------------------------------------------------------------------ */
/* 3. Follows (foundation for Profile; opens chats without a request    */
/*    when the follow is mutual)                                        */
/* ------------------------------------------------------------------ */

/* legacy guard: a stray `follows` table from an earlier experiment (columns
   don't match) must be out of the way before this migration runs. Empty and
   misshapen → dropped; populated → migration stops with a count. */
do $$
declare
  v_total bigint;
begin
  if to_regclass('public.follows') is not null
     and not exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'follows'
         and column_name = 'followed_id'
     ) then
    execute 'select count(*) from public.follows' into v_total;
    if v_total = 0 then
      drop table public.follows;
    else
      raise exception
        'a legacy "follows" table with % rows exists and does not match the 0008 schema — review its data before replacing it',
        v_total;
    end if;
  end if;
end $$;

create table if not exists public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followed_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  constraint follows_no_self check (follower_id <> followed_id)
);

create index if not exists follows_followed_idx on public.follows (followed_id);

alter table public.follows enable row level security;

drop policy if exists "follows readable by everyone" on public.follows;
create policy "follows readable by everyone" on public.follows
  for select using (true);

drop policy if exists "members follow classmates" on public.follows;
create policy "members follow classmates" on public.follows
  for insert to authenticated
  with check (follower_id = auth.uid());

drop policy if exists "members unfollow" on public.follows;
create policy "members unfollow" on public.follows
  for delete to authenticated
  using (follower_id = auth.uid());

/* ------------------------------------------------------------------ */
/* 4. Profile: stats and uploaded content                              */
/* ------------------------------------------------------------------ */

create or replace function public.profile_stats(p_profile uuid)
returns table (
  post_count bigint,
  reel_count bigint,
  follower_count bigint,
  following_count bigint
)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from public.posts p
      where p.author_id = p_profile and p.is_published = true and p.kind <> 'reel' and p.is_anonymous = false),
    (select count(*) from public.posts p
      where p.author_id = p_profile and p.is_published = true and p.kind = 'reel' and p.is_anonymous = false),
    (select count(*) from public.follows f where f.followed_id = p_profile),
    (select count(*) from public.follows f where f.follower_id = p_profile)
$$;

revoke all on function public.profile_stats(uuid) from public;
grant execute on function public.profile_stats(uuid) to anon, authenticated;

-- A member's named uploads (posts or reels); anonymous confessions are
-- excluded — a profile grid must not expose who confessed.
create or replace function public.list_member_posts(
  p_profile uuid,
  p_kind text default 'post',
  p_limit integer default 24
)
returns table (
  id uuid,
  body text,
  kind public.post_kind,
  media_urls text[],
  is_anonymous boolean,
  created_at timestamptz,
  edited_at timestamptz,
  author_id uuid,
  author_display_name text,
  author_username text,
  author_avatar_url text,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean
)
language sql stable security definer set search_path = '' as $$
  select
    p.id, p.body, p.kind, p.media_urls, p.is_anonymous, p.created_at, p.edited_at,
    case when p.is_anonymous then null else p.author_id end,
    case when p.is_anonymous then null else pr.display_name end,
    case when p.is_anonymous then null else pr.username end,
    case when p.is_anonymous then null else pr.avatar_url end,
    p.college_id, c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce((select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()), false)
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.is_anonymous = false
    and p.author_id = p_profile
    and p.kind = (coalesce(nullif(btrim(p_kind), ''), 'post'))::public.post_kind
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 50)
$$;

revoke all on function public.list_member_posts(uuid, text, integer) from public;
grant execute on function public.list_member_posts(uuid, text, integer) to anon, authenticated;

-- Everyone who follows / is followed by a member (profile names shown).
create or replace function public.list_followers(p_profile uuid, p_followers boolean default true)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  is_private boolean
)
language sql stable security definer set search_path = '' as $$
  select pr.id, pr.username, pr.display_name, pr.avatar_url, pr.is_private
  from public.follows f
  join public.profiles pr on pr.id = case
    when p_followers then f.follower_id
    else f.followed_id
  end
  where case when p_followers then f.followed_id else f.follower_id end = p_profile
  order by f.created_at desc
  limit 50
$$;

revoke all on function public.list_followers(uuid, boolean) from public;
grant execute on function public.list_followers(uuid, boolean) to anon, authenticated;
