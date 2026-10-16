-- ============================================================================
-- CAMPUS migration 0001 — Explore-first onboarding & college-based identity
-- ============================================================================
-- How to apply:
--   Supabase Dashboard -> SQL Editor -> New query -> paste this file -> Run.
--   Or with the Supabase CLI:  supabase db push
--
-- Rules this migration follows:
--   * Repeatable: safe to run more than once (guarded DDL, drop-then-create
--     policies, create or replace functions).
--   * Additive only: no DROP TABLE, no TRUNCATE, no data is deleted or
--     overwritten. Existing user rows keep working.
--   * No client-side secrets: everything below is usable with the anon key
--     plus Row Level Security. Never put a service_role key in the browser.
--
-- What it adds:
--   1. Profile columns for the onboarding wizard + platform roles
--   2. Database-enforced username uniqueness (case-insensitive)
--   3. College suggestions table (visitors/members can request a college)
--   4. Profile interests, user blocks and user mutes
--   5. Safe reads for anonymous confessions (author identity never leaks)
--   6. Helper functions: username_available(), is_admin(), list_public_posts(),
--      submit_report(), request_college_suggestion()
--   7. Avatar storage bucket with per-user upload policies
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Profile extensions
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name text;
alter table public.profiles add column if not exists department text;
alter table public.profiles add column if not exists onboarding_step smallint not null default 0;
alter table public.profiles add column if not exists onboarding_completed_at timestamptz;
alter table public.profiles add column if not exists college_declared_at timestamptz;
alter table public.profiles add column if not exists role text not null default 'member';

-- Role whitelist, added only once.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_role_check' and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles add constraint profiles_role_check check (role in ('member','admin'));
  end if;
end $$;

-- Case-insensitive username uniqueness. lower(NULL) is NULL and PostgreSQL
-- treats NULLs as distinct, so members who have not picked a username yet are
-- unaffected. This is the database-level guarantee the wizard relies on: two
-- clients racing for the same handle result in one 23505 error, not two rows.
create unique index if not exists profiles_username_lower_uniq
  on public.profiles (lower(username));

create index if not exists profiles_college_idx on public.profiles (college_id);

-- Is the current user a CAMPUS platform administrator? Defined before the
-- policies below because PostgreSQL validates policy expressions at creation
-- time. Security definer so it can read profiles without re-entering the
-- profiles RLS policy (which would recurse). Only the 'role' column is read.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. College suggestions (visitors and members can propose a missing college)
-- ---------------------------------------------------------------------------
create table if not exists public.college_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  name text not null check (char_length(name) between 2 and 120),
  city text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists college_suggestions_status_idx on public.college_suggestions (status, created_at desc);
create index if not exists college_suggestions_user_idx on public.college_suggestions (user_id);

-- ---------------------------------------------------------------------------
-- 3. Profile interests (which topics a member wants to explore)
-- ---------------------------------------------------------------------------
create table if not exists public.profile_interests (
  user_id uuid not null references public.profiles(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, topic_id)
);

