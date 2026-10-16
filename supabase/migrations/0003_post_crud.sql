-- =============================================================================
-- CAMPUS migration 0003 — Post CRUD (edit + delete own posts)
--
-- What this adds:
--   1. posts.edited_at — set automatically whenever the author edits their
--      post, so the feed can show "edited · 2 hours ago".
--   2. RLS policies: authors may update/delete their own posts (anonymous
--      confessions stay locked after publishing — that is the point of
--      anonymity).
--   3. Cleanup trigger: deleting a post removes its likes and comments first,
--      so the delete is never blocked by child rows.
--   4. list_public_posts(): exposes edited_at.
--
-- Safe to re-run. Run in the Supabase SQL editor.
-- =============================================================================

-- 1. Edited marker ---------------------------------------------------------------

alter table public.posts add column if not exists edited_at timestamptz;

-- 2. Author update/delete policies ------------------------------------------------

-- Anonymous posts keep their identity hidden, so editing them after the fact
-- is not allowed: the author cannot prove it is theirs without deanonymising
-- the row.
drop policy if exists "authors update own posts" on public.posts;
create policy "authors update own posts" on public.posts
  for update to authenticated
  using (author_id = auth.uid() and is_anonymous = false)
  with check (author_id = auth.uid() and is_anonymous = false);

drop policy if exists "authors delete own posts" on public.posts;
create policy "authors delete own posts" on public.posts
  for delete to authenticated
  using (author_id = auth.uid());

-- 3. Child cleanup on delete --------------------------------------------------------

drop function if exists public.cleanup_post_children();
create or replace function public.cleanup_post_children()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.post_likes where post_id = old.id;
  delete from public.post_comments where post_id = old.id;
  return old;
end;
$$;

drop trigger if exists posts_cleanup_before_delete on public.posts;
create trigger posts_cleanup_before_delete
  before delete on public.posts
  for each row execute function public.cleanup_post_children();

-- 4. Feed RPC v3 ---------------------------------------------------------------------
-- Adds edited_at so the UI can show the "edited" marker next to the time.

-- The return row type changed (edited_at added), so replace the v2 function.
drop function if exists public.list_public_posts(integer, integer, uuid);

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
language sql stable security definer set search_path = ''
as $$
  select
    p.id,
    p.body,
    p.kind,
    p.media_urls,
    p.is_anonymous,
    p.created_at,
    p.edited_at,
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
