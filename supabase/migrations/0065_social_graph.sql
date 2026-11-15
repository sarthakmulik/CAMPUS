/* ============================================================================
   0065 - SOCIAL GRAPH ENGINE (Phase B)

   Adds the relationships the recommendation engine needs, without a second
   social system. `follows` stays the only source of truth for who follows whom:
   this migration only indexes it better, precomputes the ONE aggregate that is
   genuinely O(n) to derive (how many mutual connections a member has), and
   exposes read-only, access-checked functions for everything else.

   What already existed (reused, not duplicated):
     - public.follows (follower_id, followed_id)          -- 0001/0008
     - public.user_blocks / public.user_mutes              -- 0001
     - public.club_members (status active/pending/banned)  -- 0016
     - public.post_likes / post_bookmarks / post_comments  -- 0001/0005
     - public.profiles (college_id, department_id, campus_id, account_status)
     - public.account_can_write() / author_hidden()        -- 0043
     - leaderboard_point_events (engagement ledger)        -- 0027

   What this adds:
     1. Indexes the graph queries actually use. follows already had
        (followed_id) from 0008 and the PK gives (follower_id, followed_id);
        missing were the reverse-direction scans for interaction signals.
     2. social_mutual_counts - one row per member: how many of their follows are
        mutual. Maintained incrementally by an AFTER INSERT/DELETE trigger on
        follows (O(1) per event, no recount), backfilled once, re-runnable.
     3. social_relation_of(p_other) - the full pairwise relation for the caller:
        one-way / mutual / common followed / common followers / shared active
        communities / same college / same department / same campus / meaningful
        interactions in the last 30 days / a capped, explainable score.
     4. social_mutual_list(p_other) - paginated identities behind
        "N mutual connections", so the UI never loads a follower list into memory.

   Access rules (enforced in SQL, never in the client):
     - Caller identity comes from auth.uid(); anon gets no rows at all.
     - Suspended accounts are excluded on both sides (0043 rule).
     - Mutual-block pairs are excluded from lists.
     - Only public profile columns are returned.

   Re-runnable: every object is created with IF NOT EXISTS / CREATE OR REPLACE,
   and the backfill is an idempotent upsert.
   ============================================================================ */

/* ---------------------------------------------------------------------------
   1. Indexes
   ---------------------------------------------------------------------------
   follows: PK(follower_id, followed_id) already serves "who do I follow" and
   (followed_id) from 0008 serves "who follows me". Both directions of the
   pairwise lookup are therefore already indexed; nothing to add.

   Interaction signals are the gap: post_likes had only its PK (post_id,
   user_id), so "what did this member like recently" had no usable index, and
   post_comments had (post_id, created_at) only. club_members had no (user_id)
   index, so "which active communities do these two share" scanned. */

create index if not exists post_likes_user_time_idx
  on public.post_likes (user_id, created_at desc);

create index if not exists post_comments_author_time_idx
  on public.post_comments (author_id, created_at desc);

create index if not exists club_members_user_status_idx
  on public.club_members (user_id, club_id) where status = 'active';

/* ---------------------------------------------------------------------------
   2. Precomputed mutual count
   ---------------------------------------------------------------------------
   "How many mutual connections does this member have" is a count over the
   intersection of two edge sets - O(followers) every time it is asked for, on
   the one screen (a profile header) that is opened constantly. The count is
   therefore stored, and kept correct by a trigger on the only table that can
   change it.

   RLS: a member may read their own row only. The number is not a secret from
   the member it belongs to, and nobody else needs it: pairwise mutual-ness for
   a viewer is answered by social_relation_of(). */

create table if not exists public.social_mutual_counts (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  mutual_count   integer not null default 0 check (mutual_count >= 0),
  recalculated_at timestamptz not null default now()
);

create index if not exists social_mutual_counts_count_idx
  on public.social_mutual_counts (mutual_count desc);

alter table public.social_mutual_counts enable row level security;

drop policy if exists "own mutual count is readable" on public.social_mutual_counts;
create policy "own mutual count is readable"
  on public.social_mutual_counts
  for select
  using (user_id = auth.uid());

/* Incremental maintenance. Only a follow whose reverse already exists (or
   disappears) changes a mutual count, so the common case is one index probe and
   no write at all. Upserts are used rather than UPDATEs so a member created
   after the backfill still gets their first mutual counted. */
