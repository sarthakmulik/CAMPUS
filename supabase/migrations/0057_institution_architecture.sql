-- 0057 - INSTITUTION ARCHITECTURE (Pune multi-level directory)
--
-- Hierarchy: institution_group -> campus -> college (= individual institution)
--            -> departments / academic_programs -> profile
--
-- DESIGN DECISION (audited 2026-11-14): `colleges` already IS the individual-
-- institution entity - stable UUID PK referenced by profiles, posts, clubs,
-- events, opportunities, campus-pulse tables and ad_campaigns. Every feed,
-- My College surface, Pulse scope and community keys on colleges.id. We
-- therefore EXTEND `colleges` with hierarchy FKs instead of introducing a
-- parallel `institutions` table (which would touch every feature and risk
-- the RLS isolation work). Zero existing query changes; everything new is
-- additive.
--
-- Backward compatibility: no column is dropped, no existing value is
-- rewritten, no existing college row is deleted. New FKs are NULLABLE.
-- Idempotent: create-if-not-exists / add-if-not-exists / upsert semantics.

-- ------------------------------------------------------------------ --
-- 1. institution_groups (JSPM, MIT, Sinhgad, ...)                     --
-- ------------------------------------------------------------------ --
create table if not exists public.institution_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  slug        text not null unique,
  description text not null default '',
  logo_url    text,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.institution_groups enable row level security;
-- directory data is public info; anonymous visitors browse colleges at signup
drop policy if exists "institution_groups public read" on public.institution_groups;
create policy "institution_groups public read" on public.institution_groups
  for select using (true);

-- ------------------------------------------------------------------ --
-- 2. campuses (physical locations; several colleges may share one)    --
-- ------------------------------------------------------------------ --
create table if not exists public.campuses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  locality    text not null,                 -- Hadapsar, Wagholi, ...
  city        text not null default 'Pune',
  district    text not null default 'Pune',
  state       text not null default 'Maharashtra',
  address     text,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (name, locality, city)
);
alter table public.campuses enable row level security;
drop policy if exists "campuses public read" on public.campuses;
create policy "campuses public read" on public.campuses
  for select using (true);

-- ------------------------------------------------------------------ --
-- 3. colleges: extend into the individual-institution record          --
-- ------------------------------------------------------------------ --
alter table public.colleges
  add column if not exists official_name   text,
  add column if not exists institution_group_id uuid references public.institution_groups(id) on delete set null,
  add column if not exists campus_id       uuid references public.campuses(id) on delete set null,
  add column if not exists institution_type text
    check (institution_type in ('university','engineering','polytechnic','pharmacy','management','arts_science','law','design','medical','education','other')),
  add column if not exists locality        text,
  add column if not exists official_website text,
  add column if not exists aliases         text[] not null default '{}',
  add column if not exists slug            text unique,
  -- real verification pipeline; `verified` boolean stays for compatibility
  add column if not exists verification_status text not null default 'pending_review'
    check (verification_status in ('verified','pending_review','rejected'));

create index if not exists colleges_group_idx on public.colleges (institution_group_id);
create index if not exists colleges_campus_idx on public.colleges (campus_id);
create index if not exists colleges_type_idx on public.colleges (institution_type);
create index if not exists colleges_lower_name_idx on public.colleges (lower(name));
create index if not exists colleges_locality_idx on public.colleges (lower(coalesce(locality, '')));
-- keep name+short_name searches fast
create index if not exists colleges_lower_short_name_idx on public.colleges (lower(short_name));

-- ------------------------------------------------------------------ --
-- 4. institution_campuses: an institution operating at >1 campus      --
--    (campus_id on colleges is the PRIMARY campus)                    --
-- ------------------------------------------------------------------ --
create table if not exists public.institution_campuses (
  institution_id uuid not null references public.colleges(id) on delete cascade,
  campus_id      uuid not null references public.campuses(id) on delete cascade,
  is_primary     boolean not null default false,
  primary key (institution_id, campus_id)
);
alter table public.institution_campuses enable row level security;
drop policy if exists "institution_campuses public read" on public.institution_campuses;
create policy "institution_campuses public read" on public.institution_campuses
  for select using (true);

-- ------------------------------------------------------------------ --
-- 5. departments: institution-specific (no cross-college leakage)     --
-- ------------------------------------------------------------------ --
create table if not exists public.departments (
  id             uuid primary key default gen_random_uuid(),
  college_id     uuid not null references public.colleges(id) on delete cascade,
  name           text not null,
  abbreviation   text,
  status         text not null default 'active' check (status in ('active','inactive')),
  created_at     timestamptz not null default now()
);
-- case-insensitive per-college uniqueness (an expression index — inline
-- UNIQUE constraints cannot take expressions, which is what broke 42601)
create unique index if not exists departments_college_name_key
  on public.departments (college_id, lower(name));
