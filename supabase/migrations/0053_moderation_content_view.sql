-- =============================================================================
-- 0053 — MODERATION CONTENT VIEW (cohesion with the audience era 0049–0052)
--
-- The 0044 queue predates scoped posts: reviewers saw a 200-char excerpt with
-- no idea WHO could see the content they were judging, could not open full
-- body or media (especially after hiding it — the member RPCs all refuse
-- hidden posts), and the media gate never learned about communities.
--
-- Three coordinated fixes, all server-side:
--
--   1. staff_list_reports (shape changed → drop + recreate): queue rows now
--      carry the post's audience ('public'|'college'), its community (id +
--      name) when it is a community post, and whether it references media —
--      so a reviewer knows the scope before acting.
--      Also a privacy fix: anonymous posts (confessions) no longer leak their
--      author to staff through the author join — identity of an anonymous
--      post stays unreversible; moderation acts on the content, not the mask.
--
--   2. staff_fetch_post(p_post_id): security-definer, gated on
--      moderation.read, returns the FULL content of ANY post — hidden or
--      visible, any audience — plus author snapshot, community name and
--      media_urls, so the console can render exactly what a reporter saw.
--      Every call is audited via log_staff_action with the audience and
--      publish state at view time (viewing full content IS an act worth
--      auditing, same as warn/hide).
--
--   3. can_view_media_object learns two branches (the 0051 wrapper stays the
--      bucket's boundary, so staff media reach is inherited automatically):
--        - STAFF: a caller holding moderation.read may mint media of any
--          GATE-ANCHORED object, published or not. Anchored means the bytes
--          belong to a real posts row (the trigger only maps uploads once
--          they're referenced) — composer drafts, which are uploaded before
--          any post row exists, are still invisible to everyone but the
--          owner. This is what lets a reviewer inspect media of a post they
--          have just hidden, or that is college-scoped.
--        - COMMUNITY: posts with a community_id were previously evaluated as
--          plain posts (their gate row stores audience='public' → effectively
--          world-readable bytes for a private club!). They now mirror the
--          posts SELECT policy exactly: live post, live club, and public club
--          OR active member. The trigger already syncs community posts into
--          the gate; this migration backfills any strays.
--
-- Safe to re-run: drop-by-signature before create throughout.
-- Rollback notes inline per section.
-- =============================================================================

-- 1. staff_list_reports — new shape -------------------------------------------
drop function if exists public.staff_list_reports(text, int);

create or replace function public.staff_list_reports(
  p_status text default 'open',
  p_limit  int  default 60
)
returns table (
  report_id              uuid,
  status                 text,
  reason                 text,
  details                text,
  created_at             timestamptz,
  subject_kind           text,
  reporter_id            uuid,
  reporter_username      text,
  reporter_name          text,
  post_id                uuid,
  post_excerpt           text,
  post_author_id         uuid,
  post_author_username   text,
  post_is_published      boolean,
  post_created_at        timestamptz,
  post_audience          text,
  post_community_id      uuid,
  post_community_name    text,
  post_has_media         boolean,
  reported_user_id       uuid,
  reported_username      text,
  reported_name          text,
  reported_role          text,
  reported_account_status text,
  reviewed_by_id         uuid,
  reviewed_by_username   text,
  reviewed_at            timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_op('moderation.read') then
    raise exception 'You do not hold the moderation.read op.'
      using errcode = '42501';
  end if;

  if p_status not in ('open', 'reviewing', 'resolved', 'dismissed', 'all') then
    raise exception 'Unknown status filter %. Use open/reviewing/resolved/dismissed/all.', p_status
      using errcode = '22023';
  end if;

  return query
    select
      rp.id,
      rp.status::text,
      rp.reason,
      rp.details,
      rp.created_at,
      case
        when rp.post_id is not null and rp.reported_user_id is not null then 'post+person'
        when rp.post_id is not null then 'post'
        else 'person'
      end,
      rp.reporter_id,
      rep.username,
      rep.display_name,
      po.id,
      case when po.id is not null then left(po.body, 200) end,
      case when po.is_anonymous then null else po.author_id end,
      case when po.is_anonymous then null else pa.username end,
      po.is_published,
      po.created_at,
      po.audience::text,
      po.community_id,
      coalesce(c.name, case when po.community_id is not null then '<club gone>' end),
      exists (
        select 1
        from unnest(coalesce(po.media_urls, '{}')) as m(url)
        where coalesce(m.url, '') <> ''
      ),
      ru_p.id,
      ru_p.username,
      ru_p.display_name,
      ru_p.role,
      ru_p.account_status,
      rv.id,
      rv.username,
      rp.reviewed_at
    from public.reports rp
    left join public.profiles rep on rep.id = rp.reporter_id
    left join public.posts po     on po.id  = rp.post_id
    left join public.profiles pa  on pa.id  = po.author_id
    left join public.clubs c      on c.id   = po.community_id
    left join public.profiles ru_p on ru_p.id = rp.reported_user_id
    left join public.profiles rv  on rv.id  = rp.reviewed_by
    where (
      p_status = 'all'
      or rp.status = p_status::public.report_status
    )
    order by rp.created_at desc
    limit least(greatest(coalesce(p_limit, 60), 1), 200);
end $$;

-- 2. staff_fetch_post — full content view, audited ------------------------------
create or replace function public.staff_fetch_post(p_post_id uuid)
returns jsonb
language plpgsql
volatile                       -- auditing on read ⇒ must not be folded away
security definer
set search_path = public
as $$
declare
  v_row jsonb;
begin
  if not public.has_op('moderation.read') then
    raise exception 'You do not hold the moderation.read op.'
      using errcode = '42501';
  end if;

  if p_post_id is null then
    raise exception 'A post id is required.' using errcode = '22004';
  end if;

  select jsonb_build_object(
    'post_id',        po.id,
    'kind',           po.kind,
    'body',           po.body,
    'media_urls',     coalesce(po.media_urls, '{}'),
    'is_published',   po.is_published,
    'is_anonymous',   po.is_anonymous,
    'audience',       po.audience::text,
    'created_at',     po.created_at,
    'edited_at',      po.edited_at,
    'author_id',      case when po.is_anonymous then null else po.author_id end,
    'author_username',case when po.is_anonymous then null else pa.username end,
    'author_name',    case when po.is_anonymous then null else pa.display_name end,
    'author_role',    case when po.is_anonymous then null else pa.role end,
    'community_id',   po.community_id,
    'community_name', c.name,
    'community_privacy', c.privacy
  ) into v_row
  from public.posts po
  left join public.profiles pa on pa.id = po.author_id
  left join public.clubs c     on c.id  = po.community_id
  where po.id = p_post_id;

  if v_row is null then
    raise exception 'Post not found.' using errcode = 'P0002';
  end if;

  -- the audit row records the scope at view time: later rescoping cannot
  -- silently rewrite what a reviewer was able to see
  perform public.log_staff_action(
    'moderation.view_content', 'post', p_post_id,
    jsonb_build_object(
      'audience',     v_row->'audience',
      'is_published', v_row->'is_published',
      'community_id', v_row->'community_id'
    )
  );

  return v_row;
end $$;

revoke all on function public.staff_fetch_post(uuid) from public, anon;
grant  execute        on function public.staff_fetch_post(uuid) to authenticated;

-- (re-assert the whole 0044 grant block: the list_reports drop erased its grant)
revoke all on function public.staff_list_reports(text, int)      from public, anon;
revoke all on function public.staff_report_counts()              from public, anon;
revoke all on function public.staff_report_review(uuid, text, text) from public, anon;
revoke all on function public.staff_warn_user(uuid, text)        from public, anon;
revoke all on function public.staff_moderate_post(uuid, boolean, text) from public, anon;
grant  execute        on function public.staff_list_reports(text, int)      to authenticated;
grant  execute        on function public.staff_report_counts()              to authenticated;
grant  execute        on function public.staff_report_review(uuid, text, text) to authenticated;
grant  execute        on function public.staff_warn_user(uuid, text)        to authenticated;
grant  execute        on function public.staff_moderate_post(uuid, boolean, text) to authenticated;

-- 3. can_view_media_object — staff branch + community branch --------------------
-- (create or replace with the same signature published in 0051)
create or replace function public.can_view_media_object(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.post_media_gate g
    join public.posts p on p.id = g.post_id
    left join public.clubs c on c.id = p.community_id
    where g.name = p_name
      and p.is_published = true
      and (
        -- MODERATION: staff holding moderation.read may view media of any
        -- gate-anchored object, hidden or scoped — reviewing means seeing it.
        -- Anchored-only: composer drafts have no post row yet, hence no gate
        -- row, hence no staff reach (the owner policy still covers them).
        public.has_op('moderation.read')
        or (
          -- PLAIN POSTS: the 0049 rule, unchanged
          p.community_id is null
          and public.post_visible_to(p.audience, p.college_id, p.author_id)
        )
        or (
          -- COMMUNITY POSTS: mirror the posts SELECT policy (0016a) —
          -- live club, and public club OR active member. This replaces the
          -- accidental 'public' evaluation the gate rows carry.
          c.id is not null
          and c.archived_at is null
          and (
            c.privacy = 'public'
            or public.is_club_active_member(c.id, auth.uid())
          )
        )
      )
  )
$$;

-- 4. backfill: gate rows for community posts the 0051 backfill skipped ---------
-- (the trigger covers post-0051 inserts; this catches anything created
--  before 0051 — zero as of today, but the statement stays idempotent)
insert into public.post_media_gate (name, post_id, audience, college_id, author_id)
select
  regexp_replace(m.url, '^.*' || '/storage/v1/object/public/media/', ''),
  p.id, p.audience, p.college_id, p.author_id
from public.posts p
cross join unnest(coalesce(p.media_urls, '{}')) as m(url)
where coalesce(p.media_urls, '{}') <> '{}'
  and p.community_id is not null
on conflict (name, post_id) do nothing;

-- Rollback sketch (each section independent):
--   1/2: drop staff_fetch_post(uuid); recreate staff_list_reports from 0044.
--   3: recreate the 0051 wrapper body.
--   4: delete from post_media_gate g using posts p
--        where g.post_id = p.id and p.community_id is not null;
