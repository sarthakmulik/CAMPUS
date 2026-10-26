-- =====================================================================
-- 0045 — My College scoping: canonical indexes + college_id in search.
--   Additive only. Nothing existing is dropped or rewritten.
--
--   1. College-scoped queries (My College feed promotions, staff tools and
--      future server-side college feeds) walk posts by college → time, and
--      member discovery walks profiles by college.
--   2. search_members gains `college_id` in its RETURN TABLE so the client can
--      scope in-college search to the canonical ID instead of comparing short
--      names (My College acceptance: "use the stable college ID"). Short-name
--      matching stays in the UI only as a *fallback* for payloads sent before
--      this migration is applied. `is_verified` is explicitly RETAINED in the
--      return table — Search hall (SearchPanel) and My College render the
--      verified tick from it; dropping it would silently un-verify every
--      result row the day this migration runs.
-- 
--   RLS is untouched: search_members remains SECURITY DEFINER with the same
--   single-purpose visibility as 0010 (public + findable profiles, self
--   excluded); college_id is already public data on every visible row.
-- =====================================================================

create index if not exists posts_college_created_idx
  on public.posts (college_id, created_at desc);

create index if not exists profiles_college_idx
  on public.profiles (college_id)
  where college_id is not null;

-- Rebuilt from the 0010 definition — the return table is the 0010 column set
-- plus college_id, with is_verified retained. The function signature keeps
-- the same name/args so existing callers work unchanged (extra output columns
-- are purely additive).
create or replace function public.search_members(
  p_query text,
  p_limit integer default 10
)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  college_short_name text,
  is_private boolean,
  is_verified boolean,
  college_id uuid
)
language sql stable security definer set search_path = '' as $$
  select
    pr.id,
    pr.username,
    pr.display_name,
    pr.avatar_url,
    c.short_name,
    pr.is_private,
    pr.is_verified,
    pr.college_id
  from public.profiles pr
  left join public.colleges c on c.id = pr.college_id
  where btrim(p_query) <> ''
    and (pr.account_status is null or pr.account_status = 'active')
    and (
      pr.display_name ilike '%' || btrim(p_query) || '%'
      or pr.username ilike '%' || btrim(p_query) || '%'
      or pr.first_name ilike '%' || btrim(p_query) || '%'
      or pr.last_name ilike '%' || btrim(p_query) || '%'
    )
    and pr.id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  order by pr.display_name asc nulls last
  limit least(greatest(coalesce(p_limit, 10), 1), 25)
$$;

revoke all on function public.search_members(text, integer) from public;
grant execute on function public.search_members(text, integer) to anon, authenticated;
