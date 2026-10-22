-- CAMPUS initial schema. Run in Supabase SQL Editor.
-- This schema is a foundation; review and test RLS policies before production launch.
create extension if not exists pgcrypto;

-- Enum types are created only when missing so the script can be re-run safely.
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'post_kind' and n.nspname = 'public') then
    create type public.post_kind as enum ('post','confession','poll','reel');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'report_status' and n.nspname = 'public') then
    create type public.report_status as enum ('open','reviewing','resolved','dismissed');
  end if;
end $$;

create table if not exists public.colleges (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short_name text not null,
  city text not null default 'Pune',
  domain text,
  logo_url text,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique(short_name, city)
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text not null default 'Campus Student',
  bio text not null default '',
  avatar_url text,
  college_id uuid references public.colleges(id) on delete set null,
  course text,
  year_of_study smallint check (year_of_study between 1 and 8),
  is_private boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references public.profiles(id) on delete set null,
  college_id uuid references public.colleges(id) on delete set null,
  kind public.post_kind not null default 'post',
  body text not null check (char_length(body) between 1 and 2000),
  media_urls text[] not null default '{}',
  is_anonymous boolean not null default false,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.post_likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(post_id, user_id)
);

create table if not exists public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create table if not exists public.post_bookmarks (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(post_id, user_id)
);

create table if not exists public.post_reposts (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(post_id, user_id)
);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(follower_id, following_id),
  check(follower_id <> following_id)
);