-- ---------------------------------------------------------------------------
-- 4. Blocks and mutes (member-driven moderation)
-- ---------------------------------------------------------------------------
create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create table if not exists public.user_mutes (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

-- ---------------------------------------------------------------------------
-- 5. Row Level Security for the new tables
-- ---------------------------------------------------------------------------
alter table public.college_suggestions enable row level security;
alter table public.profile_interests enable row level security;
alter table public.user_blocks enable row level security;
alter table public.user_mutes enable row level security;

drop policy if exists "suggestions readable by owner and admins" on public.college_suggestions;
create policy "suggestions readable by owner and admins" on public.college_suggestions
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists "users submit college suggestions" on public.college_suggestions;
create policy "users submit college suggestions" on public.college_suggestions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "admins review college suggestions" on public.college_suggestions;
create policy "admins review college suggestions" on public.college_suggestions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "users delete own suggestions" on public.college_suggestions;
create policy "users delete own suggestions" on public.college_suggestions
  for delete to authenticated using (user_id = auth.uid() and status = 'pending');

drop policy if exists "interests readable by owner" on public.profile_interests;
create policy "interests readable by owner" on public.profile_interests
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "users manage own interests" on public.profile_interests;
create policy "users manage own interests" on public.profile_interests
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "blocks readable by owner" on public.user_blocks;
create policy "blocks readable by owner" on public.user_blocks
  for select to authenticated using (blocker_id = auth.uid());

drop policy if exists "users manage own blocks" on public.user_blocks;
create policy "users manage own blocks" on public.user_blocks
  for all to authenticated using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

drop policy if exists "mutes readable by owner" on public.user_mutes;
create policy "mutes readable by owner" on public.user_mutes
  for select to authenticated using (blocker_id = auth.uid());

drop policy if exists "users manage own mutes" on public.user_mutes;
create policy "users manage own mutes" on public.user_mutes
  for all to authenticated using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. Tighten existing policies
-- ---------------------------------------------------------------------------
-- 6a. Private profiles are only readable by themselves (and platform admins).
--     The is_private column already existed; this makes the read policy
--     actually respect it instead of exposing every profile to every member.
drop policy if exists "profiles readable by signed in users" on public.profiles;
create policy "profiles readable by signed in users" on public.profiles
  for select to authenticated using (id = auth.uid() or is_private = false or public.is_admin());

-- 6b. Anonymous confessions: the raw posts table must never reveal the author.
--     Published public posts stay readable; anonymous posts are only visible
--     to their author through the table and are served to everyone else by the
--     sanitized list_public_posts() function below.
drop policy if exists "published posts readable" on public.posts;
create policy "published posts readable" on public.posts
  for select using (is_published = true and (is_anonymous = false or author_id = auth.uid()));

-- 6c. Platform admins can work the moderation queue (reports).
drop policy if exists "admins review reports" on public.reports;
create policy "admins review reports" on public.reports
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 7. Helper functions (is_admin() was created in section 1)
-- ---------------------------------------------------------------------------
-- Username availability. Returns a single boolean: no emails, no ids, no other
-- account data can be read through this function. Invalid formats return false
-- so the client shows "unavailable" rather than "available" for bad input.
create or replace function public.username_available(p_username text)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  normalized text;
begin
  normalized := nullif(lower(regexp_replace(coalesce(p_username, ''), '\s+', '', 'g')), '');
  if normalized is null or normalized !~ '^[a-z0-9_]{3,20}$' then
    return false;
  end if;
  return not exists (
    select 1 from public.profiles
    where lower(username) = normalized
      and (auth.uid() is null or id <> auth.uid())
  );
end;
$$;

-- Safe public feed read. Security definer so it can serve anonymous confessions
-- without exposing who wrote them: author fields are NULL for is_anonymous rows
-- and the author_id column is not part of the result at all.
create or replace function public.list_public_posts(
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  body text,
  kind public.post_kind,
  media_urls text[],
  is_anonymous boolean,
  created_at timestamptz,
  author_display_name text,
  author_username text,
  author_avatar_url text,
  college_short_name text,
  like_count bigint,
  comment_count bigint
)
language sql stable security definer set search_path = ''
as $$
  select
    p.id,
    p.body,
    p.kind,
    p.media_urls,
    p.is_anonymous,
    p.created_at,
    case when p.is_anonymous then null else pr.display_name end,
    case when p.is_anonymous then null else pr.username end,
    case when p.is_anonymous then null else pr.avatar_url end,
    c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id)
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Rate-limited report. Members report posts, comments, profiles and messages
-- through this function; the reporter always owns the row they create.
create or replace function public.submit_report(
  p_reason text,
  p_post_id uuid default null,
  p_reported_user_id uuid default null,
  p_details text default null
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_recent integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to report content.';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'Please choose a reason.';
  end if;
  if p_post_id is null and p_reported_user_id is null
    and (p_details is null or char_length(trim(p_details)) < 10) then
    raise exception 'Nothing to report was supplied.';
  end if;

  select count(*) into v_recent
  from public.reports
  where reporter_id = auth.uid()
    and created_at > now() - interval '24 hours';

  if v_recent >= 20 then
    raise exception 'You have reached today''s report limit. Thanks for helping keep CAMPUS safe.';
  end if;

  insert into public.reports (reporter_id, post_id, reported_user_id, reason, details)
  values (auth.uid(), p_post_id, p_reported_user_id, trim(p_reason), nullif(trim(coalesce(p_details, '')), ''))
  returning id into v_id;

  return v_id;
end;
$$;

-- Rate-limited college suggestion. "Request a college" from the onboarding
-- wizard lands here; platform admins later approve it into public.colleges.
create or replace function public.request_college_suggestion(p_name text, p_city text default '')
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_recent integer;
  clean_name text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to suggest a college.';
  end if;

  clean_name := nullif(trim(p_name), '');
  if clean_name is null or char_length(clean_name) < 2 or char_length(clean_name) > 120 then
    raise exception 'Enter a college name between 2 and 120 characters.';
  end if;

  -- Already in the directory? Point the client at the existing record.
  if exists (
    select 1 from public.colleges
    where lower(name) = lower(clean_name)
      and (nullif(trim(p_city), '') is null or lower(city) = lower(trim(p_city)))
  ) then
    raise exception 'That college is already listed. Search for it instead.';
  end if;

  select count(*) into v_recent
  from public.college_suggestions
  where user_id = auth.uid()
    and created_at > now() - interval '24 hours';

  if v_recent >= 5 then
    raise exception 'You have reached today''s college suggestion limit.';
  end if;

  insert into public.college_suggestions (user_id, name, city)
  values (auth.uid(), clean_name, nullif(trim(coalesce(p_city, '')), ''))
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Grants for the new functions
-- ---------------------------------------------------------------------------
revoke all on function public.username_available(text) from public, anon;
grant execute on function public.username_available(text) to authenticated;

revoke all on function public.list_public_posts(integer, integer) from public;
grant execute on function public.list_public_posts(integer, integer) to anon, authenticated;

revoke all on function public.submit_report(text, uuid, uuid, text) from public, anon;
grant execute on function public.submit_report(text, uuid, uuid, text) to authenticated;

revoke all on function public.request_college_suggestion(text, text) from public, anon;
grant execute on function public.request_college_suggestion(text, text) to authenticated;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Avatar storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatar images are publicly readable" on storage.objects;
create policy "avatar images are publicly readable" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "users upload their own avatar" on storage.objects;
create policy "users upload their own avatar" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "users update their own avatar" on storage.objects;
create policy "users update their own avatar" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "users delete their own avatar" on storage.objects;
create policy "users delete their own avatar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 10. Optional: grant yourself platform administrator access
-- ---------------------------------------------------------------------------
-- After onboarding, promote your own account from the SQL Editor:
--   update public.profiles set role = 'admin'
--   where username = 'your_username';
-- Admins can approve college_suggestions and work the reports queue.
