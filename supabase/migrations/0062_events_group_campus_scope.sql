-- 0062 - EVENTS: INSTITUTION-GROUP AND SHARED-CAMPUS AUDIENCE SCOPES
--
-- APPLY ORDER: 0057 -> 0058 -> 0059 -> 0060 -> 0061 -> 0062.
--
-- Phase 7.6 required four visibility scopes for events. Three existed
-- ('public', 'college', 'community'); a group-wide fest at one JSPM college and
-- a shared-campus event could not be expressed at all. This adds:
--
--   'group'  - every student whose college belongs to the SAME institution
--              group (derived from colleges.institution_group_id, never stored
--              on the event as a second source of truth)
--   'campus' - every student whose college operates on the SAME physical
--              campus (colleges.campus_id + institution_campuses, compared as
--              sets, so an institution with two campuses reaches both)
--
-- Nothing else changes: existing rows keep their audience, existing RPC
-- signatures and the list_events() return shape are untouched, and no column
-- is dropped. The audience set is a CHECK constraint widening (backwards
-- compatible: old values stay valid).
--
-- ONE semantic correction, called out because it changes a filter's meaning:
-- list_events(p_scope = 'college') used to mean "has any college_id"; it now
-- means audience = 'college', so group/campus events no longer appear under
-- the college filter (they have their own). p_scope = 'group' / 'campus' are
-- new. 'global' and 'community' behave exactly as before.
--
-- Guard rails:
--   * a group/campus event must belong to a college, and that college must
--     actually HAVE a group / a verified campus - otherwise it is refused with
--     a sentence, not silently downgraded;
--   * registration eligibility is forced to 'everyone' for the two new
--     scopes: visibility already scopes the audience, and the eligibility
--     enum has no group/campus member by design (0018);
--   * visibility is enforced twice - by RLS on direct reads AND inside
--     list_events(), which is SECURITY DEFINER.

-- ---------------------------------------------------------------------------
-- 1. helpers: derived relationships, no duplicated state
-- ---------------------------------------------------------------------------

-- The institution group a college belongs to, or NULL.
create or replace function public.college_group_id(p_college uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select institution_group_id from public.colleges where id = p_college;
$$;

revoke all on function public.college_group_id(uuid) from public;
grant execute on function public.college_group_id(uuid) to anon, authenticated;

-- Every campus a college operates on: its primary campus plus any additional
-- institution_campuses rows. NULLs are dropped by the caller.
create or replace function public.college_campus_ids(p_college uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct cid), '{}'::uuid[])
  from (
    select campus_id as cid from public.colleges
    where id = p_college and campus_id is not null
    union
    select campus_id as cid from public.institution_campuses
    where institution_id = p_college and campus_id is not null
  ) c;
$$;

revoke all on function public.college_campus_ids(uuid) from public;
grant execute on function public.college_campus_ids(uuid) to anon, authenticated;

