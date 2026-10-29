-- =============================================================================
-- 0049 - Post audience: "Everyone" (public) vs "My College only" (college)
--
-- WHAT EXISTED BEFORE THIS MIGRATION (audited 2026-10):
--   Every published post/reel/poll was GLOBAL. The `posts.college_id` column
--   was attribution metadata only:
--     - list_public_posts / list_public_reels / get_public_post /
--       list_member_posts / list_confessions returned every published row
--       regardless of college ("My College" only passed p_college_id as a
--       client-chosen VIEW filter, never a security boundary).
--     - RLS "published posts readable" = (is_published) for everyone incl.
--       anon; comments/likes/reposts select policies were (true).
--     - Even a stranger could like/repost/comment on another college's post
--       directly against the API.
--
-- WHAT THIS MIGRATION ADDS:
--   posts.audience ('public' | 'college', default 'public' — legacy rows stay
--   public so nothing disappears). A helper + rebuilt RLS/RPCs enforce it at
--   the SERVER:
--
--     public     → everyone, including signed-out visitors
--     college    → the author, staff accounts, and members of ONE college:
--                  the posting author's own college (resolved from the caller's
--                  profile — never from the request)
--
--   Enforcement points (each formerly open, now gated):
--     1. posts   SELECT RLS            (table reads)
--     2. post_comments  SELECT/INSERT  (threads of a private post)
--     3. post_likes     SELECT/INSERT  (can't like what you can't see;
--                                       likes-of-hidden posts no longer leak)
--     4. post_reposts   SELECT/INSERT  (same)
--     5. list_public_posts              (Home feed / My College tab)
--     6. list_public_reels              (Discover)
--     7. get_public_post                (deep links #p/<id> → graceful
--                                       "not available" for outsiders)
--     8. list_member_posts              (profile grids show private posts
--                                       only to in-college viewers)
--     9. profile_stats                  (counts match what the viewer can see)
--    10. list_confessions               (anonymous, college-scoped too)
--    11. create_poll / cast_poll_vote   (poll writing + voting gated)
--    12. poll_states                    (aggregate totals don't leak)
--    13. posts_notify_mentions          (a college-only post never @-notifies
--                                       users outside that college)
--
--   Care must be reserved around: media files in the public storage buckets
--   stay public-URL readable (documented product limitation; the feed/records
--   are the security surface — direct guessed media URLs are not gated here).
--
-- Verify after applying:
--   -- two profile rows, different colleges:
--   select public.can_view_post('<a college-scoped post id>');
--   -- true for its author / same-college / staff; false for other college
--   -- and for anon (auth.uid() null).
--   select id from public.posts where is_published = true
--     and audience = 'college'
--     and not public.post_visible_to(audience, college_id, author_id); -- ~0 rows
--
-- Rollback: set audience='public' everywhere and re-apply the pre-0049
-- policies/RPCs (0002/0004/0012/0016/0028/0043/0047 definitions), or simply
--   alter table public.posts drop column if exists audience;
-- plus the pre-0049 function bodies.
-- =============================================================================

/* ------------------------------------------------------------------ */
/* 1. Schema: audience column                                           */
/* ------------------------------------------------------------------ */

alter table public.posts
  add column if not exists audience text not null default 'public';

-- keep the invariant honest if anything writes it directly
alter table public.posts drop constraint if exists posts_audience_check;
alter table public.posts
  add constraint posts_audience_check
  check (audience in ('public', 'college'));

-- the college feed walks (college_id, created_at), now filtering audience too;
-- audience is highly selective for the 'public' branch, so a partial index
create index if not exists posts_public_audience_idx
  on public.posts (created_at desc)
  where is_published = true and audience = 'public' and community_id is null;

-- 0046 narrowed SELECT on posts to column-level grants (author_id hidden for
-- the confession anonymity). A NEW column inherits no grant, so any direct
-- table read/write naming `audience` would 403 (42501). Grant it:
grant select (audience) on public.posts to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 2. Visibility helpers                                                */
/* ------------------------------------------------------------------ */

-- Row-level rule: would the CURRENT caller be allowed to see a post row with
-- these audience properties? Security definer so stable SQL everywhere can
-- share exactly ONE definition; auth.uid() still resolves to the caller.
create or replace function public.post_visible_to(
  p_audience text,
  p_college_id uuid,
  p_author uuid
)
returns boolean
language sql stable security definer set search_path = '' as $$
  select
    p_audience = 'public'
    or (
      p_college_id is not null
      and (
        p_author = auth.uid()
        or exists (
          select 1 from public.profiles me
          where me.id = auth.uid()
            and me.college_id = p_college_id
        )
        or exists (
          select 1 from public.staff_accounts sa
          where sa.user_id = auth.uid()
            and sa.is_active
        )
      )
    )
$$;

-- Convenience for RPCs & policies working from a post id.
create or replace function public.can_view_post(p_post uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.posts p
    where p.id = p_post
      and p.is_published = true
      and public.post_visible_to(p.audience, p.college_id, p.author_id)
  )
$$;

revoke all on function public.post_visible_to(text, uuid, uuid) from public;
grant execute on function public.post_visible_to(text, uuid, uuid) to anon, authenticated;
revoke all on function public.can_view_post(uuid) from public;
grant execute on function public.can_view_post(uuid) to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 3. RLS: the posts table + its projection tables                      */
/* ------------------------------------------------------------------ */

drop policy if exists "published posts readable" on public.posts;
drop policy if exists "post visibility by audience" on public.posts;
create policy "post visibility by audience" on public.posts
  for select
  using (
    is_published = true
    and public.post_visible_to(audience, college_id, author_id)
  );

-- an author may still fetch their own unpublished (editor) row
drop policy if exists "authors read own posts" on public.posts;
create policy "authors read own posts" on public.posts
  for select
  to authenticated
  using (author_id = auth.uid());

-- comments: threads live or die with their post
drop policy if exists "comments readable" on public.post_comments;
create policy "comments readable within post audience" on public.post_comments
  for select to authenticated using (public.can_view_post(post_id));

drop policy if exists "users create comments" on public.post_comments;
create policy "users create comments" on public.post_comments
  for insert to authenticated
  with check (
    auth.uid() = author_id
    and public.can_view_post(post_id)
  );

-- likes: no like list, no new like, on a post you cannot see
drop policy if exists "likes readable" on public.post_likes;
create policy "likes readable within post audience" on public.post_likes
  for select to authenticated using (public.can_view_post(post_id));

drop policy if exists "users manage own likes" on public.post_likes;
create policy "users manage own likes" on public.post_likes
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and public.can_view_post(post_id));

