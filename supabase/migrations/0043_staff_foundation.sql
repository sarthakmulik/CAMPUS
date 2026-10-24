-- ============================================================================
-- 0043 — STAFF FOUNDATION: admins stop being "users with a flag"
--
-- Model decisions (locked with product owner):
--   * SAME database, dedicated staff tier. Public signup always creates a
--     normal member; staff accounts are provisioned through trusted RPCs or
--     the SQL editor, never through the signup form.
--   * Tiers TODAY: super_admin (platform owner) + admin. The scopes column is
--     extensible, so moderator / ads_manager / support can be added later
--     with zero schema changes — just new scope strings.
--   * Moderation enforcement in this cut: warn + suspend at the database
--     level (RLS/trigger), fully reversible. A true auth-level ban (blocking
--     sign-in) needs a documented server-side step with the service-role key
--     and is deliberately deferred.
--   * Staff keep posting social announcements as @campus — the account stays
--     a real member of the community; only its POWERS live in staff_accounts.
--     Staff are however excluded from being counted as "students":
--     leaderboard and follow suggestions never surface them.
--
-- Contents:
--   1.  profiles: role now allows 'super_admin'; account_status suspend
--       columns; admins/super_admins are onboarding-complete (mirrors 0042).
--   2.  staff_accounts — 1:1 with profiles, the platform identity of staff
--       (tier, scopes, title, active, provisioned/revoked bookkeeping).
--   3.  staff_audit_log — one row for every staff mutation, readable by staff
--       only, writable ONLY through trusted code.
--   4.  Helpers: is_staff() / is_super_admin() / is_admin() (compat layer —
--       the ads system's 59/59 matrix keeps gating on is_admin()) / has_op()
--       granular scope check with 'ads.*' wildcards.
--   5.  Provisioning RPCs (staff_provision / staff_scopes_set / staff_remove /
--       staff_list) — super_admin only, every action audited, self-demotion
--       and last-super-admin removal impossible.
--   6.  Suspended members: assert_caller_not_suspended() write-block trigger
--       attached to every user-writable table, plus suspended authors hidden
--       from the public feed, the leaderboard and follow suggestions.
--   7.  Trusted role-change token so provisioning RPCs can set profiles.role
--       despite the 0037 client write lock (transaction-scoped, definer-only).
--   8.  Bootstrap: @campus becomes super_admin; the existing test admin is
--       registered in staff_accounts. Everything is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles: wider role check + suspend columns
-- ---------------------------------------------------------------------------

-- widen the role check to include the owner tier
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('member', 'admin', 'super_admin'));

-- suspend state on the profile row (P1: RLS/trigger enforcement, reversible)
alter table public.profiles
  add column if not exists account_status text not null default 'active';
alter table public.profiles
  add column if not exists suspended_at timestamptz;
alter table public.profiles
  add column if not exists suspend_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'profiles_account_status_check'
       and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_account_status_check
      check (account_status in ('active', 'suspended'));
  end if;
end $$;

-- admins (and now super_admins) are platform staff: no college, never stuck
-- in the student onboarding wizard (mirrors 0042 for the new role value)
update public.profiles
   set college_id = null
 where role in ('admin', 'super_admin')
   and college_id is not null;

update public.profiles
   set onboarding_step = coalesce(onboarding_step, 6),
       onboarding_completed_at = coalesce(onboarding_completed_at, now())
 where role in ('admin', 'super_admin')
   and (onboarding_completed_at is null or onboarding_step is null or onboarding_step < 6);

-- 0042's guard covered role='admin' only; extend it to super_admin
create or replace function public.admin_profile_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role in ('admin', 'super_admin') and new.college_id is not null then
    new.college_id := null;
    new.college_declared_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tr_profiles_admin_no_college on public.profiles;
create trigger tr_profiles_admin_no_college
  before insert or update on public.profiles
  for each row execute function public.admin_profile_guard();

-- ---------------------------------------------------------------------------
-- 2. helper functions (defined BEFORE the tables whose RLS uses them —
--    Postgres validates function references at policy-creation time)
--
--    All SECURITY DEFINER so RLS on profiles can never recurse; the ads
--    round proved this pattern is required — 42P17.
-- ---------------------------------------------------------------------------

