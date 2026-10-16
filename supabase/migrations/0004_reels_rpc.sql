-- =============================================================================
-- CAMPUS migration 0004 — Discover reels feed
--
-- Dedicated RPC for the Discover page: returns only Reel posts (kind =
-- 'reel') with the same shape as list_public_posts, so the reel feed gets
-- live like counts, live liked_by_me state and author info in one call.
--
-- Safe to re-run. Run in the Supabase SQL editor.
-- =============================================================================

drop function if exists public.list_public_reels(integer, integer);

create or replace function public.list_public_reels(
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
language sql
stable
security definer
set search_path = ''
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
    and p.kind = 'reel'
    and coalesce(array_length(p.media_urls, 1), 0) > 0
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_public_reels(integer, integer) from public;
grant execute on function public.list_public_reels(integer, integer) to anon, authenticated;