alter table public.departments enable row level security;
drop policy if exists "departments public read" on public.departments;
create policy "departments public read" on public.departments
  for select using (true);
create index if not exists departments_college_idx on public.departments (college_id) where status = 'active';

-- ------------------------------------------------------------------ --
-- 6. academic_programs: institution-specific degree offerings         --
-- ------------------------------------------------------------------ --
create table if not exists public.academic_programs (
  id           uuid primary key default gen_random_uuid(),
  college_id   uuid not null references public.colleges(id) on delete cascade,
  name         text not null,                  -- B.Tech, MBA, B.Pharm ...
  level        text not null default 'undergraduate'
    check (level in ('diploma','undergraduate','postgraduate','doctoral','certificate')),
  status       text not null default 'active' check (status in ('active','inactive')),
  created_at   timestamptz not null default now()
);
-- case-insensitive per-college uniqueness (expression index, same reason as departments)
create unique index if not exists academic_programs_college_name_key
  on public.academic_programs (college_id, lower(name));
alter table public.academic_programs enable row level security;
drop policy if exists "academic_programs public read" on public.academic_programs;
create policy "academic_programs public read" on public.academic_programs
  for select using (true);
create index if not exists academic_programs_college_idx on public.academic_programs (college_id) where status = 'active';

-- ------------------------------------------------------------------ --
-- 7. profiles: real academic identity (all nullable; nothing resets)  --
-- ------------------------------------------------------------------ --
alter table public.profiles
  add column if not exists department_id uuid references public.departments(id) on delete set null,
  add column if not exists campus_id     uuid references public.campuses(id) on delete set null,
  add column if not exists academic_program_id uuid references public.academic_programs(id) on delete set null,
  add column if not exists semester      smallint check (semester between 1 and 10);

create index if not exists profiles_department_idx on public.profiles (department_id);
create index if not exists profiles_campus_idx on public.profiles (campus_id);

-- ------------------------------------------------------------------ --
-- 8. college_suggestions: richer missing-college requests (Phase 6)   --
--    existing table + RPC preserved; additive columns only            --
-- ------------------------------------------------------------------ --
alter table public.college_suggestions
  add column if not exists locality        text,
  add column if not exists official_website text,
  add column if not exists institution_type text,
  add column if not exists institution_group text,
  add column if not exists status_note     text;

-- ------------------------------------------------------------------ --
-- 9. updated_at triggers for the new tables                           --
-- ------------------------------------------------------------------ --
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'touch_updated_at') then
    create function public.touch_updated_at() returns trigger
    language plpgsql as $fn$
    begin
      new.updated_at = now();
      return new;
    end;
    $fn$;
  end if;
end $$;

drop trigger if exists institution_groups_touch on public.institution_groups;
create trigger institution_groups_touch before update on public.institution_groups
  for each row execute function public.touch_updated_at();

drop trigger if exists campuses_touch on public.campuses;
create trigger campuses_touch before update on public.campuses
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ --
-- 10. search_institutions: THE directory search the signup uses       --
--     Ranked: exact short/official name > prefix > abbreviation/alias --
--     > group name > locality > substring. Empty query returns the    --
--     launch-priority list (verified Hadapsar institutions first).    --
--     Only VERIFIED institutions are publicly selectable; staff       --
--     (is_admin) additionally sees pending_review rows flagged.       --
-- ------------------------------------------------------------------ --
create or replace function public.search_institutions(p_query text, p_limit int default 25)
returns table (
  id uuid,
  campus_id uuid,
  name text,
  short_name text,
  institution_type text,
  locality text,
  campus_name text,
  campus_locality text,
  group_name text,
  verified boolean,
  rank numeric
)
language sql stable security definer set search_path = ''
as $$
  with q as (select trim(coalesce(nullif(p_query, ''), '')) as raw, lower(trim(coalesce(nullif(p_query, ''), ''))) as term)
  select
    c.id,
    cam.id as campus_id,
    coalesce(c.official_name, c.name) as name,
    c.short_name,
    c.institution_type,
    coalesce(cam.locality, c.locality) as locality,
    cam.name as campus_name,
    cam.locality as campus_locality,
    g.name as group_name,
    (c.verification_status = 'verified')::boolean as verified,
    (
      case when q.term = '' and cam.locality = 'Hadapsar' then 6 else 0 end
      + case when q.term = lower(c.short_name) then 100 else 0 end
      + case when q.term = lower(coalesce(c.official_name, c.name)) then 100 else 0 end
      + case when q.term <> '' and lower(c.short_name) like q.term || '%' then 60 else 0 end
      + case when q.term <> '' and lower(coalesce(c.official_name, c.name)) like q.term || '%' then 55 else 0 end
      + case when q.term <> '' and exists (
            select 1 from unnest(c.aliases) a where lower(a) like q.term || '%') then 50 else 0 end
      + case when q.term <> '' and g.name is not null and lower(g.name) like q.term || '%' then 45 else 0 end
      + case when q.term <> '' and g.name is not null and position(q.term in lower(g.name)) > 0 then 35 else 0 end
      + case when q.term <> '' and lower(coalesce(c.official_name, c.name)) like '%' || q.term || '%' then 30 else 0 end
      + case when q.term <> '' and exists (
            select 1 from unnest(c.aliases) a where position(q.term in lower(a)) > 0) then 25 else 0 end
      + case when q.term <> '' and lower(coalesce(cam.locality, c.locality, '')) like q.term || '%' then 40 else 0 end
      + case when q.term <> '' and position(q.term in lower(coalesce(cam.locality, c.locality, ''))) > 0 then 20 else 0 end
    )::numeric as rank
  from q
  join public.colleges c on (
    c.verification_status = 'verified'
    or (q.term <> '' and public.is_admin() and c.verification_status = 'pending_review')
  )
  left join public.campuses cam on cam.id = c.campus_id
  left join public.institution_groups g on g.id = c.institution_group_id
  where q.term = ''
     or lower(c.short_name) like '%' || q.term || '%'
     or lower(coalesce(c.official_name, c.name)) like '%' || q.term || '%'
     or lower(c.name) like '%' || q.term || '%'
     or exists (select 1 from unnest(c.aliases) a where lower(a) like '%' || q.term || '%')
     or (g.name is not null and lower(g.name) like '%' || q.term || '%')
     or lower(coalesce(cam.locality, c.locality, '')) like '%' || q.term || '%'
  order by rank desc, lower(coalesce(c.official_name, c.name)) asc
  limit coalesce(greatest(p_limit, 1), 25);