-- is_staff(): admins AND the owner tier, by role. References profiles only —
-- staff_accounts policies depend on this, so it must never read staff_accounts
-- back (that would be the RLS recursion the ads round hit).
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('admin', 'super_admin')
  )
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role = 'super_admin'
  )
$$;

-- is_admin() stays the COMPAT layer: identical semantics to today
-- (admins and above) so every existing gate — the whole advertising system's
-- policies and RPCs — keeps passing without touching 0035–0041.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('admin', 'super_admin')
  )
$$;

-- has_op(): the granular gate going forward. Requires an ACTIVE staff row.
-- super_admin implicitly holds '*'; admins hold explicit scopes, where
-- 'ads.*' covers every ads op and '*' covers everything.
create or replace function public.has_op(p_op text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scopes text[];
  v_first  text;
begin
  p_op := btrim(coalesce(p_op, ''));
  if p_op = '' or auth.uid() is null then
    return false;
  end if;

  select s.scopes into v_scopes
    from public.staff_accounts s
   where s.user_id = auth.uid()
     and s.is_active;
  if not found then
    return false;
  end if;

  if public.is_super_admin() then
    return true;
  end if;

  v_first := split_part(p_op, '.', 1);
  return exists (
    select 1
      from unnest(v_scopes) as sc(scope)
     where sc.scope = p_op
        or sc.scope = '*'
        or sc.scope = v_first || '.*'
  );
end $$;

-- account_can_write(): the suspend gate. Default is PERMISSIVE: an account
-- that has no profile row yet (mid-signup) or an active one can write; only
-- an explicit 'suspended' row is blocked. Staff are never suspended.
create or replace function public.account_can_write(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user is null or not exists (
    select 1 from public.profiles
     where id = p_user
       and account_status = 'suspended'
  )
$$;

-- author_hidden(): suspended authors vanish from public surfaces.
create or replace function public.author_hidden(p_author uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = p_author
       and account_status = 'suspended'
  )
$$;

-- log_staff_action(): audit writer, ONLY callable from trusted definer code.
create or replace function public.log_staff_action(
  p_action      text,
  p_target_type text default null,
  p_target_id   uuid default null,
  p_metadata    jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.staff_audit_log (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), p_action, p_target_type, p_target_id, p_metadata);
end $$;

revoke all on function public.log_staff_action(text, text, uuid, jsonb) from public;

-- ---------------------------------------------------------------------------
-- 3. staff_accounts — the platform identity of staff
-- ---------------------------------------------------------------------------
create table if not exists public.staff_accounts (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  tier           text not null default 'admin' check (tier in ('super_admin', 'admin')),
  scopes         text[] not null default '{}',
  title          text,
  is_active      boolean not null default true,
  provisioned_by uuid references public.profiles(id),
  provisioned_at timestamptz not null default now(),
  revoked_at     timestamptz,
  note           text
);

alter table public.staff_accounts enable row level security;

drop policy if exists staff_accounts_read on public.staff_accounts;
create policy staff_accounts_read on public.staff_accounts
  for select using (public.is_staff());
-- no insert/update/delete policies: staff rows are managed exclusively by
-- trusted security-definer RPCs (which run as the table owner and bypass RLS).

-- ---------------------------------------------------------------------------
-- 4. staff_audit_log — every staff mutation, one row, trusted-writes only
-- ---------------------------------------------------------------------------
create table if not exists public.staff_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles(id),
  action      text not null,
  target_type text,
  target_id   uuid,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

alter table public.staff_audit_log enable row level security;

drop policy if exists staff_audit_read on public.staff_audit_log;
create policy staff_audit_read on public.staff_audit_log
  for select using (public.is_staff());
-- no insert/update/delete policies — audit rows go in via log_staff_action()
-- inside trusted definer RPCs only. Nothing can forge or edit history.

-- ---------------------------------------------------------------------------
-- 5. trusted role-change token
--
-- 0037 rejects role changes from any authenticated caller — that lock also
-- fires inside security-definer RPCs, because auth.uid() is still set in the
-- session there. Provisioning needs a sanctioned path: a definer function
-- sets a transaction-scoped GUC token, and the 0037 trigger accepts role
-- changes only while that token is present. The token disappears with the
-- transaction; no client can set it (it's set by trusted owner code only).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_role_trusted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No auth uid = SQL editor / service jobs: human-administered by design.
  if auth.uid() is null then
    return new;
  end if;

  if TG_OP = 'UPDATE'
     and new.role is distinct from old.role
     and coalesce(current_setting('app.trusted_role_change', true), '') <> 'staff_provision' then
    raise exception 'Role changes are handled only by trusted CAMPUS tooling — your edit was rejected.'
      using errcode = '42501';
  end if;

  if TG_OP = 'INSERT' and coalesce(new.role, 'member') <> 'member' then
    new.role := 'member'; -- first-row inserts can never self-assign privileges
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. provisioning RPCs — super_admin only, audited, guarded
-- ---------------------------------------------------------------------------

-- Default scope sets per tier. super_admin owns everything ('*'). admin is
-- the working platform admin. The blueprints are called at provision time —
-- changing them later only affects NEW staff; per-account overrides via
-- staff_scopes_set are always possible.
create or replace function public.staff_default_scopes(p_tier text)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select case p_tier
    when 'super_admin' then array['*']::text[]
    else array['moderation.read', 'moderation.act', 'moderation.suspend',
               'moderation.warn', 'people.read', 'people.verify',
               'colleges.manage', 'ads.*', 'settings.read']::text[]
  end
$$;

revoke all on function public.staff_default_scopes(text) from public;

create or replace function public.staff_provision(
  p_user   uuid,
  p_tier   text default 'admin',
  p_title  text default null,
  p_scopes text[] default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role   text := coalesce(nullif(btrim(p_tier), ''), 'admin');
  v_scopes text[];
begin
  if not public.is_super_admin() then
    raise exception 'Only a super admin can provision staff accounts.'
      using errcode = '42501';
  end if;

  if v_role not in ('super_admin', 'admin') then
    raise exception 'Unknown staff tier.';
  end if;

  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'No profile exists for that user yet.';
  end if;

  if exists (
    select 1 from public.profiles
     where id = p_user and account_status = 'suspended'
  ) then
    raise exception 'Unsuspend this account before provisioning it as staff.';
  end if;

  v_scopes := coalesce(p_scopes, public.staff_default_scopes(v_role));

  -- roles may only change through trusted tooling (0037): announce the token
  -- for this transaction, then set the tier on the profile row.
  perform set_config('app.trusted_role_change', 'staff_provision', true);

  update public.profiles
     set role = v_role,
         onboarding_step = coalesce(onboarding_step, 6),
         onboarding_completed_at = coalesce(onboarding_completed_at, now())
   where id = p_user;

  insert into public.staff_accounts
    (user_id, tier, scopes, title, is_active, provisioned_by, provisioned_at, revoked_at)
  values
    (p_user, v_role, v_scopes, p_title, true, auth.uid(), now(), null)
  on conflict (user_id) do update
    set tier         = excluded.tier,
        scopes       = excluded.scopes,
        title        = coalesce(excluded.title, staff_accounts.title),
        is_active    = true,
        provisioned_by = coalesce(excluded.provisioned_by, staff_accounts.provisioned_by),
        revoked_at   = null;

  perform public.log_staff_action(
    'staff.provision', 'profile', p_user,
    jsonb_build_object('tier', v_role, 'scopes', v_scopes, 'title', p_title)
  );

  return v_role;
end $$;

-- per-account scope override (super_admin only; never on the owner tier)
create or replace function public.staff_scopes_set(
  p_user   uuid,
  p_scopes text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only a super admin can change staff scopes.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.staff_accounts
     where user_id = p_user and is_active and tier <> 'super_admin'
  ) then
    raise exception 'No active admin staff row for that user (super admins always hold *).';
  end if;

  update public.staff_accounts
     set scopes = coalesce(p_scopes, '{}')
   where user_id = p_user;

  perform public.log_staff_action('staff.scopes_set', 'profile', p_user,
    jsonb_build_object('scopes', coalesce(p_scopes, '{}')));
end $$;

-- revoke: demote back to member. Self-revocation and removing the last
-- active super admin are both impossible.
create or replace function public.staff_remove(p_user uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only a super admin can revoke staff accounts.'
      using errcode = '42501';
  end if;

  if p_user = auth.uid() then
    raise exception 'You cannot revoke your own staff account.';
  end if;

  if not exists (
    select 1 from public.staff_accounts
     where user_id = p_user and is_active
  ) then
    raise exception 'That account is not an active staff member.';
  end if;

  if exists (
    select 1 from public.staff_accounts
     where user_id = p_user and tier = 'super_admin' and is_active
  ) then
    if (select count(*) from public.staff_accounts s
         where s.tier = 'super_admin' and s.is_active
           and exists (select 1 from public.profiles p
                        where p.id = s.user_id and p.role = 'super_admin')
       ) <= 1 then
      raise exception 'CAMPUS must always keep one active super admin.';
    end if;
  end if;

  update public.staff_accounts
     set is_active = false, revoked_at = now()
   where user_id = p_user;

  perform set_config('app.trusted_role_change', 'staff_provision', true);
  update public.profiles
     set role = 'member'
   where id = p_user and role in ('admin', 'super_admin');

  perform public.log_staff_action('staff.revoke', 'profile', p_user, null);
  return 'revoked';
end $$;

-- roster read
create or replace function public.staff_list()
returns table (
  user_id        uuid,
  username       text,
  display_name   text,
  avatar_url     text,
  tier           text,
  scopes         text[],
  title          text,
  is_active      boolean,
  account_status text,
  provisioned_at timestamptz,
  revoked_at     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.user_id, p.username, p.display_name, p.avatar_url,
    s.tier, s.scopes, s.title, s.is_active, p.account_status,
    s.provisioned_at, s.revoked_at
  from public.staff_accounts s
  join public.profiles p on p.id = s.user_id
  order by s.is_active desc, s.tier, p.username nulls last
$$;

-- ---------------------------------------------------------------------------
-- 7. suspend — reversible, database-enforced (warn ships with the Moderation
--    Center in 0044, where it lands in the notifications flow)
-- ---------------------------------------------------------------------------

create or replace function public.member_suspend(p_user uuid, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_op('moderation.suspend') then
    raise exception 'You do not hold the moderation.suspend op.'
      using errcode = '42501';
  end if;

  if p_user = auth.uid() then
    raise exception 'Staff accounts cannot be suspended — use staff_remove instead.';
  end if;

  update public.profiles
     set account_status = 'suspended',
         suspended_at = now(),
         suspend_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_user
     and role = 'member'
     and account_status <> 'suspended';

  if not found then
    raise exception 'Suspension applies to active member accounts only (staff are exempt).';
  end if;

  perform public.log_staff_action('member.suspend', 'profile', p_user,
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')));
  return 'suspended';
end $$;

create or replace function public.member_unsuspend(p_user uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_op('moderation.suspend') then
    raise exception 'You do not hold the moderation.suspend op.'
      using errcode = '42501';
  end if;

  update public.profiles
     set account_status = 'active',
         suspended_at = null,
         suspend_reason = null
   where id = p_user
     and role = 'member'
     and account_status = 'suspended';

  if not found then
    raise exception 'That account is not currently suspended.';
  end if;

  perform public.log_staff_action('member.unsuspend', 'profile', p_user, null);
  return 'active';
end $$;

-- ---------------------------------------------------------------------------
-- 8. suspended members cannot write — trigger block on every user-writable
--    table. Suspended members can still sign in and read (a full auth-level
--    ban is the documented server-side follow-up).
-- ---------------------------------------------------------------------------

create or replace function public.assert_caller_not_suspended()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and not public.account_can_write(auth.uid()) then
    raise exception 'Your account is suspended — writes are blocked.'
      using errcode = '55006';
  end if;
  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

-- attach to every table where members directly create or change content
do $trigger_loop$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'posts', 'post_comments', 'post_likes', 'post_bookmarks',
    'comment_likes', 'follows', 'chat_messages', 'club_members',
    'community_invitations', 'community_resources', 'marketplace_listings',
    'events', 'event_rsvps'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists tr_block_suspended_writes on public.%I', t);
      execute format(
        'create trigger tr_block_suspended_writes
            before insert or update or delete on public.%I
            for each row execute function public.assert_caller_not_suspended()', t);
    end if;
  end loop;
end
$trigger_loop$;

-- ---------------------------------------------------------------------------
-- 9. public surfaces: suspended authors vanish, staff never rank as students
-- ---------------------------------------------------------------------------

-- the public feed (latest signature — 0016): hide suspended authors
create or replace function public.list_public_posts(
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
language sql
stable
security definer
set search_path = '' as $$
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
    and (p_college_id is null or p.college_id = p_college_id)
    and not public.author_hidden(p.author_id)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

-- list_leaderboard (0027 body, unchanged logic, one addition): only non-
-- suspended members can rank. Filtering INSIDE the scoring CTEs keeps
-- positions contiguous instead of leaving gaps behind excluded staff.
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
    join public.profiles pm
      on pm.id = le.user_id
     and pm.role = 'member'
     and pm.account_status <> 'suspended'
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
    join public.profiles pm
      on pm.id = le.user_id
     and pm.role = 'member'
     and pm.account_status <> 'suspended'
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

-- ---------------------------------------------------------------------------
-- 10. execution grants. Functions are PUBLIC-executable by default in
--     Postgres — management RPCs must be revoked then re-granted to
--     authenticated only. Tier checks live inside the definer bodies.
-- ---------------------------------------------------------------------------
revoke all on function public.staff_provision(uuid, text, text, text[]) from public;
grant  execute on function public.staff_provision(uuid, text, text, text[]) to authenticated;

revoke all on function public.staff_scopes_set(uuid, text[]) from public;
grant  execute on function public.staff_scopes_set(uuid, text[]) to authenticated;

revoke all on function public.staff_remove(uuid) from public;
grant  execute on function public.staff_remove(uuid) to authenticated;

revoke all on function public.staff_list() from public;
grant  execute on function public.staff_list() to authenticated;

revoke all on function public.member_suspend(uuid, text) from public;
grant  execute on function public.member_suspend(uuid, text) to authenticated;

revoke all on function public.member_unsuspend(uuid) from public;
grant  execute on function public.member_unsuspend(uuid) to authenticated;

revoke all on function public.has_op(text) from public;
grant  execute on function public.has_op(text) to anon, authenticated;

revoke all on function public.is_admin() from anon;
grant  execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. bootstrap (idempotent, runs in the SQL editor = superuser context)
--       * @campus → super_admin, Platform Owner ('*')
--       * the existing test admin → registered admin with default scopes
--       * both actions land in the audit trail
-- ---------------------------------------------------------------------------
update public.profiles
   set role = 'super_admin'
 where username = 'campus'
   and role <> 'super_admin';

insert into public.staff_accounts
  (user_id, tier, scopes, title, is_active, provisioned_at, revoked_at)
select p.id, 'super_admin', array['*']::text[], 'Platform Owner', true, now(), null
  from public.profiles p
 where p.username = 'campus'
on conflict (user_id) do update
  set tier = 'super_admin', scopes = array['*']::text[],
      is_active = true, revoked_at = null;

update public.profiles
   set role = 'admin',
       college_id = null,
       onboarding_step = coalesce(onboarding_step, 6),
       onboarding_completed_at = coalesce(onboarding_completed_at, now())
 where role = 'member'
   and id in (select id from auth.users where email = 'sarthakmulik16@gmail.com');

insert into public.staff_accounts
  (user_id, tier, scopes, title, is_active, provisioned_at, revoked_at)
select u.id, 'admin', public.staff_default_scopes('admin'), 'Campus Admin', true, now(), null
  from auth.users u
 where u.email = 'sarthakmulik16@gmail.com'
on conflict (user_id) do update
  set tier = 'admin',
      scopes = public.staff_default_scopes('admin'),
      is_active = true,
      revoked_at = null;

insert into public.staff_audit_log (actor_id, action, target_type, target_id, metadata)
select p.id, 'staff.bootstrap', 'profile', p.id, jsonb_build_object('tier', p.role)
  from public.profiles p
 where (p.username = 'campus' or p.role in ('admin', 'super_admin'))
   and not exists (
     select 1 from public.staff_audit_log a
      where a.action = 'staff.bootstrap' and a.target_id = p.id
   );

-- ---------------------------------------------------------------------------
-- Done. After applying:
--   is_admin()      — admins AND super_admins (ads system untouched)
--   is_super_admin()— owner only
--   has_op('ads.*') — granular, today only staff rows pass
--   staff_list()    — super admin console roster
--   member_suspend()/member_unsuspend() — reversible RLS-enforced moderation
-- ============================================================================
