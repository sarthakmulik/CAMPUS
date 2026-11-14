-- 0063 - LEADERBOARD: INSTITUTION-GROUP AND SHARED-CAMPUS BOARDS
--
-- APPLY ORDER: ... -> 0061 -> 0062 -> 0063.
--
-- Phase 7.9 asked for institution-level AND group-level rankings without
-- mixing unrelated institutions. 0027 already had a member-level 'college'
-- board resolved server-side from the caller's own college; this adds two
-- derived boards on the SAME functions (no new endpoint, no parallel
-- backend, identical signatures and return shapes):
--
--   'group'  - every member of every college in the caller's institution group
--   'campus' - every member of every college sharing one of their campuses
--
-- The scope is DERIVED per call from colleges.institution_group_id and the
-- 0062 campus helpers, never stored on a leaderboard row, so a board can never
-- contain two unrelated groups. Callers without a college still get
-- 'no_college' (leaderboard_me) or an empty board (list_leaderboard), exactly
-- as before. 'overall' / 'community' / 'creators' / 'events' are untouched.
--
-- Both bodies are copied verbatim from 0027 with only the scope resolution and
-- the scope filter replaced.

create or replace function public.list_leaderboard(
  p_category text default 'overall',
  p_period text default 'week',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  display_name text,
  username text,
  avatar_url text,
  is_verified boolean,
  college_short_name text,
  points bigint,
  competition_rank bigint,
  display_position bigint,
  last_earned_at timestamptz,
  previous_position bigint,
  movement integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_category text := coalesce(nullif(btrim(p_category), ''), 'overall');
  v_period text := coalesce(nullif(btrim(p_period), ''), 'week');
  v_since timestamptz;
  v_prev_since timestamptz;
  v_prev_until timestamptz;
  v_types text[];
  v_ctx text;
  v_college uuid;
  -- members whose colleges are in scope (empty = everyone)
  v_colleges uuid[] := '{}'::uuid[];
begin
  if v_category not in ('overall','college','community','creators','events','group','campus') then
    v_category := 'overall';
  end if;
  if v_period not in ('week','month','all') then
    v_period := 'week';
  end if;

  v_since := public.lb_period_boundary(v_period);
  v_prev_since := case
    when v_period = 'week' then v_since - interval '7 days'
    when v_period = 'month' then date_trunc('month', v_since) - interval '1 month'
    else '-infinity'::timestamptz end;
  v_prev_until := case when v_period = 'all' then '-infinity'::timestamptz else v_since end;
  v_types := public.lb_category_types(v_category);
  v_ctx := case when v_category in ('community','events') then v_category else null end;

  if v_category in ('college', 'group', 'campus') then
    select p.college_id into v_college from public.profiles p where p.id = auth.uid();
  end if;

  -- The group and campus boards are DERIVED from the caller's own college:
  -- institution group (colleges.institution_group_id) or shared physical
  -- campus (0062 helpers). Nothing is stored on the leaderboard, so a board
  -- can never mix two unrelated institution groups.
  if v_category = 'group' then
    select array(
      select c.id from public.colleges c
      where c.institution_group_id = public.college_group_id(v_college)
    ) into v_colleges;
  elsif v_category = 'campus' then
    select array(
      select c.id from public.colleges c
      where public.colleges_share_campus(c.id, v_college)
    ) into v_colleges;
  elsif v_college is not null then
    v_colleges := array[v_college];
  end if;

  return query
  with cur as (
    select
      le.user_id,
      sum(le.points)::bigint as score,
      max(le.created_at) as last_at
    from public.leaderboard_point_events le
    where le.created_at >= v_since
      and (cardinality(v_types) = 0 or le.activity_type = any (v_types))
      and (v_ctx is null or le.context = v_ctx)
    group by le.user_id
    having sum(le.points) > 0
  ),
  prev as (
    select
      le.user_id,
      sum(le.points)::bigint as score,
      max(le.created_at) as last_at
    from public.leaderboard_point_events le
    where le.created_at >= v_prev_since and le.created_at < v_prev_until
      and (cardinality(v_types) = 0 or le.activity_type = any (v_types))
      and (v_ctx is null or le.context = v_ctx)
    group by le.user_id
    having sum(le.points) > 0
  ),
  ranked_cur as (
    select
      c.user_id, c.score, c.last_at,
      rank() over (order by c.score desc) as rnk,
      row_number() over (order by c.score desc, c.last_at asc, c.user_id asc) as pos
    from cur c
  ),
  ranked_prev as (
    select
      p.user_id,
      row_number() over (order by p.score desc, p.last_at asc, p.user_id asc) as ppos
    from prev p
  )
  select
    r.user_id,
    u.display_name,
    u.username,
    u.avatar_url,
    u.is_verified,
    col.short_name,
    r.score,
    r.rnk,
    r.pos,
    r.last_at,
    pv.ppos,
    case when pv.ppos is null then null::integer
         else (r.pos - pv.ppos)::integer end
  from ranked_cur r
  join public.profiles u on u.id = r.user_id
  left join public.colleges col on col.id = u.college_id
  left join ranked_prev pv on pv.user_id = r.user_id
  where coalesce(cardinality(v_colleges), 0) = 0
     or (u.college_id = any (v_colleges))
  order by r.pos
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;

revoke all on function public.list_leaderboard(text, text, integer, integer) from public;
grant execute on function public.list_leaderboard(text, text, integer, integer) to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 2. leaderboard_me - the caller's own standing in the same scope      */
/* ------------------------------------------------------------------ */

create or replace function public.leaderboard_me(
  p_category text default 'overall',
  p_period text default 'week'
)
returns table (
  status text,
  points bigint,
  competition_rank bigint,
  display_position bigint,
  total_ranked bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_category text := coalesce(nullif(btrim(p_category), ''), 'overall');
  v_period text := coalesce(nullif(btrim(p_period), ''), 'week');
  v_types text[];
  v_ctx text;
  v_since timestamptz;
  v_college uuid;
  -- members whose colleges are in scope (empty = everyone)
  v_colleges uuid[] := '{}'::uuid[];
begin
  if v_category not in ('overall','college','community','creators','events','group','campus') then
    v_category := 'overall';
  end if;
  if v_period not in ('week','month','all') then
    v_period := 'week';
  end if;

  if v_me is null then
    return query select 'signed_out'::text, 0::bigint, null::bigint, null::bigint, 0::bigint;
    return;
  end if;

  if v_category in ('college', 'group', 'campus') then
    select p.college_id into v_college from public.profiles p where p.id = v_me;
    if v_college is null then
      return query select 'no_college'::text, 0::bigint, null::bigint, null::bigint, 0::bigint;
      return;
    end if;
  end if;

  -- The group and campus boards are DERIVED from the caller's own college:
  -- institution group (colleges.institution_group_id) or shared physical
  -- campus (0062 helpers). Nothing is stored on the leaderboard, so a board
  -- can never mix two unrelated institution groups.
  if v_category = 'group' then
    select array(
      select c.id from public.colleges c
      where c.institution_group_id = public.college_group_id(v_college)
    ) into v_colleges;
  elsif v_category = 'campus' then
    select array(
      select c.id from public.colleges c
      where public.colleges_share_campus(c.id, v_college)
    ) into v_colleges;
  elsif v_college is not null then
    v_colleges := array[v_college];
  end if;

  v_types := public.lb_category_types(v_category);
  v_ctx := case when v_category in ('community','events') then v_category else null end;
  v_since := public.lb_period_boundary(v_period);

  return query
  with scoped as (
    select
      le.user_id,
      sum(le.points)::bigint as score,
      max(le.created_at) as last_at
    from public.leaderboard_point_events le
    where le.created_at >= v_since
      and (cardinality(v_types) = 0 or le.activity_type = any (v_types))
      and (v_ctx is null or le.context = v_ctx)
      and (
        coalesce(cardinality(v_colleges), 0) = 0
        or le.user_id in (
          select p2.id from public.profiles p2
          where p2.college_id = any (v_colleges)
        )
      )
    group by le.user_id
    having sum(le.points) > 0
  ),
  ranked as (
    select
      s.user_id, s.score, s.last_at,
      rank() over (order by s.score desc) as rnk,
      row_number() over (order by s.score desc, s.last_at asc, s.user_id asc) as pos,
      count(*) over () as total
    from scoped s
  )
  select 'ok', r.score, r.rnk, r.pos, r.total
  from ranked r
  where r.user_id = v_me
  union all
  select 'ok', 0::bigint, null::bigint, null::bigint, (select count(*) from ranked)::bigint
  where not exists (select 1 from ranked where user_id = v_me)
  limit 1;
end $$;

revoke all on function public.leaderboard_me(text, text) from public;
grant execute on function public.leaderboard_me(text, text) to authenticated;