create or replace function public.social_mutual_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if exists (
      select 1 from public.follows f
      where f.follower_id = new.followed_id
        and f.followed_id = new.follower_id
    ) then
      insert into public.social_mutual_counts (user_id, mutual_count, recalculated_at)
      values (new.follower_id, 1, now())
      on conflict (user_id) do update
        set mutual_count = public.social_mutual_counts.mutual_count + 1,
            recalculated_at = now();

      insert into public.social_mutual_counts (user_id, mutual_count, recalculated_at)
      values (new.followed_id, 1, now())
      on conflict (user_id) do update
        set mutual_count = public.social_mutual_counts.mutual_count + 1,
            recalculated_at = now();
    end if;

  elsif tg_op = 'DELETE' then
    -- the row is already gone here; the reverse edge is what decides whether a
    -- mutual relationship existed a moment ago
    if exists (
      select 1 from public.follows f
      where f.follower_id = old.followed_id
        and f.followed_id = old.follower_id
    ) then
      insert into public.social_mutual_counts (user_id, mutual_count, recalculated_at)
      values (old.follower_id, 0, now())
      on conflict (user_id) do update
        set mutual_count = greatest(public.social_mutual_counts.mutual_count - 1, 0),
            recalculated_at = now();

      insert into public.social_mutual_counts (user_id, mutual_count, recalculated_at)
      values (old.followed_id, 0, now())
      on conflict (user_id) do update
        set mutual_count = greatest(public.social_mutual_counts.mutual_count - 1, 0),
            recalculated_at = now();
    end if;
  end if;

  return null;
end;
$$;

drop trigger if exists follows_mutual_sync on public.follows;
create trigger follows_mutual_sync
  after insert or delete on public.follows
  for each row execute function public.social_mutual_sync();

/* One-time backfill (idempotent: safe to re-run, and re-derives the truth if the
   trigger was ever disabled). Recomputes from follows rather than trusting the
   table, so it is also the repair path. */
insert into public.social_mutual_counts (user_id, mutual_count, recalculated_at)
select a.follower_id, count(*), now()
from public.follows a
join public.follows b
  on b.follower_id = a.followed_id
 and b.followed_id = a.follower_id
group by a.follower_id
on conflict (user_id) do update
  set mutual_count = excluded.mutual_count,
      recalculated_at = now();

/* members whose mutual count is zero and who have no row yet */
insert into public.social_mutual_counts (user_id, mutual_count, recalculated_at)
select pr.id, 0, now()
from public.profiles pr
where not exists (
  select 1 from public.social_mutual_counts smc where smc.user_id = pr.id
)
on conflict (user_id) do nothing;

/* ---------------------------------------------------------------------------
   3. Pairwise relation
   ---------------------------------------------------------------------------
   One round trip for the whole relation, computed from indexed lookups only.
   `relationship_score` is deliberately computed HERE, not in the client: the
   score decides what a member sees, so it must not be a client-supplied number.

   Score model - every component capped, so no single signal can dominate:
     mutual follow ............ 18   (binary)
     common followed accounts . 22   (capped at 10)
     common followers ......... 12   (capped at 10)
     shared active communities  14   (capped at 5)
     same college ............. 8
     same department .......... 6
     meaningful interactions .. 16   (capped at 20 in 30 days)
     interaction recency ...... 4   (any interaction in the last 7 days)
   Maximum 100. Declared interests are intentionally NOT in this model yet: they
   enter through the interest engine (Phase E) so the weight stays testable.
   A suspended member has no graph presence, and a blocked pair scores nothing. */
