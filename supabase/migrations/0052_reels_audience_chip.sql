-- ============================================================================
-- 0052 — AUDIENCE CHIP DATA + SEARCH GATE (cohesion pass)
--
-- 0049 gated the read RPCs with post_visible_to, but the functions still say
-- and return nothing about the value:
--   1. none of the three feed RPCs return p.audience, so the client treats
--      every post/reel as 'public' and the "My College" scope badge (PostCard
--      and the Discover reel slide's meta line) can never render. mapFeedRow
--      already understands the column.
--   2. search_posts (0016) predates 0049 and was not in its enforcement
--      list — it is a security-definer read of posts, so table RLS does not
--      apply and a keyword search could return the BODY of a college-scoped
--      post to anyone. Verified live: search_posts as anon/out-college
--      returned the hidden post. It now applies the same post_visible_to
--      rule (reports-restrained: staff accounts keep their normal reach via
--      post_visible_to's staff allowance).
--
-- Adds the trailing `audience` column (and the search gate) to:
--   - list_public_posts (Home feed + My College tab)
--   - list_public_reels (Discover reels)
--   - get_public_post   (deep links #p/<id>)
--   - list_member_posts (profile grids → opened cards keep their badge)
--   - search_posts      (Search / #hashtags: gated + column)
--
-- No other behavior change: visibility rules stay 0049's. Safe to re-run.
-- ============================================================================

-- 1. Home feed + My College ---------------------------------------------------
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
  author_is_verified boolean,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean,
  audience text
)
language sql stable security definer set search_path = '' as $$
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
    case when p.is_anonymous then null else pr.is_verified end,
    p.college_id,
    c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce(
      (select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
      false
    ),
    p.audience
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.community_id is null
    and not public.author_hidden(p.author_id)
    and public.post_visible_to(p.audience, p.college_id, p.author_id)
    and (p_college_id is null or p.college_id = p_college_id)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_public_posts(integer, integer, uuid) from public;
grant execute on function public.list_public_posts(integer, integer, uuid) to anon, authenticated;

-- 2. Discover reels -----------------------------------------------------------
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
  liked_by_me boolean,
  audience text
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
    ),
    p.audience
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.kind = 'reel'
    and coalesce(array_length(p.media_urls, 1), 0) > 0
    and public.post_visible_to(p.audience, p.college_id, p.author_id)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_public_reels(integer, integer) from public;
grant execute on function public.list_public_reels(integer, integer) to anon, authenticated;

-- 3. Deep links #p/<id> -------------------------------------------------------
drop function if exists public.get_public_post(uuid);
create or replace function public.get_public_post(
  p_post uuid
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
  author_is_verified boolean,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean,
  audience text
)
language sql stable security definer set search_path = '' as $$
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
    case when p.is_anonymous then null else pr.is_verified end,
    p.college_id,
    c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce(
      (select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
      false
    ),
    p.audience
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.id = p_post
    and p.is_published = true
    and public.post_visible_to(p.audience, p.college_id, p.author_id)
$$;

revoke all on function public.get_public_post(uuid) from public;
grant execute on function public.get_public_post(uuid) to anon, authenticated;

-- 4. Profile grids (cards opened from them render the same badge) -------------
drop function if exists public.list_member_posts(uuid, text, integer);
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
  liked_by_me boolean,
  audience text
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
    coalesce((select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()), false),
    p.audience
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.is_anonymous = false
    and p.community_id is null
    and p.author_id = p_profile
    and p.kind = (coalesce(nullif(btrim(p_kind), ''), 'post'))::public.post_kind
    and public.post_visible_to(p.audience, p.college_id, p.author_id)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 50)
$$;

revoke all on function public.list_member_posts(uuid, text, integer) from public;
grant execute on function public.list_member_posts(uuid, text, integer) to anon, authenticated;

-- 5. Search / #hashtags — ALSO the 0049 miss: gate visibility -----------------
drop function if exists public.search_posts(text, integer);
create or replace function public.search_posts(
  p_query text,
  p_limit integer default 10
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
  author_is_verified boolean,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean,
  audience text
)
language sql stable security definer set search_path = '' as $$
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
    case when p.is_anonymous then null else pr.is_verified end,
    p.college_id,
    c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce(
      (select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
      false
    ),
    p.audience
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.community_id is null
    -- 0049 gap: this definer read bypassed table RLS, so a keyword search
    -- could surface a college-only post's body to anyone. Same rule as the
    -- feeds now: nobody finds what they couldn't have seen.
    and public.post_visible_to(p.audience, p.college_id, p.author_id)
    and (
      p.body ilike '%' || btrim(p_query) || '%'
      or (
        btrim(p_query) <> ''
        and p.is_anonymous = false
        and (
          pr.display_name ilike '%' || btrim(p_query) || '%'
          or pr.username ilike '%' || btrim(p_query) || '%'
        )
      )
    )
  order by p.created_at desc
  limit greatest(least(coalesce(p_limit, 10), 25), 1)
$$;

revoke all on function public.search_posts(text, integer) from public;
grant execute on function public.search_posts(text, integer) to anon, authenticated;
