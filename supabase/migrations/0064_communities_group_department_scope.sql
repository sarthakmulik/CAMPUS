-- 0064 - COMMUNITIES: INSTITUTION-GROUP AND DEPARTMENT SCOPES
--
-- APPLY ORDER: ... -> 0062 -> 0063 -> 0064.
--
-- Phase 7.5 asked for institution, institution-group, department and
-- interest communities. 0016 gave clubs exactly two derived scopes:
--   scope = 'global'   (college_id is null)
--   scope = 'college'  (college_id is not null)
-- generated from college_id, so a group-wide community and a
-- single-department community could not be expressed at all.
--
-- This replaces that generated column with a real one and adds 'group' and
-- 'department':
--
--   'global'     - anyone (unchanged)
--   'college'    - students whose declared college is that college (unchanged)
--   'group'      - students of any college in the club's institution group
--   'department' - students of one college AND one department
--
-- Nothing is duplicated: 'group' reuses colleges.institution_group_id and
-- 'department' reuses departments (0057) through a new clubs.department_id FK,
-- so a community never carries a second copy of an academic identity.
--
-- Backward compatibility:
--   * existing rows keep their meaning: the backfill writes 'college' /
--     'global' exactly where the generated column had them;
--   * list_clubs() keeps its signature and already filters on c.scope, so the
--     new values work with no change;
--   * club_detail()/posts/RLS keep their privacy-based rules - scope is an
--     eligibility rule at join time, not a read gate, so a group community is
--     discoverable exactly like a college one (privacy still decides);
--   * create_club() gains two OPTIONAL parameters, so existing callers and the
--     existing client keep working unchanged.

-- ---------------------------------------------------------------------------
-- 1. schema: real scope column + department reference
-- ---------------------------------------------------------------------------
alter table public.clubs drop column if exists scope;      -- generated: must be dropped, not updated
alter table public.clubs add column if not exists scope text not null default 'global';
alter table public.clubs add column if not exists department_id uuid
  references public.departments(id) on delete set null;

update public.clubs
   set scope = case when college_id is null then 'global' else 'college' end
 where scope = 'global' and college_id is not null;
update public.clubs
   set scope = 'global'
 where college_id is null and department_id is null and scope <> 'global';

alter table public.clubs drop constraint if exists clubs_scope_check;
alter table public.clubs add constraint clubs_scope_check
  check (scope in ('global', 'college', 'group', 'department'));

alter table public.clubs drop constraint if exists clubs_scope_coherence_check;
alter table public.clubs add constraint clubs_scope_coherence_check
  check (
    (scope = 'global'     and college_id is null and department_id is null)
    or (scope in ('college', 'group') and college_id is not null and department_id is null)
    or (scope = 'department' and college_id is not null and department_id is not null)
  );

create index if not exists clubs_department_idx on public.clubs (department_id);
create index if not exists clubs_scope_idx on public.clubs (scope);

-- Keep the derived relationship honest on every write path (create_club,
-- moderation edits, and any future RPC) instead of trusting one insert.
create or replace function public.clubs_scope_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.department_id is not null then
    if new.college_id is null then
      raise exception 'A department community must belong to a college.';
    end if;
    new.scope := 'department';
  elsif new.college_id is null then
    new.scope := 'global';
  elsif new.scope is null or new.scope = 'global' or new.scope = 'department' then
    new.scope := 'college';
  end if;
  return new;
end;
$$;

revoke all on function public.clubs_scope_guard() from public;

drop trigger if exists clubs_scope_guard_trg on public.clubs;
create trigger clubs_scope_guard_trg
  before insert or update of college_id, department_id, scope on public.clubs
  for each row execute function public.clubs_scope_guard();

-- ---------------------------------------------------------------------------
-- 2. eligibility at join time (covers join_club, club_join_rule, direct
--    self-service inserts and moderator approvals in one place)
-- ---------------------------------------------------------------------------
create or replace function public.club_member_scope_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_scope      text;
  v_college    uuid;
  v_department uuid;
  v_mine_college uuid;
  v_mine_department uuid;
