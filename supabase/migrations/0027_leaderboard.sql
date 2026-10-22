/* =====================================================================
   0027_leaderboard.sql — CAMPUS Complete Leaderboard System
   ---------------------------------------------------------------------
   A trusted, ledger-based contribution-scoring system:

     leaderboard_point_events  — append-only ledger (awards + reversals)
     leaderboard_weights       — centralized points configuration
     lb_award()/lb_reverse()   — definer helpers used ONLY by triggers
     row-level triggers        — capture real activity on existing tables
     list_leaderboard()        — paginated rankings (category + period)
     leaderboard_me()          — the viewer's own standing in a category
     list_my_achievements()    — milestones, computed on read, never stored
     leaderboard_rules()       — current weights, for the UI rules sheet

   Core guarantees:
   - Clients cannot touch the ledger: RLS is enabled with NO policies, so
     every direct read/write is denied for anon + authenticated. Scores
     are produced exclusively by row triggers on tables whose writes are
     already policed by existing RLS and security-definer RPCs (posts,
     likes, comments, comment likes, bookmarks, resources, events,
     organizer-verified attendance).
   - Idempotency: every award carries a dedup_key unique across the
     ledger; the helper itself re-checks before inserting, so replays,
     re-entrant triggers and idempotent upserts can only ever pay once.
   - Reversals are compensating entries (dedup_key 'rev:<award key>'),
     written only when their award exists. Delete-branch triggers call
     lb_reverse directly and never consult the (already expiring) source
     table — the ledger itself is the source of truth for what to undo.
     A reversal for a never-awarded action is a no-op.
   - Self-engagement earns nothing; the author's own actions on their
     content are always excluded.
   - Anonymous content (confessions) earns nothing — crediting points
     against an anonymous post would deanonymize it through the board.
   - Engagement on restricted content (private/hidden communities) earns
     nothing: it is invisible to outsiders and must not feed a public
     scoreboard — this closes the widest farming surface.
   - Daily caps throttle authoring volume (posts/reels/resources/events/
     comments) and a hard received-engagement cap per UTC day bounds
     like-ring collusion.
   - Unknown/disabled weight rows mean that activity is simply not
     scored (fail-quiet); eligibility rules fail closed for privacy.
   ===================================================================== */

/* ------------------------------------------------------------------ */
/* 1. The points ledger                                                */
/* ------------------------------------------------------------------ */

create table if not exists public.leaderboard_point_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  activity_type text not null,
  /* main = campus feed & profiles; community = inside a community;
     events = the Events system */
  context text not null default 'main' check (context in ('main','community','events')),
  source_type text,
  source_id uuid,
  /* positive = award, negative = compensating reversal */
  points integer not null,
  created_at timestamptz not null default now(),
  /* at most one award — and one reversal — per underlying action */
  dedup_key text not null unique
);

create index if not exists leaderboard_events_user_time_idx
  on public.leaderboard_point_events (user_id, created_at desc);
create index if not exists leaderboard_events_type_day_idx
  on public.leaderboard_point_events (activity_type, created_at);
create index if not exists leaderboard_events_scope_idx
  on public.leaderboard_point_events (activity_type, context, created_at);
create index if not exists leaderboard_events_source_idx
  on public.leaderboard_point_events (source_type, source_id);

/* RLS with NO policies: direct reads/writes are denied for everyone,
   whatever Supabase's default table grants say. Only the definer RPCs
   below reach this table, and they expose only caller-owned detail or
   honest public rankings. (Same pattern as community_invitations.) */
alter table public.leaderboard_point_events enable row level security;
revoke all on table public.leaderboard_point_events from anon, authenticated;

/* ------------------------------------------------------------------ */
/* 2. Points configuration (weights + daily caps)                      */
/* ------------------------------------------------------------------ */

create table if not exists public.leaderboard_weights (
  activity_type text primary key,
  label text not null,
  points integer not null check (points between 0 and 100),
  /* max positive awards of this type per UTC day per user; 0 = uncapped
     (received engagement is uncapped per person but globally bounded
     through the received-engagement cap inside lb_award) */
  daily_cap integer not null default 0,
  enabled boolean not null default true
);

