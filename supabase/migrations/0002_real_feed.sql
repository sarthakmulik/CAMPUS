-- =============================================================================
-- CAMPUS migration 0002 — Real feed backend
--
-- What this adds:
--   1. list_public_posts(): liked_by_me (per call), author_id (never exposed
--      for anonymous posts), an optional college scope parameter.
--   2. A public 'media' storage bucket + policies so post images and reel
--      videos can be uploaded. (The 'avatars' bucket already exists from
--      migration 0001.)
--
-- There is NO seed/mock data in this migration: the feed starts empty and is
-- filled by real members posting.
--
-- Safe to re-run. Run in the Supabase SQL editor (same as 0001).
-- =============================================================================

-- 1. Feed RPC v2 ---------------------------------------------------------------

-- Migration 0001 created a two-argument version. Remove it so PostgREST never
-- has to choose between overloads when callers omit p_college_id.
drop function if exists public.list_public_posts(integer, integer);

-- Public feed read. security definer so anonymous visitors can read rows even
-- where RLS on posts is restrictive. Identity fields stay NULL for
-- is_anonymous posts and author_id is never returned for them.
create or replace function public.list_public_posts(
  p_limit integer default 20,
  p_offset integer default 0,
  p_college_id uuid default null
)
returns table (
  id uuid,
  body text,
  kind public.post_kind,
  media_urls text[],
  is_anonymous boolean,
  created_at timestamptz,
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
language sql stable security definer set search_path = ''
as $$
  select
    p.id,
    p.body,
    p.kind,
    p.media_urls,
    p.is_anonymous,
    p.created_at,
    case when p.is_anonymous then null else p.author_id end,
    case when p.is_anonymous then null else pr.display_name end,
    case when p.is_anonymous then null else pr.username end,
    case when p.is_anonymous then null else pr.avatar_url end,
    p.college_id,
    c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce(
      (select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
      false
    )
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and (p_college_id is null or p.college_id = p_college_id)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Every visitor (including anonymous) may read the public feed.
revoke all on function public.list_public_posts(integer, integer, uuid) from public;
grant execute on function public.list_public_posts(integer, integer, uuid) to anon, authenticated;

-- 2. Media storage (post images + reel videos) ----------------------------------

insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do update set public = true;

-- Everything in 'media' (and 'avatars') can be viewed by anyone: posts show
-- public URLs of the files they reference.
drop policy if exists "campus media publicly readable" on storage.objects;
create policy "campus media publicly readable" on storage.objects
  for select using (bucket_id in ('media', 'avatars'));

-- Signed-in members may upload into their own folder: userId/filename.
drop policy if exists "members upload campus media" on storage.objects;
create policy "members upload campus media" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('media', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text);

-- Members may replace or remove files in their own folder.
drop policy if exists "members manage own campus media" on storage.objects;
create policy "members manage own campus media" on storage.objects
  for update to authenticated
  using (bucket_id in ('media', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id in ('media', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "members delete own campus media" on storage.objects;
create policy "members delete own campus media" on storage.objects
  for delete to authenticated
  using (bucket_id in ('media', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text);