begin
  -- only active memberships are eligibility questions; pending/banned rows
  -- are not, and a moderator adding somebody else is their own call
  if new.status <> 'active' or new.user_id is distinct from auth.uid() then
    return new;
  end if;

  select c.scope, c.college_id, c.department_id
    into v_scope, v_college, v_department
  from public.clubs c
  where c.id = new.club_id and c.archived_at is null;

  if v_scope is null or v_scope = 'global' then
    return new;
  end if;

  select p.college_id, p.department_id
    into v_mine_college, v_mine_department
  from public.profiles p where p.id = new.user_id;

  if v_mine_college is null then
    raise exception 'Add your college to your profile before joining a % community.', v_scope;
  end if;

  if v_scope = 'college' then
    if v_college is distinct from v_mine_college then
      raise exception 'This community belongs to another college.';
    end if;
  elsif v_scope = 'group' then
    if not public.shares_institution_group(v_college, v_mine_college) then
      raise exception 'This community belongs to another institution group.';
    end if;
  elsif v_scope = 'department' then
    if v_college is distinct from v_mine_college then
      raise exception 'This community belongs to another college.';
    elsif v_department is distinct from v_mine_department then
      raise exception 'This community is for a different department.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.club_member_scope_guard() from public;

drop trigger if exists club_member_scope_guard_trg on public.club_members;
create trigger club_member_scope_guard_trg
  before insert or update of status on public.club_members
  for each row execute function public.club_member_scope_guard();