alter table public.leaderboard_weights enable row level security;
revoke all on table public.leaderboard_weights from anon, authenticated;

/* Seeded once; re-running this migration never stomps live tuning. */
insert into public.leaderboard_weights (activity_type, label, points, daily_cap) values
  ('post_publish',              'Publish a post in the campus feed',      5, 15),
  ('reel_publish',              'Publish a Reel',                         8, 10),
  ('community_post_publish',    'Post inside a community',                5, 15),
  ('reaction_received',         'Someone reacts (likes) your content',    1, 0),
  ('comment_received',          'Someone comments on your content',       2, 0),
  ('comment_reaction_received', 'Someone likes your comment',             1, 0),
  ('bookmark_received',         'Someone bookmarks your original content',2, 0),
  ('comment_authored',          'Write a comment in a discussion',        1, 20),
  ('resource_publish',          'Publish a community resource',           5, 8),
  ('event_publish',             'Publish an event',                       5, 5),
  ('event_attended',            'Verified event attendance',             10, 0)
on conflict (activity_type) do nothing;

/* ------------------------------------------------------------------ */
/* 3. Award / reverse helpers (definer; trigger-only)                  */
/* ------------------------------------------------------------------ */

/* Hard received-engagement safety cap per UTC day: bounds like-ring
   farming even when many "actors" collude. */
create or replace function public.lb_received_engagement_cap()
returns integer
language sql stable security definer set search_path = public as $$
  select 200
$$;

revoke all on function public.lb_received_engagement_cap() from public;
revoke all on function public.lb_received_engagement_cap() from anon, authenticated;

