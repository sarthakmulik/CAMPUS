-- =====================================================================
-- 0006 — Chats: conversations, members, messages
--
-- Design note: `conversations.kind` supports 'dm' | 'group' | 'club'.
-- The Chats section covers 1:1 dms and friend/class group chats (both query
-- kind in ('dm','group')). Club chats (kind='club') are a later feature and
-- live inside the Clubs section — every Chats query excludes them, so they
-- can never leak into the Chats page.
-- All functions are SECURITY DEFINER with an explicit search_path so RLS
-- cannot recurse; every check still runs against auth.uid().
-- =====================================================================

create extension if not exists pgcrypto;

/* legacy guard: a stray `conversations` table (from an earlier experiment)
   may already exist without the `kind` column, which breaks this migration.
   The real chat table always has `kind`, and no released CAMPUS feature ever
   read this table — an empty misshapen lookalike is dropped; a populated one
   stops the migration with an understandable error instead of being destroyed. */
/* legacy guard: an earlier experiment may have left a chats cluster behind —
   old `conversations` / `conversation_members` / `messages` tables chained by
   FKs whose names don't exist in this schema. If that cluster is present and
   completely empty it is removed so 0006 can create the real tables; if it
   holds rows the migration stops with a count instead of destroying data. */
do $$
declare
  v_legacy boolean := false;
  v_lookalike boolean;
  v_total bigint := 0;
  v_rows bigint;
  t text;
begin
  if exists (select 1 from pg_constraint where conname = 'messages_conversation_id_fkey')
     or exists (select 1 from pg_constraint where conname = 'conversation_members_conversation_id_fkey') then
    v_legacy := true;
  end if;

  if v_legacy then
    foreach t in array array['messages', 'conversation_members', 'conversations'] loop
      if to_regclass(format('public.%I', t)) is not null then
        execute format('select count(*) from public.%I', t) into v_rows;
        v_total := v_total + v_rows;
        raise notice 'legacy table %: % rows', t, v_rows;
      end if;
    end loop;

    if v_total = 0 then
      drop table if exists public.messages, public.conversation_members, public.conversations cascade;
    else
      raise exception
        'legacy chats tables (messages / conversation_members / conversations) together hold % rows — review their data before running 0006',
        v_total;
    end if;
  end if;

  -- remaining lookalikes: a table with the right name but the wrong shape.
  -- each real 0006 table has a sentinel column strays won't have.
  if to_regclass('public.conversation_members') is not null then
    select not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'conversation_members' and column_name = 'last_read_at') into v_lookalike;
    if v_lookalike then
      execute 'select count(*) from public.conversation_members' into v_total;
      if v_total = 0 then drop table public.conversation_members;
      else raise exception 'a legacy "conversation_members" table with % rows exists and does not match the 0006 chat schema — review its data before replacing it', v_total; end if;
    end if;
  end if;

  if to_regclass('public.chat_messages') is not null then
    select not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'deleted_at') into v_lookalike;
    if v_lookalike then
      execute 'select count(*) from public.chat_messages' into v_total;
      if v_total = 0 then drop table public.chat_messages;
      else raise exception 'a legacy "chat_messages" table with % rows exists and does not match the 0006 chat schema — review its data before replacing it', v_total; end if;
    end if;
  end if;
end $$;

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'dm'
    constraint conversations_kind_check check (kind in ('dm', 'group', 'club')),
  -- set only when kind = 'club' (one channel per club, enforced below);
  -- left null for dm/group
  club_id uuid references public.clubs (id) on delete cascade,
  -- display name for group/club channels; null for dms
  title text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz
);

-- a club can have at most one conversation channel
create unique index if not exists conversations_kind_club_uniq
  on public.conversations (club_id)
  where kind = 'club' and club_id is not null;

create index if not exists conversations_kind_idx on public.conversations (kind);

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member'
    constraint conversation_members_role_check check (role in ('member', 'moderator', 'admin')),
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id);

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;

/* membership helper — SECURITY DEFINER so message policies can reuse it
   without recursing into the members policies */
create or replace function public.is_conversation_member(p_conversation uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_conversation
      and m.user_id = auth.uid()
  )
$$;

-- conversations: visible to their members; creation always flows through
-- open_dm() / (later) create_group(), so inserts limited to self-created rows
drop policy if exists "conversations readable by members" on public.conversations;
create policy "conversations readable by members" on public.conversations
  for select to authenticated
  using (public.is_conversation_member(id));