-- ---------------------------------------------------------------------------
-- 3. club_join_rule(): answer the question the join would actually get
-- ---------------------------------------------------------------------------
create or replace function public.club_join_rule(p_club uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_privacy text;
  v_scope text;
  v_college uuid;
  v_department uuid;
  v_mine_college uuid;
  v_mine_department uuid;
  v_mine text;
begin
  select c.privacy, c.scope, c.college_id, c.department_id into v_privacy, v_scope, v_college, v_department
  from public.clubs c where c.id = p_club and c.archived_at is null;
  if v_privacy is null then
    return 'This community does not exist or is no longer active.';
  end if;
  select member_status into v_mine from public.club_member_ctx(p_club, auth.uid());
  if v_mine = 'banned' then
    return 'You were removed from this community and cannot rejoin.';
  end if;
  if v_mine = 'active' then
    return 'You are already a member of this community.';
  end if;
  if v_mine = 'pending' then
    return 'Your request is already waiting for a moderator.';
  end if;
  if v_scope in ('college', 'group', 'department') then
    select p.college_id, p.department_id into v_mine_college, v_mine_department
    from public.profiles p where p.id = auth.uid();
    if v_mine_college is null then
      return 'Add your college to your profile to join this community.';
    end if;
    if v_scope = 'college' and v_college is distinct from v_mine_college then
      return 'This community belongs to another college. Your declared college does not match.';
    end if;
    if v_scope = 'group' and not public.shares_institution_group(v_college, v_mine_college) then
      return 'This community belongs to another institution group.';
    end if;
    if v_scope = 'department' then
      if v_college is distinct from v_mine_college then
        return 'This community belongs to another college. Your declared college does not match.';
      end if;
      if v_department is distinct from v_mine_department then
        return 'This community is for a different department.';
      end if;
    end if;
  end if;
  if v_privacy = 'public' then
    return 'ok';
  end if;
  if v_privacy = 'private' then
    return 'request'; /* join = leave a pending request */
  end if;
  return 'hidden communities are invitation-only.';
end;
$$;

revoke all on function public.club_join_rule(uuid) from public;
grant execute on function public.club_join_rule(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. create_club(): optional scope + department, duplicate-name guard
-- ---------------------------------------------------------------------------
create or replace function public.create_club(
  p_name text,
  p_slug text,
  p_description text default '',
  p_category text default 'Other',
  p_college_id uuid default null,
  p_privacy text default 'public',
  p_rules text default '',
  p_logo_url text default null,
  p_cover_url text default null,
  p_scope text default null,
  p_department_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
  #variable_conflict use_column
declare
  v_me uuid := auth.uid();
  v_slug text;
  v_id uuid;
  v_college uuid;
  v_mine_college uuid;
  v_mine_department uuid;
  -- no scope given? keep 0016's meaning exactly: no college = global
  v_scope text := lower(btrim(coalesce(
    p_scope,
    case when p_college_id is null then 'global' else 'college' end)));
begin
  if v_me is null then
    raise exception 'Sign in to create a community.';
  end if;
  if p_name is null or length(btrim(p_name)) < 3 or length(btrim(p_name)) > 60 then
    raise exception 'Community name must be 3-60 characters.';
  end if;
  v_slug := lower(btrim(coalesce(p_slug, '')));
  if v_slug = '' then
    v_slug := lower(regexp_replace(btrim(p_name), '[^a-z0-9]+', '-', 'g'));
  end if;
  v_slug := regexp_replace(v_slug, '^-+|-+$', '', 'g');
  if v_slug is null or char_length(v_slug) < 3 or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'The URL slug must be lowercase letters, numbers and dashes (at least 3 characters).';
  end if;
  if p_privacy not in ('public', 'private', 'hidden') then
    raise exception 'Choose public, private or hidden.';
  end if;
  if (p_category in (
    'Academics','Technology','Projects','Careers and Placements','Clubs and Societies',
    'Campus Life','Gaming','Arts and Creativity','Sports and Fitness','Lifestyle','Other'
  )) is not true then
    raise exception 'Pick a category from the list.';
  end if;

  select college_id, department_id into v_mine_college, v_mine_department
  from public.profiles where id = v_me;

  -- resolve the academic scope from the creator's OWN declared identity
  if v_scope = 'global' then
    v_college := null;
  elsif v_scope in ('college', 'group') then
    if v_mine_college is null then
      raise exception 'Add your college to your profile before creating this community.';
    end if;
    v_college := v_mine_college;
    if p_college_id is not null and p_college_id <> v_mine_college then
      raise exception 'This community belongs to your declared college only.';
    end if;
  elsif v_scope = 'department' then
    if v_mine_college is null then
      raise exception 'Add your college to your profile before creating a department community.';
    end if;
    if v_mine_department is null then
      raise exception 'Add your department to your profile before creating a department community.';
    end if;
    if p_department_id is not null and p_department_id <> v_mine_department then
      raise exception 'You can only create a community for your own department.';
    end if;
    if p_college_id is not null and p_college_id <> v_mine_college then
      raise exception 'This community belongs to your declared college only.';
    end if;
    if not exists (
      select 1 from public.departments d
      where d.id = v_mine_department and d.college_id = v_mine_college
    ) then
      raise exception 'Your department is not part of your college any more — re-pick it in your profile.';
    end if;
    v_college := v_mine_college;
  else
    raise exception 'Choose global, college, group or department.';
  end if;

  -- one community of a given name per scope: five "Coding Club"s in one
  -- college is a directory problem, not a choice
  if exists (
    select 1 from public.clubs c
    where lower(btrim(c.name)) = lower(btrim(p_name))
      and c.archived_at is null
      and c.scope = v_scope
      and c.college_id is not distinct from v_college
      and (v_scope <> 'department' or c.department_id is not distinct from v_mine_department)
  ) then
    raise exception 'A community with that name already exists in this scope.';
  end if;

  if exists (select 1 from public.clubs where lower(slug) = v_slug) then
    raise exception 'That URL slug is already taken — try another.';
  end if;

  insert into public.clubs (
    name, slug, description, category, privacy, rules, logo_url, cover_image_url,
    college_id, department_id, scope, created_by
  ) values (
    btrim(p_name), v_slug, left(btrim(coalesce(p_description, '')), 500), p_category, p_privacy,
    left(btrim(coalesce(p_rules, '')), 2000), p_logo_url, p_cover_url,
    v_college,
    case when v_scope = 'department' then v_mine_department else null end,
    v_scope,
    v_me
  )
  returning id into v_id;

  insert into public.club_members (club_id, user_id, role, status)
  values (v_id, v_me, 'owner', 'active');

  perform public.ensure_club_conversation(v_id);
  return v_id;
end;
$$;

revoke all on function public.create_club(text, text, text, text, uuid, text, text, text, text, text, uuid) from public;
grant execute on function public.create_club(text, text, text, text, uuid, text, text, text, text, text, uuid) to authenticated;

-- NOTE: the old 9-argument signature is deliberately NOT kept as an overload.
-- Two overloads whose parameter names overlap make PostgREST unable to choose
-- a candidate (PGRST203) - exactly what broke request_college_suggestion in
-- 0057. The two new parameters are optional, so an existing client that sends
-- only the original nine names still resolves to this single function.