-- reposts: same isolation (previously readable by everyone)
drop policy if exists "reposts readable" on public.post_reposts;
create policy "reposts readable within post audience" on public.post_reposts
  for select to authenticated using (public.can_view_post(post_id));

drop policy if exists "users manage own reposts" on public.post_reposts;
create policy "users manage own reposts" on public.post_reposts
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and public.can_view_post(post_id));

/* ------------------------------------------------------------------ */
/* 4. Feed RPCs (all security definer — THEY define the boundary)       */
/* ------------------------------------------------------------------ */

-- Home feed / My College tab (latest shape: 0016 + 0043 suspended authors).
drop function if exists public.list_public_posts(integer, integer, uuid);
create function public.list_public_posts(
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
  liked_by_me boolean
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
    )
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

-- Discover reels (0004 shape). Visitors see only public-audience reels.
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
    and public.post_visible_to(p.audience, p.college_id, p.author_id)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_public_reels(integer, integer) from public;
grant execute on function public.list_public_reels(integer, integer) to anon, authenticated;

-- Deep links (#p/<id>): outsiders (other colleges, anon) get no row at all —
-- the client already answers 'That post is not available'.
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
  liked_by_me boolean
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
    )
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.id = p_post
    and p.is_published = true
    and public.post_visible_to(p.audience, p.college_id, p.author_id)
$$;

revoke all on function public.get_public_post(uuid) from public;
grant execute on function public.get_public_post(uuid) to anon, authenticated;

