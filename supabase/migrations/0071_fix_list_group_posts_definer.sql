-- 0071 - FIX list_group_posts 42501 ("permission denied for table posts")
--
-- Discovered during the Campus Pulse audit (2026-11-17): every signed-in
-- member's browser logs a 403 on /rest/v1/rpc/list_group_posts at boot, and
-- the institution-group feed ("For You" cross-college discovery) never loads.
--
-- Root cause chain:
--   * 0046 (confession anonymity) narrowed SELECT on public.posts to
--     column-level grants for every column EXCEPT author_id — on purpose:
--     a direct `?select=author_id` must not deanonymize anonymous posts.
--   * 0059 wrote list_group_posts as SECURITY INVOKER "so posts RLS still
--     decides", but the body READS p.author_id (to mask it for anonymous
--     posts and to run author_hidden()/post_visible_to()). Under INVOKER the
--     column privilege is checked on every reference — the caller (member)
--     has no author_id grant → 42501 for EVERY invocation, anonymous or not.
--   * 0052 already established the correct pattern: post-listing RPCs are
--     SECURITY DEFINER and enforce visibility inside the body. This function
--     already does exactly that (is_published, community_id is null,
--     group-scoped join, post_visible_to(), author_hidden(), and author
--     identity masked with `case when p.is_anonymous then null ... end`), so
--     flipping it to DEFINER changes nothing about what a member can learn —
--     it only lets the function itself read the column it needs to HIDE.
--
-- No policy is touched, no privilege widened for callers, no body change.
-- Idempotent: replace-in-place (same signature), grant kept identical to 0059.
-- Sanity guard fails loudly if the flip was not effective.

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
language sql stable security definer set search_path = '' as $$
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
grant execute on function public.list_group_posts(integer, integer) to authenticated;
-- SECURITY INVOKER was the reason anon lost the grant in 0061; under DEFINER
-- anon could technically call it, but the group feed is a member surface —
-- keep the 0061 narrowing and grant to authenticated only.

-- Sanity guard: the function must now be definer and callable by members.
-- (pg_get_functiondef is version-proof: pg_proc.prosec was removed in PG 14+,
--  which is what broke this check on the live project.)
do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.list_group_posts(integer, integer)'::regprocedure)
    into v_def;
  if v_def is null then
    raise exception '0071 check failed: list_group_posts is missing';
  elsif v_def not ilike '%security definer%' then
    raise exception '0071 check failed: list_group_posts is not SECURITY DEFINER';
  end if;
end $$;
