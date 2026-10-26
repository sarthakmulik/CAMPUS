-- =====================================================================
-- 0047 — profile_stats post_count parity with the profile grid.
--
-- Confirmed defect: post_count counted every non-reel kind ('post',
-- 'poll', 'confession'), but the Profile page grid behind that number
-- renders ONLY plain posts (list_member_posts filters kind = 'post',
-- polls need poll-state tiles and anonymous confessions must never be
-- attributed on a profile). Result: a header reading "4 posts" above an
-- honestly-empty grid (caught live with a real member during the M17
-- profile probe).
--
-- Fix: count exactly what the grid shows — kind = 'post', is_anonymous
-- excluded (unchanged), is_published = true (unchanged). reel/follower/
-- following counts are untouched. profile_stats is consumed only by the
-- Profile header, so no other surface depends on the broader counting.
--
-- Same-signature rebuild: DROP + re-CREATE (the return row type does not
-- change, but the rebuild is idempotent and keeps callers untouched).
--
-- Verify after applying:
--   select * from profile_stats('<member with only polls/confessions>');
--   -- post_count must equal what the profile grid renders, not more.
--   -- Cross-check against list_member_posts member:
--   select count(*) from public.posts
--     where author_id = '<same>' and is_published = true
--       and kind = 'post' and is_anonymous = false;
--
-- Rollback: re-run the 0008 definition of profile_stats from that file's
-- history (wider post_count), or keep the app as-is — the UI stays honest
-- either way because it renders the grid, not the stat.
-- =====================================================================

drop function if exists public.profile_stats(uuid);

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
      where p.author_id = p_profile and p.is_published = true and p.kind = 'post' and p.is_anonymous = false),
    (select count(*) from public.posts p
      where p.author_id = p_profile and p.is_published = true and p.kind = 'reel' and p.is_anonymous = false),
    (select count(*) from public.follows f where f.followed_id = p_profile),
    (select count(*) from public.follows f where f.follower_id = p_profile)
$$;

revoke all on function public.profile_stats(uuid) from public;
grant execute on function public.profile_stats(uuid) to anon, authenticated;