$$;

revoke all on function public.search_institutions(text, int) from public;
grant execute on function public.search_institutions(text, int) to anon, authenticated;

-- ------------------------------------------------------------------ --
-- 11. list_departments: department choices for the signup wizard      --
--     (REST could read the table directly; the RPC keeps the client   --
--     contract one call and filters inactive rows server-side)        --
-- ------------------------------------------------------------------ --
create or replace function public.list_departments(p_college uuid)
returns table (id uuid, name text, abbreviation text)
language sql stable security definer set search_path = ''
as $$
  select d.id, d.name, d.abbreviation
  from public.departments d
  where d.college_id = p_college
    and d.status = 'active'
  order by d.name;
$$;

revoke all on function public.list_departments(uuid) from public;
grant execute on function public.list_departments(uuid) to anon, authenticated;

-- ------------------------------------------------------------------ --
-- 12. list_programs: course/program choices for the signup wizard     --
-- ------------------------------------------------------------------ --
create or replace function public.list_programs(p_college uuid)
returns table (id uuid, name text, level text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.name, p.level
  from public.academic_programs p
  where p.college_id = p_college
    and p.status = 'active'
  order by
    case p.level when 'diploma' then 1 when 'undergraduate' then 2
                 when 'postgraduate' then 3 when 'doctoral' then 4 else 5 end,
    p.name;
$$;

revoke all on function public.list_programs(uuid) from public;
grant execute on function public.list_programs(uuid) to anon, authenticated;

-- ------------------------------------------------------------------ --
-- 13. request_college_suggestion: richer missing-college requests     --
--     (0057 fields; the RPC stays compatible - new params optional).  --
-- ------------------------------------------------------------------ --
create or replace function public.request_college_suggestion(
  p_name text,
  p_city text default '',
  p_locality text default null,
  p_website text default null,
  p_type text default null
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_recent integer;
  clean_name text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to suggest a college.';
  end if;

  clean_name := nullif(trim(p_name), '');
  if clean_name is null or char_length(clean_name) < 2 or char_length(clean_name) > 120 then
    raise exception 'Enter a college name between 2 and 120 characters.';
  end if;

  -- Already in the directory? Point the client at the existing record.
  if exists (
    select 1 from public.colleges
    where (lower(name) = lower(clean_name) or lower(coalesce(official_name, '')) = lower(clean_name))
      and (nullif(trim(p_city), '') is null or lower(city) = lower(trim(p_city)))
  ) then
    raise exception 'That college is already listed. Search for it instead.';
  end if;

  select count(*) into v_recent
  from public.college_suggestions
  where user_id = auth.uid()
    and created_at > now() - interval '24 hours';

  if v_recent >= 5 then
    raise exception 'You have reached today''s college suggestion limit.';
  end if;

  insert into public.college_suggestions (user_id, name, city, locality, official_website, institution_type)
  values (
    auth.uid(), clean_name,
    nullif(trim(coalesce(p_city, '')), ''),
    nullif(trim(coalesce(p_locality, '')), ''),
    nullif(trim(coalesce(p_website, '')), ''),
    nullif(trim(coalesce(p_type, '')), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.request_college_suggestion(text, text, text, text, text) from public, anon;
grant execute on function public.request_college_suggestion(text, text, text, text, text) to authenticated;
