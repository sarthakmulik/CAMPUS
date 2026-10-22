/* =====================================================================
   0028_polls.sql — CAMPUS Polls system + dedicated Confessions feed
   ---------------------------------------------------------------------
   Creates the smallest clean extension of the existing post system for
   real polls, and the focused RPC that powers the Confessions page.

   Poll data model (builds on the base `poll_options` / `poll_votes`
   tables from schema.sql, which up to now had no writer at all —
   the feature was scaffold-only, so both tables are empty):

     poll_meta      — per-post poll settings: multiple choice + close time.
                      No settings can ever be written by clients (RLS has
                      no write policies); only create_poll() sets them.
     poll_votes     — PK moves from (post_id, user_id) to
                      (post_id, user_id, option_id) so multiple-choice
                      polls store one row per selection. Safe: the table
                      was never populated before this feature shipped.
                      Single-choice is enforced inside cast_poll_vote().
                      Readers may now see ONLY their own vote rows —
                      aggregate results are surfaced exclusively through
                      poll_states(), so voter identity can never be
                      enumerated and voting is identity-private for
                      every poll.
     poll_options   — unchanged (readable; writes happen only through
                      create_poll()).

   RPCs (all validated server-side; clients submit only plain inputs,
   never counts, percentages, ownership or user ids):

     create_poll(p_body, p_options, p_multiple_choice, p_close_days)
       — definer; trims/dedupes options, enforces 2..6 non-empty,
         unique (case-insensitive) labels, 1..30 day duration; writes
         the post, options and settings in ONE transaction; resolves
         the author and college from the caller's profile + auth.uid()
         (never from the request body). Returns (id, created_at).

     cast_poll_vote(p_post_id, p_option_ids)
       — definer; the ONLY way any vote row is written. Validates that
         the poll exists, is published, is not a community post, is not
         expired (server clock), that every option belongs to THAT
         poll, and that a single-choice poll receives exactly one
         selection. Changing a vote = deleting the caller's rows then
         inserting the new ones inside the same transaction, so counts
         never double-count. Returns the fresh poll state (same shape
         as poll_states) so the UI updates from authoritative totals.

     poll_states(p_ids)
       — definer; per-poll aggregates for a batch of posts (feed page,
         one call): open/closed by timestamp, multi-choice flag, total
         votes and per-option counts + whether the CALLER picked it.
         Contains no voter identities, so it is safe for anonymous
         (signed-out) visitors too.

   Confessions feed:

     list_confessions(p_sort, p_college_id, p_limit, p_offset)
       — definer; ONLY kind='confession' AND is_anonymous posts from the
         main feed. Author columns are nulled in SQL for anonymous rows
         (same defeating logic as list_public_posts) — the identity of
         a confession author can never reach the client through this
         page. Sorts: 'latest' (created_at desc) and 'trending'
         (real engagement: like_count*2 + comment_count, ties break
         recency-first). Offset pagination with a total_count window so
         the UI stops exactly at the end. College filter is optional
         (the global confession feed is NOT college-only by default).

   Leaderboard: polls are posts (kind='poll') — the existing row
   triggers already score/undo publishing, reactions, comments and
   bookmarks on them; no new trigger is added and nothing else in
   existing interactions (comments, bookmarks, reports, share)
   required changes to accept them.
   ===================================================================== */

/* ------------------------------------------------------------------ */
/* 1. Poll settings                                                     */
/* ------------------------------------------------------------------ */

create table if not exists public.poll_meta (
  post_id uuid primary key references public.posts(id) on delete cascade,
  multiple_choice boolean not null default false,
  /* null = open-ended poll; votes are validated against the server clock */
  closes_at timestamptz
);

alter table public.poll_meta enable row level security;

drop policy if exists "poll meta readable" on public.poll_meta;
create policy "poll meta readable" on public.poll_meta for select using (true);
/* No insert/update/delete policies exist — poll settings are only ever
   written by create_poll() as part of a whole-poll transaction. */

/* ------------------------------------------------------------------ */
/* 2. Votes: one row per (poll, voter, option); private by default       */
/* ------------------------------------------------------------------ */

/* The old PK capped every poll at one row per voter (single choice
   only). The feature was scaffold-only — no rows exist — so the PK is
   safely reshaped; single-choice limits are re-enforced in code. */