create or replace function public.social_relation_of(p_other uuid)
returns table (
  i_follow          boolean,
  follows_me        boolean,
  mutual            boolean,
  mutual_total      integer,
  common_following  integer,
  common_followers  integer,
  shared_clubs      integer,
  same_college      boolean,
  same_department   boolean,
  same_campus       boolean,
  interactions_30d  integer,
  last_interaction_at timestamptz,
  relationship_score integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select pr.id, pr.college_id, pr.department_id, pr.campus_id
    from public.profiles pr
    where pr.id = auth.uid()
      and coalesce(pr.account_status, 'active') = 'active'
  ),
  other as (
    select pr.id, pr.college_id, pr.department_id, pr.campus_id
    from public.profiles pr
    where pr.id = p_other
      and coalesce(pr.account_status, 'active') = 'active'
      and pr.id <> auth.uid()
      -- a mutual block removes the relationship in both directions
      and not exists (
        select 1 from public.user_blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = pr.id)
           or (b.blocker_id = pr.id and b.blocked_id = auth.uid())
      )
  ),
  edge as (
    select
      exists (
        select 1 from public.follows f
        where f.follower_id = me.id and f.followed_id = other.id
      ) as i_follow,
      exists (
        select 1 from public.follows f
        where f.follower_id = other.id and f.followed_id = me.id
      ) as follows_me
    from me, other
  ),
  tally as (
    select
      coalesce((
        select smc.mutual_count from public.social_mutual_counts smc
        where smc.user_id = me.id
      ), 0)::int as mutual_total,
      (
        select count(*)::int
        from public.follows fa
        join public.follows fb on fb.followed_id = fa.followed_id
        where fa.follower_id = me.id
          and fb.follower_id = other.id
          and fa.followed_id <> me.id
          and fa.followed_id <> other.id
      ) as common_following,
      (
        select count(*)::int
        from public.follows fa
        join public.follows fb on fb.follower_id = fa.follower_id
        where fa.followed_id = me.id
          and fb.followed_id = other.id
          and fa.follower_id <> me.id
          and fa.follower_id <> other.id
      ) as common_followers,
      (
        select count(*)::int
        from public.club_members ma
        join public.club_members mb on mb.club_id = ma.club_id
        where ma.user_id = me.id and ma.status = 'active'
          and mb.user_id = other.id and mb.status = 'active'
      ) as shared_clubs
    from me, other
  ),
  interactions as (
    select count(*)::int as interaction_count, max(x.created_at) as last_at
    from me
    cross join other
    /* LATERAL is required, not decorative: the branches correlate against me and
       other, and a FROM subquery can only see FROM items that precede it when it
       is declared LATERAL. Each of me/other is at most one row. */
    cross join lateral (
      select l.created_at
      from public.post_likes l
      join public.posts p on p.id = l.post_id
      where l.user_id = me.id and p.author_id = other.id
        and l.created_at > now() - interval '30 days'
      union all
      select l.created_at
      from public.post_likes l
      join public.posts p on p.id = l.post_id
      where l.user_id = other.id and p.author_id = me.id
        and l.created_at > now() - interval '30 days'
      union all
      select c.created_at
      from public.post_comments c
      join public.posts p on p.id = c.post_id
      where c.author_id = me.id and p.author_id = other.id
        and c.created_at > now() - interval '30 days'
      union all
      select c.created_at
      from public.post_comments c
      join public.posts p on p.id = c.post_id
      where c.author_id = other.id and p.author_id = me.id
        and c.created_at > now() - interval '30 days'
    ) x
  )
  select
    e.i_follow,
    e.follows_me,
    (e.i_follow and e.follows_me) as mutual,
    t.mutual_total,
    t.common_following,
    t.common_followers,
    t.shared_clubs,
    (me.college_id is not null and me.college_id = other.college_id) as same_college,
    (me.department_id is not null and me.department_id = other.department_id) as same_department,
    (me.campus_id is not null and me.campus_id = other.campus_id) as same_campus,
    i.interaction_count,
    i.last_at,
    (
      18 * (case when e.i_follow and e.follows_me then 1 else 0 end)
      + 22 * (least(t.common_following, 10) / 10.0)
      + 12 * (least(t.common_followers, 10) / 10.0)
      + 14 * (least(t.shared_clubs, 5) / 5.0)
      + 8  * (case when me.college_id is not null and me.college_id = other.college_id then 1 else 0 end)
      + 6  * (case when me.department_id is not null and me.department_id = other.department_id then 1 else 0 end)
      + 16 * (least(i.interaction_count, 20) / 20.0)
      + 4  * (case when i.last_at > now() - interval '7 days' then 1 else 0 end)
    )::int as relationship_score
  from me
  join other on true
  cross join edge e
  cross join tally t
  cross join interactions i
$$;

revoke all on function public.social_relation_of(uuid) from public;
grant execute on function public.social_relation_of(uuid) to authenticated;

/* ---------------------------------------------------------------------------
   4. The identities behind "N mutual connections"
   ---------------------------------------------------------------------------
   Paginated on purpose: the caller asks for 12 at a time, so opening a profile
   never pulls a follower list into memory. Only public profile columns leave the
   function, and a blocked pair never appears. */
create or replace function public.social_mutual_list(
  p_other uuid,
  p_limit  integer default 12,
  p_offset integer default 0
)
returns table (
  id           uuid,
  username     text,
  display_name text,
  avatar_url   text
)
language sql
stable
security definer
set search_path = ''
as $$
  select pr.id, pr.username, pr.display_name, pr.avatar_url
  from public.follows fa
  join public.follows fb on fb.followed_id = fa.followed_id
  join public.profiles pr on pr.id = fa.followed_id
  where fa.follower_id = auth.uid()
    and fb.follower_id = p_other
    and pr.id <> auth.uid()
    and pr.id <> p_other
    and coalesce(pr.account_status, 'active') = 'active'
    and not exists (
      select 1 from public.user_blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = pr.id)
         or (b.blocker_id = pr.id and b.blocked_id = auth.uid())
    )
  order by pr.display_name asc nulls last, pr.id asc
  limit least(greatest(coalesce(p_limit, 12), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.social_mutual_list(uuid, integer, integer) from public;
grant execute on function public.social_mutual_list(uuid, integer, integer) to authenticated;