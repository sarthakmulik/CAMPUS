-- =============================================================================
-- 0044 — Moderation Center
--
-- Gives the staff tier its working moderation queue on top of the existing
-- public.reports table (schema.sql: reporter_id, post_id, reported_user_id,
-- reason, details, status report_status enum, reviewed_by/at).
--
-- Design notes:
--   * reports RLS stays member-scoped ("readers read own") — staff read through
--     security-definer RPCs only, so no policy changes here.
--   * Every RPC gates on the 0043 ops: moderation.read / moderation.act /
--     moderation.warn (all in the admin default bundle; super_admin holds '*').
--   * Every mutation writes a staff_audit_log row through log_staff_action().
--   * "Remove content" = posts.is_published = false — reversible, keeps the
--     record. Deleting rows is not moderation, it's destruction.
--   * Warn lands in the member's notifications as type 'staff_warning' —
--     the client's NotificationCenter already has a graceful default for
--     unknown types, and the UI gained a dedicated case in the same round.
--
-- Idempotent: create or replace + revoke/grant throughout.
-- =============================================================================

-- Faster queue scans once volume grows.
create index if not exists reports_status_created_idx
  on public.reports (status, created_at desc);

-- -----------------------------------------------------------------------------
-- 1. staff_list_reports(p_status, p_limit) — the queue
--
-- p_status: 'open' | 'reviewing' | 'resolved' | 'dismissed' | 'all'
-- Subject is either a post, a person, or both. Post excerpts are truncated to
-- 200 chars — the reviewer opens the real content, they don't moderate from a
-- summary.
-- -----------------------------------------------------------------------------
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
      po.author_id,
      pa.username,
      po.is_published,
      po.created_at,
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
    left join public.profiles ru_p on ru_p.id = rp.reported_user_id
    left join public.profiles rv  on rv.id  = rp.reviewed_by
    where (
      p_status = 'all'
      or rp.status = p_status::public.report_status
    )
    order by rp.created_at desc
    limit least(greatest(coalesce(p_limit, 60), 1), 200);
end $$;

-- -----------------------------------------------------------------------------
-- 2. staff_report_counts() — honest chips for the queue filters + dashboard
-- -----------------------------------------------------------------------------
create or replace function public.staff_report_counts()
returns jsonb
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

  return (
    select jsonb_build_object(
      'open',      count(*) filter (where status = 'open'),
      'reviewing', count(*) filter (where status = 'reviewing'),
      'resolved',  count(*) filter (where status = 'resolved'),
      'dismissed', count(*) filter (where status = 'dismissed')
    )
    from public.reports
  );
end $$;

-- -----------------------------------------------------------------------------
-- 3. staff_report_review(p_report, p_status, p_note) — triage one report
--
-- p_status: 'open' (re-open) | 'reviewing' | 'resolved' | 'dismissed'
-- The acting staff account is stamped into reviewed_by/reviewed_at and the
-- transition (from → to) is audited with the reviewer's note.
-- -----------------------------------------------------------------------------
create or replace function public.staff_report_review(
  p_report uuid,
  p_status text,
  p_note   text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from public.report_status;
begin
  if not public.has_op('moderation.act') then
    raise exception 'You do not hold the moderation.act op.'
      using errcode = '42501';
  end if;

  if p_status not in ('open', 'reviewing', 'resolved', 'dismissed') then
    raise exception 'Unknown status %.', p_status
      using errcode = '22023';
  end if;

  select status into v_from
    from public.reports
   where id = p_report;

  if v_from is null then
    raise exception 'Report not found.'
      using errcode = 'P0002';
  end if;

  update public.reports
     set status       = p_status::public.report_status,
         reviewed_by  = auth.uid(),
         reviewed_at  = now()
   where id = p_report;

  perform public.log_staff_action('moderation.report_status', 'report', p_report,
    jsonb_build_object(
      'from', v_from,
      'to',   p_status,
      'note', nullif(btrim(coalesce(p_note, '')), '')
    ));
  return p_status;
end $$;

-- -----------------------------------------------------------------------------
-- 4. staff_warn_user(p_user, p_note) — formal warning via notifications
--
-- Members only (staff are exempt from member moderation, same rule as
-- member_suspend). The note is required — it is the message the member reads
-- in their notifications, delivered as type 'staff_warning'.
-- -----------------------------------------------------------------------------
create or replace function public.staff_warn_user(
  p_user uuid,
  p_note text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if not public.has_op('moderation.warn') then
    raise exception 'You do not hold the moderation.warn op.'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'A warning needs a note — tell the member why.'
      using errcode = '22023';
  end if;

  select role into v_role from public.profiles where id = p_user;
  if v_role is null then
    raise exception 'Profile not found.'
      using errcode = 'P0002';
  end if;
  if v_role <> 'member' then
    raise exception 'Staff accounts cannot be warned — use staff_remove instead.';
  end if;

  insert into public.notifications (recipient_id, actor_id, type, entity_type, metadata)
  values (p_user, auth.uid(), 'staff_warning', 'moderation',
          jsonb_build_object('note', btrim(p_note)));

  perform public.log_staff_action('moderation.warn', 'profile', p_user,
    jsonb_build_object('note', btrim(p_note)));
  return 'warned';
end $$;

-- -----------------------------------------------------------------------------
-- 5. staff_moderate_post(p_post, p_unpublish, p_note) — reversible content
--    removal. Unpublish keeps the record and satisfies the reporter; restore
--    undoes it. Deleting user content from within the platform is not part of
--    moderation by design.
-- -----------------------------------------------------------------------------
create or replace function public.staff_moderate_post(
  p_post      uuid,
  p_unpublish boolean default true,
  p_note      text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now boolean;
begin
  if not public.has_op('moderation.act') then
    raise exception 'You do not hold the moderation.act op.'
      using errcode = '42501';
  end if;

  select is_published into v_now from public.posts where id = p_post;
  if v_now is null then
    raise exception 'Post not found.'
      using errcode = 'P0002';
  end if;
  if v_now = (not p_unpublish) then
    raise exception 'That post is already %.', case when p_unpublish then 'hidden' else 'live' end
      using errcode = '22023';
  end if;

  update public.posts
     set is_published = not p_unpublish,
         updated_at   = now()
   where id = p_post;

  perform public.log_staff_action(
    case when p_unpublish then 'moderation.post_hidden' else 'moderation.post_restored' end,
    'post', p_post,
    jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')));
  return case when p_unpublish then 'hidden' else 'live' end;
end $$;

-- Public surface: none of these are callable by anon, and the general public
-- role gets nothing. Real staff sessions call them through the console.
revoke all on function public.staff_list_reports(text, int)    from public, anon;
revoke all on function public.staff_report_counts()            from public, anon;
revoke all on function public.staff_report_review(uuid, text, text) from public, anon;
revoke all on function public.staff_warn_user(uuid, text)      from public, anon;
revoke all on function public.staff_moderate_post(uuid, boolean, text) from public, anon;

grant execute on function public.staff_list_reports(text, int)    to authenticated;
grant execute on function public.staff_report_counts()            to authenticated;
grant execute on function public.staff_report_review(uuid, text, text) to authenticated;
grant execute on function public.staff_warn_user(uuid, text)      to authenticated;
grant execute on function public.staff_moderate_post(uuid, boolean, text) to authenticated;