-- Profile grids: show EVERYTHING to the member themself / in-college viewers /
-- staff; other viewers see only the public subset. Confessions never appear
-- here (who confessed must stay unknowable).
drop function if exists public.list_member_posts(uuid, text, integer);
create function public.list_member_posts(
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
  liked_by_me boolean
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
    coalesce((select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()), false)
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

-- Profile header counts: match what THIS viewer may see (a cross-college
-- visitor counts only that member's public posts; the member counts all).
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
      where p.author_id = p_profile and p.is_published = true and p.kind = 'post'
        and p.is_anonymous = false
        and public.post_visible_to(p.audience, p.college_id, p.author_id)),
    (select count(*) from public.posts p
      where p.author_id = p_profile and p.is_published = true and p.kind = 'reel'
        and p.is_anonymous = false
        and public.post_visible_to(p.audience, p.college_id, p.author_id)),
    (select count(*) from public.follows f where f.followed_id = p_profile),
    (select count(*) from public.follows f where f.follower_id = p_profile)
$$;

revoke all on function public.profile_stats(uuid) from public;
grant execute on function public.profile_stats(uuid) to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 5. Confessions feed (anonymous, college-scoped now possible)         */
/* ------------------------------------------------------------------ */

drop function if exists public.list_confessions(text, uuid, integer, integer);
create function public.list_confessions(
  p_sort text default 'latest',
  p_college_id uuid default null,
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
  total_count bigint
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
    count(*) over ()
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.kind = 'confession'
    and p.is_anonymous = true          -- confessions are anonymous by design
    and p.is_published = true
    and p.community_id is null
    and public.post_visible_to(p.audience, p.college_id, p.author_id)  -- college too
    and (p_college_id is null or p.college_id = p_college_id)
  order by
    /* trending: real engagement first (ties break recency-first);
       latest: the engagement key is null so recency alone rules */
    (case when p_sort = 'trending'
      then (select count(*) from public.post_likes tl where tl.post_id = p.id) * 2
           + (select count(*) from public.post_comments tc where tc.post_id = p.id)
      else null end) desc nulls last,
    p.created_at desc,
    p.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_confessions(text, uuid, integer, integer) from public;
grant execute on function public.list_confessions(text, uuid, integer, integer) to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 6. Polls: author-side audience + voter gating                        */
/* ------------------------------------------------------------------ */

drop function if exists public.create_poll(text, text[], boolean, integer);
create or replace function public.create_poll(
  p_body text,
  p_options text[],
  p_multiple_choice boolean default false,
  p_close_days integer default 7,
  p_audience text default 'public'
)
returns table (id uuid, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_college uuid;
  v_post_id uuid;
  v_clean text[];
  v_raw text;
  v_label text;
  v_i int;
  v_j int;
  v_n int;
  v_audience text;
begin
  if v_uid is null then
    raise exception 'Sign in to create a poll.';
  end if;
  if p_body is null or btrim(p_body) = '' then
    raise exception 'Write the poll question first.';
  end if;
  if char_length(btrim(p_body)) > 2000 then
    raise exception 'Keep the question under 2000 characters.';
  end if;
  /* options: trim, drop empties, de-duplicate case-insensitively */
  v_clean := '{}';
  if p_options is not null then
    for v_i in 1 .. coalesce(array_length(p_options, 1), 0) loop
      v_label := btrim(coalesce(p_options[v_i], ''));
      if v_label = '' then
        raise exception 'Poll options cannot be empty.';
      end if;
      if char_length(v_label) > 120 then
        raise exception 'Keep each option under 120 characters.';
      end if;
      for v_j in 1 .. coalesce(array_length(v_clean, 1), 0) loop
        if lower(v_clean[v_j]) = lower(v_label) then
          raise exception 'Poll options must be different from each other.';
        end if;
      end loop;
      v_clean := array_append(v_clean, v_label);
    end loop;
  end if;
  v_n := coalesce(array_length(v_clean, 1), 0);
  if v_n < 2 then
    raise exception 'A poll needs at least two distinct options.';
  end if;
  if v_n > 6 then
    raise exception 'A poll takes at most six options.';
  end if;
  if p_close_days is null or p_close_days < 1 or p_close_days > 30 then
    p_close_days := 7;
  end if;

  /* author + college resolved server-side (never trusted from body).
     The table alias matters: RETURNS TABLE declares an OUT parameter
     named "id", so ANY unqualified "id" column in the body collides
     (PL/pgSQL 42702 "column reference id is ambiguous"). */
  select p.college_id into v_college from public.profiles p where p.id = v_uid;
  /* audience: 'college' is honored only when the caller really HAS a college;
     anything else falls back to 'public' */
  if p_audience = 'college' and v_college is not null then
    v_audience := 'college';
  else
    v_audience := 'public';
  end if;
  v_post_id := gen_random_uuid();

  insert into public.posts (id, author_id, college_id, kind, body, media_urls, is_anonymous, is_published, audience)
  values (v_post_id, v_uid, v_college, 'poll', btrim(p_body), '{}', false, true, v_audience);

  insert into public.poll_meta (post_id, multiple_choice, closes_at)
  values (v_post_id, coalesce(p_multiple_choice, false), now() + (p_close_days * interval '1 day'));

  insert into public.poll_options (post_id, label, position)
  select v_post_id, label, ord
  from unnest(v_clean) with ordinality as t(label, ord);

  return query select v_post_id, now()::timestamptz;
end;
$$;

drop function if exists public.cast_poll_vote(uuid, uuid[]);
create or replace function public.cast_poll_vote(p_post_id uuid, p_option_ids uuid[])
returns setof public.poll_state
language plpgsql security definer set search_path = '' as $$
declare
  v_post public.posts%rowtype;
  v_meta public.poll_meta%rowtype;
  v_opt uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to vote in campus polls.';
  end if;

  select * into v_post from public.posts
    where id = p_post_id and kind = 'poll' and is_published = true and community_id is null;
  if not found then
    raise exception 'That poll is not open for voting.';
  end if;
  /* NEW: a college-only poll is also invisible to vote for */
  if not public.post_visible_to(v_post.audience, v_post.college_id, v_post.author_id) then
    raise exception 'You do not have access to this poll.';
  end if;

  select * into v_meta from public.poll_meta where post_id = p_post_id;
  if not found then
    raise exception 'That poll is not open for voting.';
  end if;
  if v_meta.closes_at is not null and v_meta.closes_at <= now() then
    raise exception 'This poll has ended.';
  end if;

  if p_option_ids is null or coalesce(array_length(p_option_ids, 1), 0) = 0 then
    raise exception 'Pick at least one option before voting.';
  end if;
  if not v_meta.multiple_choice and coalesce(array_length(p_option_ids, 1), 0) > 1 then
    raise exception 'This poll takes one choice per student.';
  end if;
  if v_meta.multiple_choice and coalesce(array_length(p_option_ids, 1), 0) > 6 then
    raise exception 'A poll has at most six options.';
  end if;

  foreach v_opt in array p_option_ids loop
    if not exists (
      select 1 from public.poll_options o
      where o.id = v_opt and o.post_id = p_post_id
    ) then
      raise exception 'One of the selected options is not part of this poll.';
    end if;
  end loop;

  /* Change-vote semantics: the caller's previous selections for THIS poll
     are removed and the fresh set inserted inside one transaction — a
     partial rewrite can never leave phantom votes behind. */
  delete from public.poll_votes
    where post_id = p_post_id and user_id = auth.uid();
  insert into public.poll_votes (post_id, option_id, user_id)
    select p_post_id, u.id, auth.uid()
    from unnest(p_option_ids) as u(id);

  return query select ps.* from public.poll_states(array[p_post_id]) ps;
end;
$$;

-- poll_states: aggregates stay aggregates, but a hidden poll's totals must not
-- tip outsiders off that it exists at all/inside their feeds it never renders.
drop function if exists public.poll_states(uuid[]);
create or replace function public.poll_states(p_ids uuid[])
returns setof public.poll_state
language sql stable security definer set search_path = '' as $$
  select
    pm.post_id,
    coalesce(pm.multiple_choice, false),
    pm.closes_at,
    (pm.closes_at is null or pm.closes_at > now()),
    (select count(*) from public.poll_votes pv where pv.post_id = pm.post_id),
    coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', o.id,
                 'label', o.label,
                 'position', o.position,
                 'votes', (select count(*) from public.poll_votes v2 where v2.option_id = o.id),
                 'mine', exists (
                   select 1 from public.poll_votes v3
                   where v3.option_id = o.id and v3.user_id = auth.uid()
                 )
               )
               order by o.position)
      from public.poll_options o
      where o.post_id = pm.post_id
    ), '[]'::jsonb)
  from public.poll_meta pm
  join public.posts p on p.id = pm.post_id and p.kind = 'poll'
  where p.is_published = true
    and p.community_id is null          -- public main-feed polls only
    and public.post_visible_to(p.audience, p.college_id, p.author_id)
    and pm.post_id = any (coalesce(p_ids, '{}'))