drop policy if exists "authenticated start conversations" on public.conversations;
create policy "authenticated start conversations" on public.conversations
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists "members update conversations" on public.conversations;
create policy "members update conversations" on public.conversations
  for update to authenticated
  using (public.is_conversation_member(id));

drop policy if exists "members see memberships" on public.conversation_members;
create policy "members see memberships" on public.conversation_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_conversation_member(conversation_id));

-- dm memberships are created by open_dm() only; group/club joins come later
drop policy if exists "own group membership insert" on public.conversation_members;
create policy "own group membership insert" on public.conversation_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.kind in ('group', 'club')
    )
  );

drop policy if exists "members update own membership" on public.conversation_members;
create policy "members update own membership" on public.conversation_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid references auth.users (id) on delete set null,
  body text not null
    constraint chat_messages_body_len check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create index if not exists chat_messages_conv_time_idx
  on public.chat_messages (conversation_id, created_at desc);

alter table public.chat_messages enable row level security;

drop policy if exists "messages readable by members" on public.chat_messages;
create policy "messages readable by members" on public.chat_messages
  for select to authenticated
  using (public.is_conversation_member(conversation_id));

drop policy if exists "members send messages" on public.chat_messages;
create policy "members send messages" on public.chat_messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));

drop policy if exists "senders edit own messages" on public.chat_messages;
create policy "senders edit own messages" on public.chat_messages
  for update to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

drop policy if exists "senders delete own messages" on public.chat_messages;
create policy "senders delete own messages" on public.chat_messages
  for delete to authenticated
  using (sender_id = auth.uid());

-- every new message bumps the conversation timestamp and marks the sender
-- as caught-up (receiving side keeps its own last_read_at)
create or replace function public.bump_conversation_last_message()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations
  set last_message_at = new.created_at
  where id = new.conversation_id;

  update public.conversation_members
  set last_read_at = new.created_at
  where conversation_id = new.conversation_id
    and user_id = new.sender_id;

  return new;
end $$;

drop trigger if exists chat_messages_after_insert on public.chat_messages;
create trigger chat_messages_after_insert
  after insert on public.chat_messages
  for each row execute function public.bump_conversation_last_message();

/* ------------------------------------------------------------------ */
/* RPCs                                                                */
/* ------------------------------------------------------------------ */

-- Open (or reuse) the 1:1 conversation between the caller and another member.
create or replace function public.open_dm(p_other uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
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
    insert into public.conversations (kind, created_by)
    values ('dm', v_me)
    returning id into v_conv;

    insert into public.conversation_members (conversation_id, user_id)
    values (v_conv, v_me), (v_conv, p_other);
  end if;

  return v_conv;
end $$;

-- The Chats list: the caller's dm AND group conversations (club channels are
-- excluded by design — they live in the Clubs section, never here) with peer
-- profile / group title, member count, last message and unread count.
drop function if exists public.list_dm_conversations();
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
  unread_count bigint
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
    )
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
  order by c.last_message_at desc nulls last, c.created_at desc
$$;

-- Create a group chat: the creator becomes admin; listed classmates are
-- added as members. Unknown ids are ignored, duplicates collapse — the honest
-- group is what the caller sees afterwards.
create or replace function public.create_group(p_title text, p_members uuid[] default array[]::uuid[])
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_members uuid[];
  v_conv uuid;
begin
  if v_me is null then
    raise exception 'Sign in to create a group.';
  end if;
  if nullif(btrim(p_title), '') is null then
    raise exception 'Name your group first.';
  end if;

  select coalesce(array_agg(distinct u), array[]::uuid[]) into v_members
  from unnest(p_members) u
  where u is not null and u <> v_me;

  if cardinality(v_members) > 49 then
    raise exception 'A group can hold up to 50 classmates.';
  end if;

  insert into public.conversations (kind, title, created_by)
  values ('group', btrim(p_title), v_me)
  returning id into v_conv;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (v_conv, v_me, 'admin');

  -- only classmates with a real profile join; ghosts ids fall through
  insert into public.conversation_members (conversation_id, user_id)
  select v_conv, u
  from unnest(v_members) u
  where exists (select 1 from public.profiles pr where pr.id = u)
  on conflict do nothing;

  return v_conv;
end $$;

-- Message history for one conversation (paginated backwards).
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
  edited_at timestamptz
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
    msg.edited_at
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
/* Realtime: stream new messages to authorized clients                 */
/* ------------------------------------------------------------------ */

do $$
begin
  alter publication supabase_realtime add table public.chat_messages;
exception
  when duplicate_object then null; -- already in the publication
end $$;