create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  post_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.post_topics (
  post_id uuid not null references public.posts(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  primary key(post_id, topic_id)
);

create table if not exists public.poll_meta (
  post_id uuid primary key references public.posts(id) on delete cascade,
  multiple_choice boolean not null default false,
  /* null = open-ended; cast_poll_vote() enforces expiry via the server clock */
  closes_at timestamptz
);

create table if not exists public.poll_options (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  label text not null,
  position smallint not null default 0
);

create table if not exists public.poll_votes (
  /* multiple-choice polls store one row per selected option;
     single-choice is enforced by cast_poll_vote() (migration 0028) */
  post_id uuid not null references public.posts(id) on delete cascade,
  option_id uuid not null references public.poll_options(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(post_id, user_id, option_id)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text,
  is_group boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key(conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  body text not null check (char_length(body) between 1 and 5000),
  media_url text,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  type text not null,
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  college_id uuid references public.colleges(id) on delete cascade,
  name text not null,
  description text not null default '',
  logo_url text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.club_members (
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('member','moderator','admin')),
  joined_at timestamptz not null default now(),
  primary key(club_id, user_id)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  college_id uuid references public.colleges(id) on delete cascade,
  club_id uuid references public.clubs(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  title text not null,
  description text not null default '',
  venue text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  cover_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.event_rsvps (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'going' check (status in ('going','interested','not_going')),
  created_at timestamptz not null default now(),
  primary key(event_id, user_id)
);

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  college_id uuid references public.colleges(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  title text not null,
  organization text not null,
  description text not null default '',
  application_url text,
  deadline timestamptz,
  opportunity_type text not null default 'internship',
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles(id) on delete set null,
  post_id uuid references public.posts(id) on delete cascade,
  reported_user_id uuid references public.profiles(id) on delete cascade,
  reason text not null,
  details text,
  status public.report_status not null default 'open',
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check(post_id is not null or reported_user_id is not null)
);

create index if not exists posts_created_at_idx on public.posts(created_at desc);
create index if not exists posts_college_created_idx on public.posts(college_id, created_at desc);
create index if not exists comments_post_created_idx on public.post_comments(post_id, created_at);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index if not exists notifications_recipient_created_idx on public.notifications(recipient_id, created_at desc);
create index if not exists events_starts_at_idx on public.events(starts_at);
create index if not exists opportunities_deadline_idx on public.opportunities(deadline);

-- Automatically create a profile when a user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  desired_username text;
  profile_name text;
begin
  desired_username := nullif(lower(regexp_replace(split_part(coalesce(new.email, 'student'), '@', 1), '[^a-zA-Z0-9_]', '', 'g')), '');
  profile_name := coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, 'Campus Student'), '@', 1));

  -- "do nothing" covers every unique constraint, so two accounts sharing an
  -- email local part (john@a.com / john@b.com) never fail the signup itself.
  insert into public.profiles (id, username, display_name)
  values (new.id, desired_username, profile_name)
  on conflict do nothing;

  -- The profile row must always exist: if the username was already taken by
  -- another account, retry without one instead of leaving the user profileless.
  if not exists (select 1 from public.profiles where id = new.id) then
    insert into public.profiles (id, username, display_name)
    values (new.id, null, profile_name)
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

-- RLS: enable on all user-facing tables.
alter table public.colleges enable row level security;
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;
alter table public.post_bookmarks enable row level security;
alter table public.post_reposts enable row level security;
alter table public.follows enable row level security;
alter table public.topics enable row level security;
alter table public.post_topics enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
alter table public.poll_meta enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;
alter table public.clubs enable row level security;
alter table public.club_members enable row level security;
alter table public.events enable row level security;
alter table public.event_rsvps enable row level security;
alter table public.opportunities enable row level security;
alter table public.reports enable row level security;

-- Public read policies for campus discovery. Anonymous confession identity is
-- hidden by the client view; production apps should expose a safe view/RPC
-- rather than selecting author_id for anonymous posts.
drop policy if exists "colleges readable by everyone" on public.colleges;
create policy "colleges readable by everyone" on public.colleges for select using (true);
drop policy if exists "profiles readable by signed in users" on public.profiles;
create policy "profiles readable by signed in users" on public.profiles for select to authenticated using (true);
drop policy if exists "users insert own profile" on public.profiles;
create policy "users insert own profile" on public.profiles for insert to authenticated with check (auth.uid() = id);
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "published posts readable" on public.posts;
create policy "published posts readable" on public.posts for select using (is_published = true);
drop policy if exists "signed in users create posts" on public.posts;
create policy "signed in users create posts" on public.posts for insert to authenticated with check (auth.uid() = author_id);
drop policy if exists "authors update own posts" on public.posts;
create policy "authors update own posts" on public.posts for update to authenticated using (auth.uid() = author_id) with check (auth.uid() = author_id);
drop policy if exists "authors delete own posts" on public.posts;
create policy "authors delete own posts" on public.posts for delete to authenticated using (auth.uid() = author_id);

drop policy if exists "likes readable" on public.post_likes;
create policy "likes readable" on public.post_likes for select to authenticated using (true);
drop policy if exists "users manage own likes" on public.post_likes;
create policy "users manage own likes" on public.post_likes for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "comments readable" on public.post_comments;
create policy "comments readable" on public.post_comments for select to authenticated using (true);
drop policy if exists "users create comments" on public.post_comments;
create policy "users create comments" on public.post_comments for insert to authenticated with check (auth.uid() = author_id);
drop policy if exists "authors delete own comments" on public.post_comments;
create policy "authors delete own comments" on public.post_comments for delete to authenticated using (auth.uid() = author_id);
drop policy if exists "users read own bookmarks" on public.post_bookmarks;
create policy "users read own bookmarks" on public.post_bookmarks for select to authenticated using (auth.uid() = user_id);
drop policy if exists "users manage own bookmarks" on public.post_bookmarks;
create policy "users manage own bookmarks" on public.post_bookmarks for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "reposts readable" on public.post_reposts;
create policy "reposts readable" on public.post_reposts for select to authenticated using (true);
drop policy if exists "users manage own reposts" on public.post_reposts;
create policy "users manage own reposts" on public.post_reposts for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "follows readable" on public.follows;
create policy "follows readable" on public.follows for select to authenticated using (true);
drop policy if exists "users manage own follows" on public.follows;
create policy "users manage own follows" on public.follows for all to authenticated using (auth.uid() = follower_id) with check (auth.uid() = follower_id);

drop policy if exists "topics readable" on public.topics;
create policy "topics readable" on public.topics for select using (true);
drop policy if exists "post topics readable" on public.post_topics;
create policy "post topics readable" on public.post_topics for select using (true);
drop policy if exists "poll options readable" on public.poll_options;
create policy "poll options readable" on public.poll_options for select using (true);
drop policy if exists "poll meta readable" on public.poll_meta;
/* settings are read-only to clients; create_poll() is the sole writer */
create policy "poll meta readable" on public.poll_meta for select using (true);
/* poll settings/options/votes are writable only through the 0028 definer RPCs */
revoke all on public.poll_meta from anon, authenticated;
grant select on public.poll_meta to anon, authenticated;
revoke insert, update, delete, truncate on public.poll_options from anon, authenticated, public;
revoke insert, update, delete, truncate on public.poll_meta from anon, authenticated, public;
drop policy if exists "users read poll votes" on public.poll_votes;
/* voters can see only their own rows — results come from poll_states()
   aggregates (migration 0028), so vote identity is never enumerable */
create policy "users read poll votes" on public.poll_votes for select to authenticated using (auth.uid() = user_id);
drop policy if exists "users vote once" on public.poll_votes;
/* votes are writable ONLY through cast_poll_vote() (definer RPC) — no direct
   client inserts, updates or deletes; the RPC enforces expiry, option
   ownership and the single- vs multiple-choice limit transactionally */
revoke all on public.poll_votes from anon, authenticated;
grant select on public.poll_votes to authenticated;

drop policy if exists "members read conversations" on public.conversations;
create policy "members read conversations" on public.conversations for select to authenticated using (
  exists(select 1 from public.conversation_members cm where cm.conversation_id = id and cm.user_id = auth.uid())
);
drop policy if exists "signed in users create conversations" on public.conversations;
create policy "signed in users create conversations" on public.conversations for insert to authenticated with check (auth.uid() = created_by);
drop policy if exists "members readable" on public.conversation_members;
create policy "members readable" on public.conversation_members for select to authenticated using (
  user_id = auth.uid() or exists(select 1 from public.conversation_members cm where cm.conversation_id = conversation_id and cm.user_id = auth.uid())
);
drop policy if exists "users join as self" on public.conversation_members;
create policy "users join as self" on public.conversation_members for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages for select to authenticated using (
  exists(select 1 from public.conversation_members cm where cm.conversation_id = conversation_id and cm.user_id = auth.uid())
);
drop policy if exists "members send messages" on public.messages;
create policy "members send messages" on public.messages for insert to authenticated with check (
  auth.uid() = sender_id and exists(select 1 from public.conversation_members cm where cm.conversation_id = conversation_id and cm.user_id = auth.uid())
);
drop policy if exists "users read own notifications" on public.notifications;
create policy "users read own notifications" on public.notifications for select to authenticated using (auth.uid() = recipient_id);
drop policy if exists "users update own notifications" on public.notifications;
create policy "users update own notifications" on public.notifications for update to authenticated using (auth.uid() = recipient_id) with check (auth.uid() = recipient_id);

drop policy if exists "clubs readable" on public.clubs;
create policy "clubs readable" on public.clubs for select using (true);
drop policy if exists "club memberships readable" on public.club_members;
create policy "club memberships readable" on public.club_members for select to authenticated using (true);
drop policy if exists "users join clubs as self" on public.club_members;
create policy "users join clubs as self" on public.club_members for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "events readable" on public.events;
create policy "events readable" on public.events for select using (true);
drop policy if exists "users manage own rsvps" on public.event_rsvps;
create policy "users manage own rsvps" on public.event_rsvps for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "opportunities readable" on public.opportunities;
create policy "opportunities readable" on public.opportunities for select using (true);
drop policy if exists "users submit reports" on public.reports;
create policy "users submit reports" on public.reports for insert to authenticated with check (auth.uid() = reporter_id);
drop policy if exists "reporters read own reports" on public.reports;
create policy "reporters read own reports" on public.reports for select to authenticated using (auth.uid() = reporter_id);

-- Starter colleges for local testing; replace or extend as needed.
insert into public.colleges(name, short_name, city, verified) values
('Savitribai Phule Pune University','SPPU','Pune',true),
('College of Engineering Pune','COEP','Pune',true),
('Pune Institute of Computer Technology','PICT','Pune',true),
('MIT World Peace University','MIT-WPU','Pune',true),
('Indian Institute of Technology Bombay','IIT Bombay','Mumbai',true)
on conflict (short_name, city) do nothing;

insert into public.topics(name, post_count) values
('#FestSeason',12400),('#Placements',8100),('#Exams',6700),('#HostelLife',5300),('#Internships',4900),('#CampusLife',3200)
on conflict (name) do nothing;