$$;

revoke all on function public.poll_states(uuid[]) from public;
grant execute on function public.poll_states(uuid[]) to anon, authenticated;

revoke all on function public.cast_poll_vote(uuid, uuid[]) from public;
revoke all on function public.cast_poll_vote(uuid, uuid[]) from anon;
grant execute on function public.cast_poll_vote(uuid, uuid[]) to authenticated;

revoke all on function public.create_poll(text, text[], boolean, integer, text) from public;
revoke all on function public.create_poll(text, text[], boolean, integer, text) from anon;
grant execute on function public.create_poll(text, text[], boolean, integer, text) to authenticated;

/* ------------------------------------------------------------------ */
/* 7. Mentions: a college-only post never pings other-college members   */
/* ------------------------------------------------------------------ */

create or replace function public.notify_on_post_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_mention uuid;
  v_mention_college uuid;
  v_summary jsonb;
begin
  if new.is_anonymous or new.author_id is null then
    return null;
  end if;
  v_summary := public.notif_post_summary(new.id);
  for v_mention in
    select mm.id from public.notification_mentioned_ids(new.body) mm(id)
  loop
    continue when v_mention = new.author_id;
    continue when new.community_id is not null
      and not public.is_club_active_member(new.community_id, v_mention);
    /* NEW: college-scoped posts mention only that college's members */
    if new.audience = 'college' then
      select college_id into v_mention_college from public.profiles where id = v_mention;
      continue when v_mention_college is distinct from new.college_id;
    end if;
    perform public.create_notification(
      v_mention, new.author_id, 'post_mention', 'post', new.id, v_summary
    );
  end loop;
  return null;
end $$;

drop trigger if exists posts_notify_mentions on public.posts;
create trigger posts_notify_mentions
  after insert on public.posts
  for each row execute function public.notify_on_post_insert();
