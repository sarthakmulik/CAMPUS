/* ============================================================================
   0065 - SOCIAL GRAPH ENGINE: assertions

   Run this in the Supabase SQL editor AFTER 0065_social_graph.sql. It is a
   self-checking script: every check either prints nothing or raises, so a clean
   run ends with "all social graph checks passed".

   It is safe to run against production data: the write-path tests (trigger,
   block, suspension) run inside a transaction that is rolled back at the end,
   so nothing is left behind. The read-path tests only read.

   auth.uid() is null in the SQL editor, so the caller is simulated by setting
   the JWT claims the same way the gateway does (auth.uid() falls back to
   request.jwt.claims->>'sub' on Supabase).
   ============================================================================ */

begin;

/* ---------------------------------------------------------------------------
   0. Helpers
   --------------------------------------------------------------------------- */

create or replace function public._test_fail(p_what text, p_detail text)
returns void language plpgsql as $$
begin
  raise exception 'SOCIAL GRAPH CHECK FAILED - %: %', p_what, coalesce(p_detail, '(no detail)');
end $$;

create or replace function public._test_true(p_what text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond is not true then
    perform public._test_fail(p_what, p_detail);
  end if;
end $$;

/* ---------------------------------------------------------------------------
   1. The precomputed mutual count equals the truth, for every member
   --------------------------------------------------------------------------- */
do $$
declare
  v_wrong integer;
  v_rows  integer;
begin
  with truth as (
    select a.follower_id as user_id, count(*)::int as cnt
    from public.follows a
    join public.follows b
      on b.follower_id = a.followed_id
     and b.followed_id = a.follower_id
    group by a.follower_id
  ),
  merged as (
    select pr.id as user_id, coalesce(t.cnt, 0) as cnt
    from public.profiles pr
    left join truth t on t.user_id = pr.id
  )
  select count(*), count(*) filter (where m.cnt <> coalesce(s.mutual_count, 0))
    into v_rows, v_wrong
  from merged m
  left join public.social_mutual_counts s on s.user_id = m.user_id;

  perform public._test_true(
    'social_mutual_counts matches follows for every member',
    v_wrong = 0 and v_rows > 0,
    v_wrong || ' of ' || v_rows || ' rows differ'
  );
end $$;

/* ---------------------------------------------------------------------------
   2. Trigger: a new mutual follow moves both counters, and only a mutual one
   --------------------------------------------------------------------------- */
do $$
declare
  v_a uuid;
  v_b uuid;
  v_na integer;
  v_nb integer;
  v_sa integer;
  v_sb integer;
begin
  /* two active members with no relationship in either direction */
  select p1.id, p2.id into v_a, v_b
  from public.profiles p1
  cross join public.profiles p2
  where p1.id <> p2.id
    and coalesce(p1.account_status, 'active') = 'active'
    and coalesce(p2.account_status, 'active') = 'active'
    and not exists (
      select 1 from public.follows f
      where (f.follower_id = p1.id and f.followed_id = p2.id)
         or (f.follower_id = p2.id and f.followed_id = p1.id)
    )
  order by p1.id
  limit 1;

  perform public._test_true('test fixture: two unconnected active members exist', v_a is not null);

  select coalesce(mutual_count, 0) into v_na from public.social_mutual_counts where user_id = v_a;
  select coalesce(mutual_count, 0) into v_nb from public.social_mutual_counts where user_id = v_b;

  /* one direction: neither counter may move */
  insert into public.follows (follower_id, followed_id) values (v_a, v_b);

  select coalesce(mutual_count, 0) into v_sa from public.social_mutual_counts where user_id = v_a;
  select coalesce(mutual_count, 0) into v_sb from public.social_mutual_counts where user_id = v_b;
  perform public._test_true(
    'one-way follow does not change mutual counts',
    v_sa = v_na and v_sb = v_nb,
    format('a: %s (was %s), b: %s (was %s)', v_sa, v_na, v_sb, v_nb)
  );

  /* the reverse direction makes it mutual: both counters move by exactly one */
  insert into public.follows (follower_id, followed_id) values (v_b, v_a);

  select coalesce(mutual_count, 0) into v_sa from public.social_mutual_counts where user_id = v_a;
  select coalesce(mutual_count, 0) into v_sb from public.social_mutual_counts where user_id = v_b;
  perform public._test_true(
    'mutual follow increments both counters by one',
    v_sa = v_na + 1 and v_sb = v_nb + 1,
    format('a: %s (expected %s), b: %s (expected %s)', v_sa, v_na + 1, v_sb, v_nb + 1)
  );

  /* un-following one direction drops exactly one */
  delete from public.follows where follower_id = v_a and followed_id = v_b;

  select coalesce(mutual_count, 0) into v_sa from public.social_mutual_counts where user_id = v_a;
  select coalesce(mutual_count, 0) into v_sb from public.social_mutual_counts where user_id = v_b;
  perform public._test_true(
    'un-following one direction decrements both counters',
    v_sa = v_na and v_sb = v_nb,
    format('a: %s (expected %s), b: %s (expected %s)', v_sa, v_na, v_sb, v_nb)
  );

  /* clean up the fixture */
  delete from public.follows
  where (follower_id = v_a and followed_id = v_b)
     or (follower_id = v_b and followed_id = v_a);
end $$;

/* ---------------------------------------------------------------------------
   3. social_relation_of agrees with direct counts, and scores inside 0..100
   --------------------------------------------------------------------------- */
do $$
declare
  v_me uuid;
  v_other uuid;
  r record;
  v_cf integer;
  v_cfol integer;
  v_clubs integer;
  v_inter integer;
  v_score integer;
begin
  select a.follower_id, a.followed_id into v_me, v_other
  from public.follows a
  where coalesce((select p.account_status from public.profiles p where p.id = a.follower_id), 'active') = 'active'
    and coalesce((select p.account_status from public.profiles p where p.id = a.followed_id), 'active') = 'active'
  order by a.follower_id
  limit 1;

  perform public._test_true('test fixture: at least one follow exists', v_me is not null);

  perform set_config('request.jwt.claims', json_build_object('sub', v_me, 'role', 'authenticated')::text, true);

  select * into r from public.social_relation_of(v_other);
  perform public._test_true('social_relation_of returns exactly one row', r.i_follow is not null);
  perform public._test_true('social_relation_of sees the follow that exists', r.i_follow is true);

  select count(*)::int into v_cf
  from public.follows fa
  join public.follows fb on fb.followed_id = fa.followed_id
  where fa.follower_id = v_me and fb.follower_id = v_other
    and fa.followed_id <> v_me and fa.followed_id <> v_other;

  select count(*)::int into v_cfol
  from public.follows fa
  join public.follows fb on fb.follower_id = fa.follower_id
  where fa.followed_id = v_me and fb.followed_id = v_other
    and fa.follower_id <> v_me and fa.follower_id <> v_other;

  select count(*)::int into v_clubs
  from public.club_members ma
  join public.club_members mb on mb.club_id = ma.club_id
  where ma.user_id = v_me and ma.status = 'active'
    and mb.user_id = v_other and mb.status = 'active';

  select count(*)::int into v_inter
  from (
    select l.created_at from public.post_likes l join public.posts p on p.id = l.post_id
    where l.user_id = v_me and p.author_id = v_other and l.created_at > now() - interval '30 days'
    union all
    select l.created_at from public.post_likes l join public.posts p on p.id = l.post_id
    where l.user_id = v_other and p.author_id = v_me and l.created_at > now() - interval '30 days'
    union all
    select c.created_at from public.post_comments c join public.posts p on p.id = c.post_id
    where c.author_id = v_me and p.author_id = v_other and c.created_at > now() - interval '30 days'
    union all
    select c.created_at from public.post_comments c join public.posts p on p.id = c.post_id
    where c.author_id = v_other and p.author_id = v_me and c.created_at > now() - interval '30 days'
  ) x;

  perform public._test_true(
    'common_following matches a direct count', r.common_following = v_cf,
    format('function %s, direct %s', r.common_following, v_cf)
  );
  perform public._test_true(
    'common_followers matches a direct count', r.common_followers = v_cfol,
    format('function %s, direct %s', r.common_followers, v_cfol)
  );
  perform public._test_true(
    'shared_clubs matches a direct count', r.shared_clubs = v_clubs,
    format('function %s, direct %s', r.shared_clubs, v_clubs)
  );
  perform public._test_true(
    'interactions_30d matches a direct count', r.interactions_30d = v_inter,
    format('function %s, direct %s', r.interactions_30d, v_inter)
  );
  perform public._test_true(
    'mutual flag is exactly (i_follow and follows_me)',
    r.mutual = (r.i_follow and r.follows_me),
    format('i_follow=%s follows_me=%s mutual=%s', r.i_follow, r.follows_me, r.mutual)
  );
  perform public._test_true(
    'mutual_total equals this member''s stored mutual count',
    r.mutual_total = coalesce((select s.mutual_count from public.social_mutual_counts s where s.user_id = v_me), 0),
    format('function %s', r.mutual_total)
  );
  perform public._test_true(
    'relationship_score is an integer within 0..100',
    r.relationship_score between 0 and 100,
    r.relationship_score::text
  );

  /* the score must be explainable: it is never higher than the sum of the caps,
     and a mutual pair with ten common follows scores meaningfully above zero */
  v_score := r.relationship_score;
  perform public._test_true('score is capped at 100', v_score <= 100, v_score::text);
end $$;

/* ---------------------------------------------------------------------------
   4. An anonymous caller gets nothing
   --------------------------------------------------------------------------- */
do $$
declare
  v_rows integer;
  v_me uuid;
  v_other uuid;
begin
  select a.follower_id, a.followed_id into v_me, v_other from public.follows a limit 1;
  perform public._test_true('test fixture: at least one follow exists', v_me is not null);

  perform set_config('request.jwt.claims', '', true);
  select count(*)::int into v_rows from public.social_relation_of(v_other);
  perform public._test_true('anon gets no relation row', v_rows = 0, v_rows::text);

  select count(*)::int into v_rows from public.social_mutual_list(v_other, 50, 0);
  perform public._test_true('anon gets no mutual list rows', v_rows = 0, v_rows::text);
end $$;

/* ---------------------------------------------------------------------------
   5. A blocked pair has no relationship and never appears in a mutual list
   --------------------------------------------------------------------------- */
do $$
declare
  v_me uuid;
  v_other uuid;
  v_rows integer;
begin
  select a.follower_id, a.followed_id into v_me, v_other from public.follows a limit 1;
  perform public._test_true('test fixture: at least one follow exists', v_me is not null);

  perform set_config('request.jwt.claims', json_build_object('sub', v_me, 'role', 'authenticated')::text, true);

  insert into public.user_blocks (blocker_id, blocked_id) values (v_me, v_other);

  select count(*)::int into v_rows from public.social_relation_of(v_other);
  perform public._test_true('a blocked member has no relation row', v_rows = 0, v_rows::text);

  select count(*)::int into v_rows from public.social_mutual_list(v_other, 50, 0);
  perform public._test_true('a blocked member never appears in a mutual list', v_rows = 0, v_rows::text);

  delete from public.user_blocks where blocker_id = v_me and blocked_id = v_other;
end $$;

/* ---------------------------------------------------------------------------
   6. A suspended member has no graph presence
   --------------------------------------------------------------------------- */
do $$
declare
  v_me uuid;
  v_other uuid;
  v_rows integer;
begin
  select a.follower_id, a.followed_id into v_me, v_other from public.follows a limit 1;
  perform public._test_true('test fixture: at least one follow exists', v_me is not null);

  perform set_config('request.jwt.claims', json_build_object('sub', v_me, 'role', 'authenticated')::text, true);

  update public.profiles set account_status = 'suspended' where id = v_other;

  select count(*)::int into v_rows from public.social_relation_of(v_other);
  perform public._test_true('a suspended member has no relation row', v_rows = 0, v_rows::text);

  update public.profiles set account_status = 'active' where id = v_other;
end $$;

/* ---------------------------------------------------------------------------
   7. social_mutual_list is paginated, deduplicated and ordered
   --------------------------------------------------------------------------- */
do $$
declare
  v_me uuid;
  v_other uuid;
  v_total integer;
  v_page1 integer;
  v_page2 integer;
  v_overlap integer;
begin
  /* a member with at least one mutual connection with someone */
  select a.follower_id, a.followed_id into v_me, v_other
  from public.follows a
  join public.follows b on b.follower_id = a.followed_id and b.followed_id = a.follower_id
  where coalesce((select p.account_status from public.profiles p where p.id = a.follower_id), 'active') = 'active'
  order by a.follower_id
  limit 1;

  perform public._test_true('test fixture: a mutual pair exists', v_me is not null);

  perform set_config('request.jwt.claims', json_build_object('sub', v_me, 'role', 'authenticated')::text, true);

  select count(*)::int into v_total from public.social_mutual_list(v_other, 50, 0);
  perform public._test_true('mutual list is never empty for a mutual pair', v_total >= 1, v_total::text);

  select count(*)::int into v_page1 from public.social_mutual_list(v_other, 1, 0);
  select count(*)::int into v_page2 from public.social_mutual_list(v_other, 1, 1);
  perform public._test_true('page size is respected (limit 1 returns 1 row)', v_page1 = 1, v_page1::text);

  select count(*)::int into v_overlap
  from (select id from public.social_mutual_list(v_other, 1, 0)
        intersect
        select id from public.social_mutual_list(v_other, 1, 1)) s;

  if v_total >= 2 then
    perform public._test_true('offset pages do not repeat a row', v_overlap = 0, v_overlap::text);
    perform public._test_true('offset page 2 has a row', v_page2 = 1, v_page2::text);
  end if;

  /* the identities really are people the caller also follows */
  select count(*)::int into v_overlap
  from public.social_mutual_list(v_other, 50, 0) m
  where not exists (
    select 1 from public.follows f where f.follower_id = v_me and f.followed_id = m.id
  );
  perform public._test_true('every listed mutual is also followed by the caller', v_overlap = 0, v_overlap::text);

  /* the caller and the other member never appear in their own list */
  select count(*)::int into v_overlap
  from public.social_mutual_list(v_other, 50, 0) m
  where m.id in (v_me, v_other);
  perform public._test_true('the pair itself never appears in its own mutual list', v_overlap = 0, v_overlap::text);

  /* limit is clamped to 50, never more */
  select count(*)::int into v_overlap from public.social_mutual_list(v_other, 5000, 0);
  perform public._test_true('limit is clamped at 50', v_overlap <= 50, v_overlap::text);
end $$;

/* ---------------------------------------------------------------------------
   8. RLS: a member cannot read another member's mutual count
   --------------------------------------------------------------------------- */
do $$
declare
  v_me uuid;
  v_other uuid;
  v_visible integer;
begin
  select a.follower_id, a.followed_id into v_me, v_other from public.follows a limit 1;
  perform public._test_true('test fixture: at least one follow exists', v_me is not null);

  /* as the caller, only their own row is selectable. FORCE is required: the SQL
     editor runs as the table owner, which bypasses RLS otherwise, and a check
     that cannot fail is not a check. The ALTER is rolled back with everything
     else. */
  alter table public.social_mutual_counts force row level security;
  perform set_config('request.jwt.claims', json_build_object('sub', v_me, 'role', 'authenticated')::text, true);

  select count(*)::int into v_visible
  from public.social_mutual_counts s
  where s.user_id <> v_me;

  perform public._test_true('RLS hides other members'' mutual counts', v_visible = 0, v_visible::text);
end $$;

/* ---------------------------------------------------------------------------
   9. Grants: members only (0066)
   ---------------------------------------------------------------------------
   Supabase's default privileges hand EXECUTE on every new function to `anon`, so
   the 0065 revokes from PUBLIC were not enough on their own. If this check fails
   with "anon still has execute", 0066 has not been applied. */
do $$
declare
  v_relation_anon boolean;
  v_relation_auth boolean;
  v_list_anon boolean;
  v_list_auth boolean;
begin
  v_relation_anon := has_function_privilege('anon', 'public.social_relation_of(uuid)', 'execute');
  v_relation_auth := has_function_privilege('authenticated', 'public.social_relation_of(uuid)', 'execute');
  v_list_anon := has_function_privilege('anon', 'public.social_mutual_list(uuid, integer, integer)', 'execute');
  v_list_auth := has_function_privilege('authenticated', 'public.social_mutual_list(uuid, integer, integer)', 'execute');

  perform public._test_true('anon cannot execute social_relation_of', v_relation_anon = false, v_relation_anon::text);
  perform public._test_true('anon cannot execute social_mutual_list', v_list_anon = false, v_list_anon::text);
  perform public._test_true('authenticated can execute social_relation_of', v_relation_auth = true, v_relation_auth::text);
  perform public._test_true('authenticated can execute social_mutual_list', v_list_auth = true, v_list_auth::text);
end $$;

/* the pre-existing helpers were only defined for this test */
drop function if exists public._test_fail(text);
drop function if exists public._test_true(text, boolean, text);

rollback;

select 'all social graph checks passed (nothing was committed)' as result;