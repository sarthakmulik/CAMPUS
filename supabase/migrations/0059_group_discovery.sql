-- 0059 - INSTITUTION GROUP DISCOVERY (Phase 7)
--
-- Two additive RPCs over the 0057 hierarchy. Both answer ONE question each:
--
--   list_group_posts : the group-wide post feed. SECURITY INVOKER on purpose -
--     posts RLS + post_visible_to() enforce audience for the caller exactly as
--     they do for the existing feeds; this RPC adds zero visibility of its own.
--     It excludes the caller's OWN college (that stream is My College / For
--     You) and the caller's own posts, so the tab is genuinely "the rest of
--     my group". Callers without a college+group get an empty set.
--
--   list_group_peers : students from OTHER colleges of the caller's group
--     (public profiles only, blocks honoured both directions). Same contract
--     as the My College classmates strip - nothing assumed, nothing exposed
--     that profiles RLS does not already publish.
--
-- PULSE GROUP SCOPE - deliberately NOT in this migration (design note, kept
-- honest): pulse_scope_of() (0048) is architecturally per-college - "members
-- are ALWAYS scoped to their own college" - and every pulse insight row is
-- keyed by that scope with per-college participation thresholds. A group
-- scope means a second aggregation engine (group-level quorum, cross-campus
-- quorum, per-campus result buckets) so unrelated institutions' numbers are
-- never mixed. That engine deserves its own design round with real
-- thresholds; bolting group joins onto the per-college engine would fake it.
-- The two surfaces below are the Phase-7 group discovery shipped now.
--
-- Rollback: drop the two functions; no table or policy is touched.

-- ---------------------------------------------------------------------------
-- 1. list_group_posts(p_limit, p_offset)
--    Row shape = list_public_posts() (0052) so the client reuses mapFeedRow.
--    Offset pagination matches fetchFeedPage's contract.
-- ---------------------------------------------------------------------------
create or replace function public.list_group_posts(
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
  author_is_verified boolean,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean,
  audience text
)
language sql stable security invoker set search_path = '' as $$
  with me as (
    select pr.college_id as my_college, c.institution_group_id as my_group
    from public.profiles pr
    left join public.colleges c on c.id = pr.college_id
    where pr.id = auth.uid()
  )
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
  from me
  join public.colleges gc
    on gc.institution_group_id = me.my_group      -- nothing shared -> join yields 0 rows
   and gc.id <> me.my_college                     -- own college is the My College feed
  join public.posts p
    on p.college_id = gc.id
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and p.community_id is null
    and not public.author_hidden(p.author_id)
    and public.post_visible_to(p.audience, p.college_id, p.author_id)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_group_posts(integer, integer) from public;
grant execute on function public.list_group_posts(integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. list_group_peers(p_limit, p_offset)
--    Public members of the caller's group, excluding their own college,
--    themselves, suspended accounts and anyone they block / are blocked by.
--    SECURITY DEFINER like search_members; exposes only what the classmates
--    strip already exposes (public profiles of findable members).
-- ---------------------------------------------------------------------------
create or replace function public.list_group_peers(
  p_limit integer default 24,
  p_offset integer default 0
)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  course text,
  year_of_study smallint,
  is_verified boolean,
  college_id uuid,
  college_short_name text,
  group_name text
)
language sql stable security definer set search_path = '' as $$
  with me as (
    select pr.id as my_id, pr.college_id as my_college, c.institution_group_id as my_group
    from public.profiles pr
    left join public.colleges c on c.id = pr.college_id
    where pr.id = auth.uid()
  )
  select
    pr.id,
    pr.username,
    pr.display_name,
    pr.avatar_url,
    pr.course,
    pr.year_of_study,
    pr.is_verified,
    pr.college_id,
    c.short_name,
    g.name
  from me
  join public.colleges gc
    on gc.institution_group_id = me.my_group      -- nothing shared -> join yields 0 rows
   and gc.id <> me.my_college
  join public.profiles pr
    on pr.college_id = gc.id
   and pr.is_private = false
   and pr.role = 'member'
   and (pr.account_status is null or pr.account_status = 'active')
   and pr.id <> me.my_id
   and not exists (
         select 1 from public.user_blocks b
         where (b.blocker_id = me.my_id and b.blocked_id = pr.id)
            or (b.blocker_id = pr.id and b.blocked_id = me.my_id)
       )
  left join public.colleges c on c.id = pr.college_id
  left join public.institution_groups g on g.id = gc.institution_group_id
  order by pr.display_name asc nulls last, pr.id
  limit least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_group_peers(integer, integer) from public;
grant execute on function public.list_group_peers(integer, integer) to anon, authenticated;