-- Do two colleges belong to the same institution group?
create or replace function public.shares_institution_group(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_a is not null and p_a = p_b
     or (public.college_group_id(p_a) is not null
         and public.college_group_id(p_a) = public.college_group_id(p_b));
$$;

revoke all on function public.shares_institution_group(uuid, uuid) from public;
grant execute on function public.shares_institution_group(uuid, uuid) to anon, authenticated;

-- Do two colleges share at least one physical campus?
create or replace function public.colleges_share_campus(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_a is not null and (
      p_a = p_b
      or exists (
        select 1
        from unnest(public.college_campus_ids(p_a)) as a(campus_id)
        join unnest(public.college_campus_ids(p_b)) as b(campus_id)
          on b.campus_id = a.campus_id
      )
    );
$$;

revoke all on function public.colleges_share_campus(uuid, uuid) from public;
grant execute on function public.colleges_share_campus(uuid, uuid) to anon, authenticated;

create index if not exists colleges_group_idx on public.colleges (institution_group_id);
create index if not exists institution_campuses_campus_idx
  on public.institution_campuses (campus_id);

-- ---------------------------------------------------------------------------
-- 2. widen the audience + coherence constraints
-- ---------------------------------------------------------------------------
alter table public.events drop constraint if exists events_audience_check;
alter table public.events add constraint events_audience_check
  check (audience = any (array['public', 'college', 'community', 'group', 'campus']));

alter table public.events drop constraint if exists events_scope_check;
alter table public.events add constraint events_scope_check
  check (
    (audience <> 'college' or college_id is not null)
    and (audience not in ('college', 'group', 'campus') or college_id is not null)
    and (reg_eligibility <> 'college' or college_id is not null)
    and (audience <> 'community' or club_id is not null)
    and (reg_eligibility <> 'community' or club_id is not null)
    and (reg_deadline is null or starts_at is null or reg_deadline <= starts_at)
  );

-- ---------------------------------------------------------------------------
-- 3. write-time guard (covers create_event, update_event and any direct write)
-- ---------------------------------------------------------------------------
create or replace function public.events_scope_coherence()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_group    uuid;
  v_campuses uuid[];
begin
  if new.audience = 'group' then
    if new.college_id is null then
      raise exception 'A group event has to belong to one of your colleges.';
    end if;
    select institution_group_id into v_group from public.colleges where id = new.college_id;
    if v_group is null then
      raise exception 'That college is not part of an institution group, so it cannot post a group-wide event.';
    end if;
  elsif new.audience = 'campus' then
    if new.college_id is null then
      raise exception 'A campus event has to belong to one of your colleges.';
    end if;
    v_campuses := public.college_campus_ids(new.college_id);
    if coalesce(array_length(v_campuses, 1), 0) = 0 then
      raise exception 'That college has no verified campus, so it cannot post a campus-wide event.';
    end if;
  end if;

  -- visibility already scopes these two; the eligibility enum has no
  -- group/campus member, so registration stays open to whoever can see it
  if new.audience in ('group', 'campus') then
    new.reg_eligibility := 'everyone';
  end if;

  return new;
end;
$$;

revoke all on function public.events_scope_coherence() from public;

drop trigger if exists events_scope_coherence_trg on public.events;
create trigger events_scope_coherence_trg
  before insert or update of audience, college_id, reg_eligibility on public.events
  for each row execute function public.events_scope_coherence();

-- ---------------------------------------------------------------------------
-- 4. assert_event_payload(): accept the two new audiences
-- ---------------------------------------------------------------------------
create or replace function public.assert_event_payload(
  p_title text, p_summary text, p_category text, p_tags text[],
  p_format text, p_venue text, p_online_url text, p_timezone text,
  p_starts_at timestamptz, p_ends_at timestamptz,
  p_audience text, p_reg_eligibility text, p_reg_type text,
  p_capacity integer, p_reg_opens_at timestamptz, p_reg_deadline timestamptz
)
returns text[]
language plpgsql stable security definer set search_path = public as $$
declare
  v_tags text[];
begin
  if p_title is null or length(btrim(p_title)) < 3 then
    raise exception 'Give the event a title.';
  end if;
  if p_summary is not null and length(btrim(p_summary)) > 280 then
    raise exception 'Keep the summary under 280 characters.';
  end if;
  if p_category is null or btrim(p_category) = '' then
    raise exception 'Pick a category.';
  end if;
  if not (p_category = any (array[
    'College Festivals', 'Hackathons', 'Workshops', 'Technical Events',
    'Seminars and Webinars', 'Placements and Career Fairs', 'Cultural Events',
    'Sports', 'Clubs and Societies', 'Competitions', 'Networking', 'Other'])) then
    raise exception 'Unknown category.';
  end if;
  if p_tags is not null then
    select coalesce(array_agg(distinct lower(btrim(t))), '{}') into v_tags
    from unnest(p_tags) t
    where btrim(t) <> '';
    if array_length(v_tags, 1) > 8 then
      raise exception 'Use up to 8 tags.';
    end if;
  else
    v_tags := '{}';
  end if;
  if p_format is null or not (p_format = any (array['offline', 'online', 'hybrid'])) then
    raise exception 'Choose how the event happens: in person, online or hybrid.';
  end if;
  if p_audience is null
     or not (p_audience = any (array['public', 'college', 'community', 'group', 'campus'])) then
    raise exception 'Unknown audience.';
  end if;
  if p_reg_eligibility is null
     or not (p_reg_eligibility = any (array['everyone', 'college', 'community'])) then
    raise exception 'Unknown registration eligibility.';
  end if;
  if p_reg_type is null or not (p_reg_type = any (array['rsvp', 'registration'])) then
    raise exception 'Unknown registration type.';
  end if;
  -- audience="community" always implies community-scoped registration
  if p_audience = 'community' then
    p_reg_eligibility := 'community';
  end if;
  if p_starts_at is null then
    raise exception 'Pick a start time.';
  end if;
  if p_ends_at is not null and p_ends_at <= p_starts_at then
    raise exception 'The end time must come after the start.';
  end if;
  if p_timezone is not null and btrim(p_timezone) = '' then
    raise exception 'Pick a timezone or leave it blank for Asia/Kolkata.';
  end if;
  if p_capacity is not null and p_capacity < 1 then
    raise exception 'Capacity has to be at least 1.';
  end if;
  if p_reg_opens_at is not null and p_starts_at is not null and p_reg_opens_at >= p_starts_at then
    raise exception 'Registration has to open before the event starts.';
  end if;
  if p_reg_deadline is not null and p_starts_at is not null and p_reg_deadline > p_starts_at then
    raise exception 'The registration deadline cannot be after the start time.';
  end if;
  return v_tags;
end;
$$;

revoke all on function public.assert_event_payload(text, text, text, text[], text, text, text, text, timestamptz, timestamptz, text, text, text, integer, timestamptz, timestamptz) from public;

-- ---------------------------------------------------------------------------
-- 5. read visibility (RLS) - direct table reads
-- ---------------------------------------------------------------------------
drop policy if exists "events visible per audience" on public.events;
create policy "events visible per audience" on public.events
  for select
  using (
    created_by = auth.uid()
    or exists (
      select 1 from public.event_rsvps r
      where r.event_id = events.id and r.user_id = auth.uid()
        and r.status = any (array['registered', 'waitlisted', 'going', 'interested'])
    )
    or (
      published
      and (
        audience = 'public'
        or (
          auth.uid() is not null
          and (
            (audience = 'college'
             and college_id = (select p.college_id from public.profiles p where p.id = auth.uid()))
            or (audience = 'community'
                and club_id is not null
                and public.is_club_active_member(club_id, auth.uid()))
            or (audience = 'group'
                and college_id is not null
                and public.shares_institution_group(
                      college_id,
                      (select p.college_id from public.profiles p where p.id = auth.uid())))
            or (audience = 'campus'
                and college_id is not null
                and public.colleges_share_campus(
                      college_id,
                      (select p.college_id from public.profiles p where p.id = auth.uid())))
          )
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 6. list_events(): same signature, same return shape, two more scopes
-- ---------------------------------------------------------------------------
create or replace function public.list_events(
  p_mode text default 'discover',
  p_query text default null,
  p_category text default null,
  p_format text default null,
  p_scope text default null,
  p_month text default null,
  p_sort text default null,
  p_limit integer default 24,
  p_offset integer default 0
)
returns table (
  id uuid,
  slug text,
  title text,
  summary text,
  category text,
  tags text[],
  cover_url text,
  format text,
  venue text,
  venue_address text,
  city text,
  map_url text,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone_name text,
  audience text,
  reg_eligibility text,
  reg_type text,
  reg_opens_at timestamptz,
  reg_deadline timestamptz,
  registration_url text,
  capacity integer,
  seats_taken integer,
  going_count integer,
  interested_count integer,
  featured boolean,
  published boolean,
  cancelled_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  college_id uuid,
  college_name text,
  college_short_name text,
  club_id uuid,
  club_name text,
  club_slug text,
  organizer_id uuid,
  organizer_name text,
  organizer_username text,
  my_status text,
  saved boolean,
  can_manage boolean
)
language sql stable security definer set search_path = public as $$
  with whoami as (
    select w.uid as me_id, p.college_id as my_college
    from (select auth.uid() as uid) w
    left join public.profiles p on p.id = w.uid
  ),
  q as (
    select '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' as term
    from (select nullif(btrim(coalesce(p_query, '')), '') as t) x
  ),
  scoped as (
    select e.*, w.me_id, w.my_college
    from public.events e
    cross join whoami w
    where (
      e.created_by = w.me_id
      or exists (
        select 1 from public.event_rsvps r
        where r.event_id = e.id and r.user_id = w.me_id
          and r.status = any (array['registered', 'waitlisted', 'going', 'interested'])
      )
      or (
        e.published
        and (
          e.audience = 'public'
          or (
            w.me_id is not null
            and (
              (e.audience = 'college' and e.college_id = w.my_college)
              or (e.audience = 'community' and e.club_id is not null
                  and public.is_club_active_member(e.club_id, w.me_id))
              or (e.audience = 'group' and e.college_id is not null
                  and public.shares_institution_group(e.college_id, w.my_college))
              or (e.audience = 'campus' and e.college_id is not null
                  and public.colleges_share_campus(e.college_id, w.my_college))
            )
          )
        )
      )
    )
    and (
      (p_mode = 'organized' and e.created_by = w.me_id)
      or (p_mode = 'registered' and exists (
          select 1 from public.event_rsvps r2
          where r2.event_id = e.id and r2.user_id = w.me_id
            and r2.status = any (array['registered', 'waitlisted', 'going', 'interested'])))
      or (p_mode = 'saved' and exists (
          select 1 from public.saved_events s
          where s.event_id = e.id and s.user_id = w.me_id))
      or (p_mode = 'mycollege' and e.published and e.college_id = w.my_college)
      or (p_mode = 'following' and e.published and e.club_id is not null and exists (
          select 1 from public.club_members cm
          where cm.club_id = e.club_id and cm.user_id = w.me_id and cm.status = 'active'))
      or (p_mode in ('discover', 'foryou', 'upcoming') and e.published
          and coalesce(e.ends_at, e.starts_at) >= now())
      or (p_mode = 'past' and e.published and coalesce(e.ends_at, e.starts_at) < now())
    )
    and (e.cancelled_at is null or p_mode in ('organized', 'registered', 'saved', 'past'))
  )
  select
    s.id, s.slug, s.title, s.summary, s.category, s.tags, s.cover_url, s.format,
    s.venue, s.venue_address, s.city, s.map_url, s.starts_at, s.ends_at,
    s.timezone as timezone_name, s.audience, s.reg_eligibility, s.reg_type,
    s.reg_opens_at, s.reg_deadline, s.registration_url, s.capacity,
    (select count(*) from public.event_rsvps r where r.event_id = s.id and r.status = 'registered')::int,
    (select count(*) from public.event_rsvps r where r.event_id = s.id and r.status = 'going')::int,
    (select count(*) from public.event_rsvps r where r.event_id = s.id and r.status = 'interested')::int,
    s.featured, s.published, s.cancelled_at, s.created_at, s.updated_at,
    s.college_id, cg.name, cg.short_name, s.club_id, cb.name, cb.slug,
    s.created_by, op.display_name, op.username,
    (select r.status from public.event_rsvps r where r.event_id = s.id and r.user_id = s.me_id limit 1),
    exists (select 1 from public.saved_events sv where sv.event_id = s.id and sv.user_id = s.me_id),
    (s.created_by = s.me_id
     or (s.club_id is not null and public.is_club_moderator(s.club_id, s.me_id))
    )
  from scoped s
  cross join q
  left join public.colleges cg on cg.id = s.college_id
  left join public.clubs cb on cb.id = s.club_id
  left join public.profiles op on op.id = s.created_by
  where (
    q.term is null
    or s.title ilike q.term
    or s.summary ilike q.term
    or (s.description is not null and s.description ilike q.term)
    or s.city ilike q.term
    or s.venue ilike q.term
    or cg.name ilike q.term
    or cg.short_name ilike q.term
    or cb.name ilike q.term
    or op.display_name ilike q.term
    or exists (select 1 from unnest(s.tags) tg where tg ilike q.term)
  )
  and (p_category is null or btrim(p_category) in ('', 'All') or s.category = btrim(p_category))
  and (p_format is null or btrim(p_format) in ('', 'any') or s.format = btrim(p_format))
  and (
    p_scope is null or btrim(coalesce(p_scope, '')) in ('', 'any')
    or (btrim(p_scope) = 'global' and s.club_id is null and s.college_id is null)
    or (btrim(p_scope) = 'college' and s.audience = 'college')
    or (btrim(p_scope) = 'community' and s.club_id is not null)
    or (btrim(p_scope) = 'group' and s.audience = 'group')
    or (btrim(p_scope) = 'campus' and s.audience = 'campus')
  )
  and (
    p_month is null or btrim(p_month) = ''
    or (
      s.starts_at < to_date(btrim(p_month), 'YYYY-MM') + interval '1 month'
      and coalesce(s.ends_at, s.starts_at + interval '1 second') >= to_date(btrim(p_month), 'YYYY-MM')
    )
  )
  order by
    (case when p_mode in ('discover', 'foryou')
              and coalesce(btrim(coalesce(p_sort, 'recommended')), 'recommended') = 'recommended'
          then (case
                  when (s.my_college is not null and s.college_id = s.my_college)
                       or (s.club_id is not null and exists (
                             select 1 from public.club_members cm2
                             where cm2.club_id = s.club_id
                               and cm2.user_id = s.me_id and cm2.status = 'active'))
                  then 1 else 0 end)
          else 0 end) desc,
    (case
      when (coalesce(btrim(coalesce(p_sort, '')), '') = 'new'
            and p_mode not in ('registered', 'saved')) or p_mode = 'organized'
        then 2000000000 - extract(epoch from coalesce(s.updated_at, s.created_at))
      when p_mode = 'past'
        then -extract(epoch from s.starts_at)
      when p_mode = 'registered'
        then (case when coalesce(s.ends_at, s.starts_at) >= now()
                   then extract(epoch from s.starts_at)
                   else 2000000000 - extract(epoch from s.starts_at) end)
      else (case when coalesce(s.ends_at, s.starts_at) >= now()
                 then extract(epoch from s.starts_at)
                 else -extract(epoch from s.starts_at) end)
    end),
    s.id
  limit least(greatest(coalesce(p_limit, 24), 1), 60)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.list_events(text, text, text, text, text, text, text, integer, integer) from public;
grant execute on function public.list_events(text, text, text, text, text, text, text, integer, integer) to anon, authenticated;