alter table public.poll_votes drop constraint if exists poll_votes_pkey;
alter table public.poll_votes add constraint poll_votes_pkey
  primary key (post_id, user_id, option_id);

/* Voter rows are private: the DB can mirror "my selection" for a re-open
   tab, and nothing else. Results flow through poll_states() aggregates. */
drop policy if exists "users read poll votes" on public.poll_votes;
create policy "users read poll votes" on public.poll_votes
  for select to authenticated using (auth.uid() = user_id);
/* the old insert policy is superseded — the table is not writable by
   clients at all any more (revoke below) */
drop policy if exists "users vote once" on public.poll_votes;

/* Votes are writable ONLY through cast_poll_vote(): the table itself gets no
   INSERT/UPDATE/DELETE grants, so no direct API call can fabricate selections,
   bypass the single-choice limit (a single INSERT can carry two rows, which an
   insert policy could never catch), vote across polls (FK only pins the option
   to exist, not to the same poll), or vote after expiry. The definer RPC
   performs every check against the server clock and poll metadata. */
revoke all on public.poll_votes from anon, authenticated;
grant select on public.poll_votes to authenticated;

create index if not exists poll_options_post_idx on public.poll_options(post_id);
create index if not exists poll_votes_option_idx on public.poll_votes(option_id);

/* Supabase's default privileges grant write EXECUTE/INSERT to each role on
   new tables — that must not apply here: poll settings and options are
   created exclusively by create_poll() and read by everyone. */
revoke all on public.poll_meta from anon, authenticated;
grant select on public.poll_meta to anon, authenticated;
revoke insert, update, delete, truncate on public.poll_options from anon, authenticated, public;
revoke truncate on public.poll_votes from anon, authenticated, public;

/* ------------------------------------------------------------------ */
/* 3. Authoritative poll state (aggregates, zero identities)            */
/* ------------------------------------------------------------------ */

/* named row type + list_confessions total column */
do $$ begin
create type public.poll_state as (
  post_id uuid,
  multiple_choice boolean,
  closes_at timestamptz,
  is_open boolean,
  total_votes bigint,
  options jsonb
);
exception when duplicate_object then null; end $$;

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
    and pm.post_id = any (coalesce(p_ids, '{}'))
$$;

/* ------------------------------------------------------------------ */
/* 4. Voting                                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* 5. Creating a poll (post + options + settings, atomically)           */
/* ------------------------------------------------------------------ */

create or replace function public.create_poll(
  p_body text,
  p_options text[],
  p_multiple_choice boolean default false,
  p_close_days integer default 7
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
  v_post_id := gen_random_uuid();

  insert into public.posts (id, author_id, college_id, kind, body, media_urls, is_anonymous, is_published)
  values (v_post_id, v_uid, v_college, 'poll', btrim(p_body), '{}', false, true);

  insert into public.poll_meta (post_id, multiple_choice, closes_at)
  values (v_post_id, coalesce(p_multiple_choice, false), now() + (p_close_days * interval '1 day'));

  insert into public.poll_options (post_id, label, position)
  select v_post_id, label, ord
  from unnest(v_clean) with ordinality as t(label, ord);

  return query select v_post_id, now()::timestamptz;
end;
$$;

/* ------------------------------------------------------------------ */
/* 6. Dedicated confessions feed (anonymous-safe by construction)       */
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

/* ------------------------------------------------------------------ */
/* 7. Handle permissions                                                */
/* ------------------------------------------------------------------ */

revoke all on function public.poll_states(uuid[]) from public;
grant execute on function public.poll_states(uuid[]) to anon, authenticated;

revoke all on function public.cast_poll_vote(uuid, uuid[]) from public;
revoke all on function public.cast_poll_vote(uuid, uuid[]) from anon;
grant execute on function public.cast_poll_vote(uuid, uuid[]) to authenticated;

revoke all on function public.create_poll(text, text[], boolean, integer) from public;
revoke all on function public.create_poll(text, text[], boolean, integer) from anon;
grant execute on function public.create_poll(text, text[], boolean, integer) to authenticated;

revoke all on function public.list_confessions(text, uuid, integer, integer) from public;
grant execute on function public.list_confessions(text, uuid, integer, integer) to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 8. Feed performance                                                  */
/* ------------------------------------------------------------------ */

create index if not exists posts_confession_feed_idx
  on public.posts (created_at desc)
  where kind = 'confession' and is_published and community_id is null;