create or replace function public.lb_award(
  p_user uuid,
  p_type text,
  p_source_type text,
  p_source_id uuid,
  p_context text,
  p_dedup text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_points integer;
  v_cap integer;
  v_enabled boolean;
  v_engagement boolean := p_type in (
    'reaction_received','comment_received','comment_reaction_received','bookmark_received'
  );
begin
  if p_user is null then return; end if;

  select w.points, w.daily_cap, w.enabled into v_points, v_cap, v_enabled
  from public.leaderboard_weights w
  where w.activity_type = p_type;

  /* unknown/disabled weight = activity not scored */
  if not coalesce(v_points > 0 and v_enabled, false) then
    return;
  end if;

  /* dedup inside the helper: reaching here again is a no-op */
  if exists (select 1 from public.leaderboard_point_events where dedup_key = p_dedup) then
    return;
  end if;

  /* per-authoring-type daily cap */
  if v_cap > 0 then
    if (select count(*) from public.leaderboard_point_events e
        where e.user_id = p_user
          and e.activity_type = p_type
          and e.points > 0
          and e.created_at >= date_trunc('day', now() at time zone 'utc'))
       >= v_cap then
      return;
    end if;
  end if;

  /* received-engagement ring cap */
  if v_engagement then
    if (select count(*) from public.leaderboard_point_events e
        where e.user_id = p_user
          and e.activity_type in ('reaction_received','comment_received','comment_reaction_received','bookmark_received')
          and e.points > 0
          and e.created_at >= date_trunc('day', now() at time zone 'utc'))
       >= public.lb_received_engagement_cap() then
      return;
    end if;
  end if;

  insert into public.leaderboard_point_events
    (user_id, activity_type, context, source_type, source_id, points, dedup_key)
  values
    (p_user, p_type, p_context, p_source_type, p_source_id, v_points, p_dedup)
  on conflict (dedup_key) do nothing;
end $$;

/* Writes the compensating entry for one award. It finds the award by
   its dedup key in the ledger itself (never the source table, which is
   being mutated), so every cascade delete — a post going down and its
   likes, comments, bookmarks with it — reverses exactly what was paid,
   and a reversal for a never-awarded action is a no-op. */
create or replace function public.lb_reverse(p_dedup text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_points integer;
  v_user uuid;
  v_type text;
  v_ctx text;
  v_src_type text;
  v_src uuid;
begin
  select e.points, e.user_id, e.activity_type, e.context, e.source_type, e.source_id
  into v_points, v_user, v_type, v_ctx, v_src_type, v_src
  from public.leaderboard_point_events e
  where e.dedup_key = p_dedup and e.points > 0;

  if v_user is null then return; end if;

  insert into public.leaderboard_point_events
    (user_id, activity_type, context, source_type, source_id, points, dedup_key)
  values
    (v_user, v_type, v_ctx, v_src_type, v_src, -v_points, 'rev:' || p_dedup)
  on conflict (dedup_key) do nothing;
end $$;

/* NOTE: Supabase's default privileges grant EXECUTE on functions directly to
   anon/authenticated/service_role, so a revoke from PUBLIC alone is not
   enough — every helper is explicitly closed to every client-facing role.
   They are reached exclusively through trigger execution (owner definer). */
revoke all on function public.lb_award(uuid, text, text, uuid, text, text) from public;
revoke all on function public.lb_award(uuid, text, text, uuid, text, text) from anon, authenticated;
revoke all on function public.lb_reverse(text) from public;
revoke all on function public.lb_reverse(text) from anon, authenticated;

/* ------------------------------------------------------------------ */
/* 4. Triggers — the only writers of the ledger                        */
/* ------------------------------------------------------------------ */

/* 4a. posts: publishing earns (main post +5 / reel +8 / community post
       +5); unpublishing or deleting reverses. Anonymous content never
       earns (confessor privacy beats scoreboard). Republishing after
       an unpublish does not pay a second time (the award row keeps the
       dedup key; only the balance is restored, never re-paid). */

create or replace function public.lb_posts_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
  v_ctx text;
begin
  if TG_OP = 'DELETE' then
    perform public.lb_reverse('post_publish:' || OLD.id);
    return null;
  end if;

  if NEW.author_id is not null and NEW.is_anonymous = false and NEW.is_published = true then
    v_type := case
      when NEW.kind = 'reel' then 'reel_publish'
      when NEW.community_id is not null then 'community_post_publish'
      else 'post_publish' end;
    v_ctx := case when NEW.community_id is not null then 'community' else 'main' end;

    if TG_OP = 'INSERT' or (TG_OP = 'UPDATE' and OLD.is_published = false) then
      perform public.lb_award(NEW.author_id, v_type, 'post', NEW.id, v_ctx, 'post_publish:' || NEW.id);
    end if;
  end if;

  if TG_OP = 'UPDATE' and OLD.is_published = true and NEW.is_published = false then
    perform public.lb_reverse('post_publish:' || OLD.id);
  end if;

  return null;
end $$;

drop trigger if exists lb_posts_after on public.posts;
create trigger lb_posts_after
  after insert or update or delete on public.posts
  for each row execute function public.lb_posts_changed();

/* Engagement metadata probe: engagement feeds the board only when the
   content is genuinely visible to outsiders (main feed, or a public
   community) — restricted content stays out of public scoring. */
create or replace function public.lb_post_meta(p_post uuid)
returns table (
  v_author uuid,
  v_anonymous boolean,
  v_published boolean,
  v_ctx text,
  v_pub_visible boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.author_id as v_author,
    p.is_anonymous as v_anonymous,
    p.is_published as v_published,
    case when p.community_id is null then 'main' else 'community' end as v_ctx,
    (p.is_published and (
      p.community_id is null
      or exists (
        select 1 from public.clubs c
        where c.id = p.community_id and c.privacy = 'public'
      )
    )) as v_pub_visible
  from public.posts p
  where p.id = p_post
$$;

revoke all on function public.lb_post_meta(uuid) from public;
revoke all on function public.lb_post_meta(uuid) from anon, authenticated;

/* 4b. post likes → reaction_received (+1 to the content author) ----- */

create or replace function public.lb_likes_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  v_key text;
begin
  if TG_OP = 'INSERT' then
    select * into m from public.lb_post_meta(NEW.post_id);
    if m.v_author is not null
       and coalesce(m.v_pub_visible, false)
       and m.v_anonymous = false
       and m.v_author <> NEW.user_id then
      v_key := 'post_like:' || NEW.post_id || ':' || NEW.user_id
        || ':' || to_char(NEW.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
      perform public.lb_award(m.v_author, 'reaction_received', 'post', NEW.post_id, m.v_ctx, v_key);
    end if;
    return null;
  end if;

  /* DELETE: the exact award key is rebuilt from OLD (created_at keeps
     its microseconds); lb_reverse no-ops when nothing was ever paid */
  v_key := 'post_like:' || OLD.post_id || ':' || OLD.user_id
    || ':' || to_char(OLD.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  perform public.lb_reverse(v_key);
  return null;
end $$;

drop trigger if exists lb_likes_after on public.post_likes;
create trigger lb_likes_after
  after insert or delete on public.post_likes
  for each row execute function public.lb_likes_changed();

/* 4c. comments: the writer earns comment_authored (+1, capped), the
       content author earns comment_received (+2) when the comment is
       someone else's and meaningful (≥5 significant characters) ------ */

create or replace function public.lb_comments_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  if TG_OP = 'INSERT' then
    select * into m from public.lb_post_meta(NEW.post_id);

    /* the writer's own participation (inside communities too), only on
       content that is actually published */
    if NEW.author_id is not null and coalesce(m.v_published, false) then
      perform public.lb_award(
        NEW.author_id, 'comment_authored', 'comment', NEW.id,
        case when m.v_ctx = 'community' then 'community' else 'main' end,
        'comment_authored:' || NEW.id
      );
    end if;

    if m.v_author is not null
       and coalesce(m.v_pub_visible, false)
       and m.v_anonymous = false
       and m.v_author <> NEW.author_id
       and char_length(btrim(NEW.body)) >= 5 then
      perform public.lb_award(m.v_author, 'comment_received', 'post', NEW.post_id, m.v_ctx,
        'comment_received:' || NEW.id);
    end if;
    return null;
  end if;

  perform public.lb_reverse('comment_authored:' || OLD.id);
  perform public.lb_reverse('comment_received:' || OLD.id);
  return null;
end $$;

drop trigger if exists lb_comments_after on public.post_comments;
create trigger lb_comments_after
  after insert or delete on public.post_comments
  for each row execute function public.lb_comments_changed();

/* 4d. comment likes → comment_reaction_received (+1) ---------------- */

create or replace function public.lb_comment_likes_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  v_key text;
begin
  if TG_OP = 'INSERT' then
    select * into m from public.lb_post_meta(
      (select post_id from public.post_comments where id = NEW.comment_id)
    );
    if m.v_author is not null
       and coalesce(m.v_pub_visible, false)
       and m.v_anonymous = false
       and m.v_author <> NEW.user_id then
      v_key := 'comment_like:' || NEW.comment_id || ':' || NEW.user_id
        || ':' || to_char(NEW.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
      perform public.lb_award(m.v_author, 'comment_reaction_received', 'comment', NEW.comment_id, m.v_ctx, v_key);
    end if;
    return null;
  end if;

  v_key := 'comment_like:' || OLD.comment_id || ':' || OLD.user_id
    || ':' || to_char(OLD.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  perform public.lb_reverse(v_key);
  return null;
end $$;

drop trigger if exists lb_comment_likes_after on public.comment_likes;
create trigger lb_comment_likes_after
  after insert or delete on public.comment_likes
  for each row execute function public.lb_comment_likes_changed();

/* 4e. bookmarks → bookmark_received (+2 for the original author) ---- */

create or replace function public.lb_bookmarks_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  v_key text;
begin
  if TG_OP = 'INSERT' then
    select * into m from public.lb_post_meta(NEW.post_id);
    if m.v_author is not null
       and coalesce(m.v_pub_visible, false)
       and m.v_anonymous = false
       and m.v_author <> NEW.user_id then
      v_key := 'bookmark_received:' || NEW.post_id || ':' || NEW.user_id
        || ':' || to_char(NEW.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
      perform public.lb_award(m.v_author, 'bookmark_received', 'post', NEW.post_id, m.v_ctx, v_key);
    end if;
    return null;
  end if;

  v_key := 'bookmark_received:' || OLD.post_id || ':' || OLD.user_id
    || ':' || to_char(OLD.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  perform public.lb_reverse(v_key);
  return null;
end $$;

drop trigger if exists lb_bookmarks_after on public.post_bookmarks;
create trigger lb_bookmarks_after
  after insert or delete on public.post_bookmarks
  for each row execute function public.lb_bookmarks_changed();

/* 4f. community resources → resource_publish (+5) ------------------- */

create or replace function public.lb_resources_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform public.lb_award(NEW.uploader_id, 'resource_publish', 'resource', NEW.id, 'community',
      'resource_publish:' || NEW.id);
    return null;
  end if;
  perform public.lb_reverse('resource_publish:' || OLD.id);
  return null;
end $$;

drop trigger if exists lb_resources_after on public.community_resources;
create trigger lb_resources_after
  after insert or delete on public.community_resources
  for each row execute function public.lb_resources_changed();

/* 4g. events: publishing earns (+5), cancelling/unpublishing/deleting
       reverses; drafts never earn. ---------------------------------- */

create or replace function public.lb_events_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    perform public.lb_reverse('event_publish:' || OLD.id);
    return null;
  end if;

  if TG_OP = 'INSERT' then
    if NEW.created_by is not null and coalesce(NEW.published, true) and NEW.cancelled_at is null then
      perform public.lb_award(NEW.created_by, 'event_publish', 'event', NEW.id, 'events',
        'event_publish:' || NEW.id);
    end if;
    return null;
  end if;

  /* UPDATE: publish flip / cancel transitions */
  if (coalesce(OLD.published, false) = false or OLD.cancelled_at is not null)
     and coalesce(NEW.published, false) and NEW.cancelled_at is null then
    perform public.lb_award(NEW.created_by, 'event_publish', 'event', NEW.id, 'events',
      'event_publish:' || NEW.id);
  elsif coalesce(OLD.published, false) and OLD.cancelled_at is null
     and (coalesce(NEW.published, false) = false or NEW.cancelled_at is not null) then
    perform public.lb_reverse('event_publish:' || NEW.id);
  end if;
  return null;
end $$;

drop trigger if exists lb_events_after on public.events;
create trigger lb_events_after
  after insert or update or delete on public.events
  for each row execute function public.lb_events_changed();

/* 4h. verified attendance → event_attended (+10) --------------------
   attendance transitions happen only through the organizer-only RPC
   mark_attendance (0018): event_rsvps has no UPDATE policy, so this
   signal is exactly as trustworthy as its source. ------------------- */

create or replace function public.lb_attendance_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' and NEW.attendance_status = 'attended' then
    perform public.lb_award(NEW.user_id, 'event_attended', 'event', NEW.event_id, 'events',
      'event_attended:' || NEW.event_id || ':' || NEW.user_id);
    return null;
  end if;

  if NEW.attendance_status = 'attended' and OLD.attendance_status is distinct from 'attended' then
    perform public.lb_award(NEW.user_id, 'event_attended', 'event', NEW.event_id, 'events',
      'event_attended:' || NEW.event_id || ':' || NEW.user_id);
  elsif OLD.attendance_status = 'attended' and NEW.attendance_status is distinct from 'attended' then
    perform public.lb_reverse('event_attended:' || NEW.event_id || ':' || NEW.user_id);
  end if;
  return null;
end $$;

drop trigger if exists lb_attendance_after on public.event_rsvps;
create trigger lb_attendance_after
  after insert or update of attendance_status on public.event_rsvps
  for each row execute function public.lb_attendance_changed();

/* The 8 trigger functions are not RPC endpoints — they run only as trigger
   callbacks. PostgREST could still invoke them directly (a direct call
   just errors out on a missing NEW/OLD record), so close them off too. */
revoke all on function public.lb_posts_changed() from public, anon, authenticated;
revoke all on function public.lb_likes_changed() from public, anon, authenticated;
revoke all on function public.lb_comments_changed() from public, anon, authenticated;
revoke all on function public.lb_comment_likes_changed() from public, anon, authenticated;
revoke all on function public.lb_bookmarks_changed() from public, anon, authenticated;
revoke all on function public.lb_resources_changed() from public, anon, authenticated;
revoke all on function public.lb_events_changed() from public, anon, authenticated;
revoke all on function public.lb_attendance_changed() from public, anon, authenticated;

/* ------------------------------------------------------------------ */
/* 5. Shared scope + period helpers                                    */
/* ------------------------------------------------------------------ */

/* Categories → (activity_type set, context filter):
     overall   — every scored activity
     college   — same as overall, restricted to the caller's college
     community — contribution inside communities: posts, authored
                 comments, published resources (contribution, not the
                 popularity it generates)
     creators  — eligible posts/reels and the genuine engagement they
                 receive from other people
     events    — organizing published events + verified attendance     */
create or replace function public.lb_category_types(p_category text)
returns text[]
language sql stable security definer set search_path = public as $$
  select case p_category
    when 'community' then array['community_post_publish','comment_authored','resource_publish']::text[]
    when 'creators'  then array['post_publish','reel_publish','reaction_received','comment_received','comment_reaction_received','bookmark_received']::text[]
    else '{}'::text[]
  end
$$;

/* Periods use consistent UTC boundaries:
     week  — current ISO week (Monday 00:00 UTC, still open)
     month — current calendar month (1st 00:00 UTC, still open)
     all   — (no lower bound)                                           */
create or replace function public.lb_period_boundary(p_period text)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select case p_period
    when 'week'  then date_trunc('week', now() at time zone 'utc')::timestamptz
    when 'month' then date_trunc('month', now() at time zone 'utc')::timestamptz
    else '-infinity'::timestamptz
  end
$$;

revoke all on function public.lb_category_types(text) from public;
revoke all on function public.lb_category_types(text) from anon, authenticated;
revoke all on function public.lb_period_boundary(text) from public;
revoke all on function public.lb_period_boundary(text) from anon, authenticated;

/* ------------------------------------------------------------------ */
/* 6. list_leaderboard — paginated, ranked, category/period aware      */
/* ------------------------------------------------------------------ */

/* Tie-breaking: competition rank (rank over score, ties share it); the
   display position orders by (score desc, last_earned_at asc,
   user_id asc) so equal scores keep stable, refresh-proof positions.
   Movement: for week/month the position is compared against the same
   category's CLOSED previous period, recomputed from the ledger
   history — not from any sampled snapshot. null = new to the board.
   The college board resolves the caller's own college server-side;
   signed-out callers and callers without a selected college get an
   honestly empty board (the client explains the situation).          */

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
begin
  if v_category not in ('overall','college','community','creators','events') then
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

  if v_category = 'college' then
    select p.college_id into v_college from public.profiles p where p.id = auth.uid();
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
  where (v_category <> 'college')
     or (v_college is not null and u.college_id = v_college)
  order by r.pos
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;

revoke all on function public.list_leaderboard(text, text, integer, integer) from public;
grant execute on function public.list_leaderboard(text, text, integer, integer) to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 7. leaderboard_me — the caller's own standing                       */
/* ------------------------------------------------------------------ */

/* Returns exactly one row:
     status 'ok'         + rank/position/score/total (position null,
                           score 0 when not ranked in this scope)
     status 'no_college' — the college board needs a selected college
     status 'signed_out' — no session (defensive; the UI gates first)  */
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
begin
  if v_category not in ('overall','college','community','creators','events') then
    v_category := 'overall';
  end if;
  if v_period not in ('week','month','all') then
    v_period := 'week';
  end if;

  if v_me is null then
    return query select 'signed_out'::text, 0::bigint, null::bigint, null::bigint, 0::bigint;
    return;
  end if;

  if v_category = 'college' then
    select p.college_id into v_college from public.profiles p where p.id = v_me;
    if v_college is null then
      return query select 'no_college'::text, 0::bigint, null::bigint, null::bigint, 0::bigint;
      return;
    end if;
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
        v_category <> 'college'
        or le.user_id in (
          select p2.id from public.profiles p2
          where p2.college_id = v_college
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

/* ------------------------------------------------------------------ */
/* 8. Achievements — milestones, computed on read, never stored        */
/* ------------------------------------------------------------------ */

/* A milestone is earned when its all-time basis reaches its target.
   Computed from the viewer's own ledger history on every call, so a
   milestone can never be granted twice, forged through a client call,
   or lost. Progress is capped at the target by construction.        */
create or replace function public.list_my_achievements()
returns table (
  key text,
  label text,
  description text,
  earned boolean,
  progress integer,
  target integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_authored bigint;
  v_engagement bigint;
  v_community bigint;
  v_creations bigint;
  v_events bigint;
  v_days bigint;
begin
  if v_me is null then
    raise exception 'Sign in to see your achievements.';
  end if;

  select
    count(*) filter (where activity_type in ('post_publish','reel_publish','community_post_publish','comment_authored','resource_publish','event_publish')),
    count(*) filter (where activity_type in ('reaction_received','comment_received','comment_reaction_received','bookmark_received')),
    count(*) filter (where context = 'community' and activity_type in ('community_post_publish','comment_authored','resource_publish')),
    count(*) filter (where activity_type in ('post_publish','reel_publish','community_post_publish')),
    count(*) filter (where activity_type = 'event_publish'),
    count(distinct (created_at at time zone 'utc')::date)
  into v_authored, v_engagement, v_community, v_creations, v_events, v_days
  from public.leaderboard_point_events e
  where e.user_id = v_me and e.points > 0;

  return query
  select * from (values
    ('first_contribution', 'First Contribution',
      'Your first eligible contribution on CAMPUS.',
      v_authored >= 1, least(v_authored::int, 1), 1),
    ('helpful_contributor', 'Helpful Contributor',
      'Receive 10 reactions, comments or bookmarks from other students.',
      v_engagement >= 10, least(v_engagement::int, 10), 10),
    ('community_builder', 'Community Builder',
      'Contribute inside communities 3 times — posts, comments or resources.',
      v_community >= 3, least(v_community::int, 3), 3),
    ('rising_creator', 'Rising Creator',
      'Publish 5 posts or reels and receive 25 engagement ones from others.',
      v_creations >= 5 and v_engagement >= 25,
      least(least(v_creations::int, 5) + least(v_engagement::int, 25), 10), 10),
    ('event_organizer', 'Event Organizer',
      'Publish your first event on the Events page.',
      v_events >= 1, least(v_events::int, 1), 1),
    ('consistent_contributor', 'Consistent Contributor',
      'Contribute on 3 different days.',
      v_days >= 3, least(v_days::int, 3), 3)
  ) as t(key, label, description, earned, progress, target);
end $$;

revoke all on function public.list_my_achievements() from public;
grant execute on function public.list_my_achievements() to authenticated;

/* ------------------------------------------------------------------ */
/* 9. leaderboard_rules — the auditable scoring model for the UI       */
/* ------------------------------------------------------------------ */

create or replace function public.leaderboard_rules()
returns table (
  activity_type text,
  label text,
  points integer,
  daily_cap integer,
  enabled boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select w.activity_type, w.label, w.points, w.daily_cap, w.enabled
  from public.leaderboard_weights w
  order by w.points desc, w.activity_type
$$;

revoke all on function public.leaderboard_rules() from public;
grant execute on function public.leaderboard_rules() to anon, authenticated;
