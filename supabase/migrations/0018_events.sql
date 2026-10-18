/* =====================================================================
   0018_events.sql — CAMPUS Events (global + college + community events)
   ---------------------------------------------------------------------
   Reuses the legacy events / event_rsvps tables (no parallel systems).
   Adds: slugs, categories, tags, audience/eligibility scopes, formats,
   registration windows, capacity + waitlist, drafts/publishing,
   saved_events, event reporting, attendance, and the discovery/registration
   RPC layer used by the Events page.

   Everything here is additive and idempotent — safe to re-run from any
   partial state. Existing community events keep working (list_club_events
   is a security-definer RPC and does not depend on these policies).
   ===================================================================== */

/* ------------------------------------------------------------------ */
/* 1. Extend events                                                    */
/* ------------------------------------------------------------------ */

alter table public.events
  add column if not exists slug text,
  add column if not exists summary text,
  add column if not exists tags text[] not null default '{}',
  add column if not exists category text not null default 'Other',
  /* visibility: public | college | community */
  add column if not exists audience text not null default 'community',
  /* registration eligibility (independent of visibility): everyone | college | community */
  add column if not exists reg_eligibility text not null default 'everyone',
  /* rsvp (going/interested) | registration (seat + capacity + waitlist) */
  add column if not exists reg_type text not null default 'rsvp',
  /* offline | online | hybrid */
  add column if not exists format text not null default 'offline',
  /* venue name lives in the legacy `venue` column; details are new */
  add column if not exists venue_address text,
  add column if not exists city text,
  add column if not exists map_url text,
  /* restricted fields: revealed to registered attendees + organizers only */
  add column if not exists online_url text,
  add column if not exists access_notes text,
  /* IANA time zone of the event schedule */
  add column if not exists timezone text,
  add column if not exists reg_opens_at timestamptz,
  add column if not exists reg_deadline timestamptz,
  /* drafts are invisible outside the organizer; legacy rows stay live */
  add column if not exists published boolean not null default true,
  add column if not exists published_at timestamptz,
  add column if not exists featured boolean not null default false,
  /* registration rows become "waitlisted" automatically when full */
  add column if not exists waitlist boolean not null default true;

/* Backfill slugs for pre-existing events (needed for #e/<slug> links). */
update public.events
set slug = left(regexp_replace(lower(btrim(coalesce(title, 'event'))), '[^a-z0-9]+', '-', 'g'), 60)
           || '-' || substr(md5(id::text || clock_timestamp()::text), 1, 6)
where slug is null;

alter table public.events drop constraint if exists events_slug_unique;
alter table public.events add constraint events_slug_unique unique (slug);

alter table public.events drop constraint if exists events_category_check;
alter table public.events add constraint events_category_check
  check (category = any (array[
    'College Festivals', 'Hackathons', 'Workshops', 'Technical Events',
    'Seminars and Webinars', 'Placements and Career Fairs', 'Cultural Events',
    'Sports', 'Clubs and Societies', 'Competitions', 'Networking', 'Other']));

alter table public.events drop constraint if exists events_audience_check;
alter table public.events add constraint events_audience_check
  check (audience = any (array['public', 'college', 'community']));

alter table public.events drop constraint if exists events_reg_eligibility_check;
alter table public.events add constraint events_reg_eligibility_check
  check (reg_eligibility = any (array['everyone', 'college', 'community']));

alter table public.events drop constraint if exists events_reg_type_check;
alter table public.events add constraint events_reg_type_check
  check (reg_type = any (array['rsvp', 'registration']));

alter table public.events drop constraint if exists events_format_check;
alter table public.events add constraint events_format_check
  check (format = any (array['offline', 'online', 'hybrid']));

/* column coherence for scoped events and registration windows */
alter table public.events drop constraint if exists events_scope_check;
alter table public.events add constraint events_scope_check
  check (
    (audience <> 'college' or college_id is not null)
    and (reg_eligibility <> 'college' or college_id is not null)
    and (audience <> 'community' or club_id is not null)
    and (reg_eligibility <> 'community' or club_id is not null)
    and (reg_deadline is null or starts_at is null or reg_deadline <= starts_at)
  );

/* ------------------------------------------------------------------ */
/* 2. Extend event_rsvps — one registration system, more statuses      */
/* ------------------------------------------------------------------ */

/* Drop any legacy CHECK on the status column (name unknown by design),
   then re-add the definitive constraint. */
do $$
declare r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.event_rsvps'::regclass
      and con.contype = 'c'
      and att.attname = 'status'
  loop
    execute format('alter table public.event_rsvps drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.event_rsvps add constraint event_rsvps_status_check
  check (status = any (array[
    'going', 'interested', 'not_going',            -- rsvp mode
    'registered', 'waitlisted', 'cancelled']));    -- registration mode

/* attendance is separate from registration status */
alter table public.event_rsvps
  add column if not exists attendance_status text;

alter table public.event_rsvps drop constraint if exists event_rsvps_attendance_check;
alter table public.event_rsvps add constraint event_rsvps_attendance_check
  check (attendance_status is null or attendance_status = any (array['attended', 'no_show']));

create index if not exists event_rsvps_user_idx on public.event_rsvps (user_id, status);
create index if not exists event_rsvps_event_status_idx on public.event_rsvps (event_id, status);

/* ------------------------------------------------------------------ */
/* 3. Saved events (real, per-user)                                    */
/* ------------------------------------------------------------------ */

create table if not exists public.saved_events (
  event_id uuid not null references public.events (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists saved_events_user_idx
  on public.saved_events (user_id, created_at desc);

alter table public.saved_events enable row level security;

drop policy if exists "saved events are private to their owner" on public.saved_events;
create policy "saved events are private to their owner" on public.saved_events
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/* ------------------------------------------------------------------ */
/* 4. Reports gain events                                              */
/* ------------------------------------------------------------------ */

alter table public.reports add column if not exists event_id uuid;

alter table public.reports drop constraint if exists reports_event_fk;
alter table public.reports
  add constraint reports_event_fk
  foreign key (event_id) references public.events (id) on delete cascade;

alter table public.reports drop constraint if exists reports_check;
alter table public.reports add constraint reports_check
  check (post_id is not null or reported_user_id is not null
         or club_id is not null or event_id is not null);

create index if not exists reports_event_idx on public.reports (event_id);

/* ------------------------------------------------------------------ */
/* 5. Row-Level Security on events                                     */
/*    ALL existing policies are dropped first — a legacy policy let any */
/*    member insert/edit event rows directly (verified live). Policies  */
/*    are rebuilt from scratch below.                                   */
/* ------------------------------------------------------------------ */

do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'events'
  loop
    execute format('drop policy %I on public.events', r.policyname);
  end loop;
end $$;

alter table public.events enable row level security;

/* Read policy only. Every write goes through security-definer RPCs
   (create/update/publish/cancel/delete) — no write policies exist, so
   direct inserts/updates/deletes (including created_by spoofing) are denied. */
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
          )
        )
      )
    )
  );

/* Registered users keep seeing their event even if it is cancelled or
   unpublished; drafts stay visible only to their organizer. */

/* Direct row-deletion of RSVPs is closed: cancellation must flow through
   cancel_registration() so the waitlist is promoted atomically. */
drop policy if exists "owners withdraw their own rsvp" on public.event_rsvps;
drop policy if exists "rsvps readable by their owner" on public.event_rsvps;
create policy "rsvps readable by their owner" on public.event_rsvps
  for select using (user_id = auth.uid());

/* ------------------------------------------------------------------ */
/* 6. Internal helpers                                                 */
/* ------------------------------------------------------------------ */

-- Can this user manage (edit/publish/cancel) the event?
create or replace function public.can_manage_event(p_event uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select e.created_by = p_user
     or (e.club_id is not null and public.is_club_moderator(e.club_id, p_user))
  from public.events e
  where e.id = p_event
$$;

revoke all on function public.can_manage_event(uuid, uuid) from public;

-- Validate + normalize the shared event payload. Returns normalized tags.
create or replace function public.assert_event_payload(
  p_title text,
  p_summary text,
  p_category text,
  p_tags text[],
  p_format text,
  p_venue text,
  p_online_url text,
  p_timezone text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_audience text,
  p_reg_eligibility text,
  p_reg_type text,
  p_capacity integer,
  p_reg_opens_at timestamptz,
  p_reg_deadline timestamptz
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
  if p_audience is null or not (p_audience = any (array['public', 'college', 'community'])) then
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
  if p_timezone is not null then
    if not exists (select 1 from pg_timezone_names where name = p_timezone) then
      raise exception 'Unknown time zone.';
    end if;
  else
    p_timezone := 'Asia/Kolkata';
  end if;
  if p_format <> 'online' and (p_venue is null or btrim(p_venue) = '') then
    raise exception 'Add a venue for an in-person event.';
  end if;
  if p_format <> 'offline' and (p_online_url is null or btrim(p_online_url) = '') then
    raise exception 'Add a meeting or streaming link for online access.';
  end if;
  if p_capacity is not null and p_capacity <= 0 then
    raise exception 'Capacity must be a positive number.';
  end if;
  if p_reg_opens_at is not null and p_reg_deadline is not null
     and p_reg_opens_at > p_reg_deadline then
    raise exception 'Registration cannot open after its deadline.';
  end if;
  if p_reg_deadline is not null and p_reg_deadline > p_starts_at then
    raise exception 'The registration deadline must fall before the event starts.';
  end if;
  return v_tags;
end $$;

revoke all on function public.assert_event_payload(text, text, text, text[], text, text, text, text, timestamptz, timestamptz, text, text, text, integer, timestamptz, timestamptz) from public;

/* ------------------------------------------------------------------ */
/* 7. Event lifecycle RPCs                                             */
/* ------------------------------------------------------------------ */

-- Authorized creation: community events need owner/moderator; standalone
-- college events need a matching declared college; global events are open
-- to any signed-in student. The organizer is always taken from auth.uid().
create or replace function public.create_event(
  p_title text,
  p_summary text default null,
  p_description text default null,
  p_category text default 'Other',
  p_tags text[] default '{}',
  p_cover_url text default null,
  p_college uuid default null,
  p_club uuid default null,
  p_audience text default 'public',
  p_reg_eligibility text default 'everyone',
  p_reg_type text default 'registration',
  p_format text default 'offline',
  p_venue text default null,
  p_venue_address text default null,
  p_city text default null,
  p_map_url text default null,
  p_online_url text default null,
  p_access_notes text default null,
  p_timezone text default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_capacity integer default null,
  p_reg_opens_at timestamptz default null,
  p_reg_deadline timestamptz default null,
  p_registration_url text default null,
  p_featured boolean default false,
  p_publish boolean default true
)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
  v_tags text[];
  v_base text;
  v_slug text;
  v_my_college uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to create events.';
  end if;

  v_tags := public.assert_event_payload(
    p_title, p_summary, p_category, p_tags,
    p_format, p_venue, p_online_url, p_timezone,
    p_starts_at, p_ends_at, p_audience, p_reg_eligibility, p_reg_type,
    p_capacity, p_reg_opens_at, p_reg_deadline);

  select college_id into v_my_college
  from public.profiles where id = auth.uid();

  if p_club is not null then
    if not public.is_club_moderator(p_club, auth.uid()) then
      raise exception 'Only owners and moderators of the chosen community can create its events.';
    end if;
  elsif p_college is not null then
    if v_my_college is null or v_my_college <> p_college then
      raise exception 'You can only create events for your declared college.';
    end if;
  end if;

  v_base := left(regexp_replace(lower(btrim(p_title)), '[^a-z0-9]+', '-', 'g'), 60);
  v_base := btrim(v_base, '-');
  if v_base = '' then
    v_base := 'event';
  end if;
  loop
    v_slug := v_base || '-' || substr(md5(v_base || clock_timestamp()::text || random()::text), 1, 6);
    exit when not exists (select 1 from public.events e where e.slug = v_slug);
  end loop;

  insert into public.events (
    slug, title, summary, description, category, tags, cover_url,
    college_id, club_id, created_by, audience, reg_eligibility, reg_type,
    format, venue, venue_address, city, map_url, online_url, access_notes,
    timezone, starts_at, ends_at, registration_url, capacity,
    reg_opens_at, reg_deadline, published, published_at, featured
  ) values (
    v_slug, btrim(p_title), nullif(btrim(coalesce(p_summary, '')), ''),
    nullif(btrim(coalesce(p_description, '')), ''),
    p_category, v_tags, nullif(btrim(coalesce(p_cover_url, '')), ''),
    p_college, p_club, auth.uid(),
    p_audience,
    case when p_audience = 'community' then 'community' else p_reg_eligibility end,
    p_reg_type,
    p_format, nullif(btrim(coalesce(p_venue, '')), ''),
    nullif(btrim(coalesce(p_venue_address, '')), ''),
    nullif(btrim(coalesce(p_city, '')), ''),
    nullif(btrim(coalesce(p_map_url, '')), ''),
    nullif(btrim(coalesce(p_online_url, '')), ''),
    nullif(btrim(coalesce(p_access_notes, '')), ''),
    coalesce(p_timezone, 'Asia/Kolkata'),
    p_starts_at, p_ends_at,
    nullif(btrim(coalesce(p_registration_url, '')), ''),
    p_capacity, p_reg_opens_at, p_reg_deadline,
    p_publish, case when p_publish then now() end,
    p_publish and p_featured
  ) returning id into v_id;

  /* the Events page routes by slug (#e/<slug>), so hand that back */
  return v_slug;
end $$;

revoke all on function public.create_event(text, text, text, text, text[], text, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, timestamptz, timestamptz, integer, timestamptz, timestamptz, text, boolean, boolean) from public;
grant execute on function public.create_event(text, text, text, text, text[], text, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, timestamptz, timestamptz, integer, timestamptz, timestamptz, text, boolean, boolean) to authenticated;

-- Organizer or community owner/moderator edits. Cancelled events freeze;
-- mode switching is refused once anyone has responded.
create or replace function public.update_event(
  p_event uuid,
  p_title text,
  p_summary text default null,
  p_description text default null,
  p_category text default 'Other',
  p_tags text[] default null,
  p_cover_url text default null,
  p_college uuid default null,
  p_club uuid default null,
  p_audience text default 'public',
  p_reg_eligibility text default 'everyone',
  p_reg_type text default 'registration',
  p_format text default 'offline',
  p_venue text default null,
  p_venue_address text default null,
  p_city text default null,
  p_map_url text default null,
  p_online_url text default null,
  p_access_notes text default null,
  p_timezone text default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_capacity integer default null,
  p_reg_opens_at timestamptz default null,
  p_reg_deadline timestamptz default null,
  p_registration_url text default null,
  p_featured boolean default false
)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_row public.events;
  v_tags text[];
  v_seats integer;
  v_my_college uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to manage events.';
  end if;

  select * into v_row from public.events where id = p_event;
  if v_row is null then
    raise exception 'That event does not exist.';
  end if;
  if not (v_row.created_by = auth.uid()
     or (v_row.club_id is not null and public.is_club_moderator(v_row.club_id, auth.uid()))) then
    raise exception 'Only organizers and community moderators can edit an event.';
  end if;
  if v_row.cancelled_at is not null then
    raise exception 'Cancelled events cannot be edited.';
  end if;

  v_tags := public.assert_event_payload(
    p_title, p_summary, p_category, coalesce(p_tags, v_row.tags),
    p_format, p_venue, p_online_url, p_timezone,
    p_starts_at, p_ends_at, p_audience, p_reg_eligibility, p_reg_type,
    p_capacity, p_reg_opens_at, p_reg_deadline);

  select college_id into v_my_college from public.profiles where id = auth.uid();

  /* community attach/detach authorization */
  if p_club is distinct from v_row.club_id then
    if p_club is not null and not public.is_club_moderator(p_club, auth.uid()) then
      raise exception 'Only owners and moderators of the chosen community can attach its events.';
    end if;
    if p_club is null and v_row.created_by <> auth.uid() then
      raise exception 'Only the original organizer can detach the community.';
    end if;
  end if;

  /* college changes follow the declared-college rule */
  if p_college is distinct from v_row.college_id then
    if not (v_row.created_by = auth.uid() and p_club is null) then
      if v_my_college is null or v_my_college <> p_college then
        raise exception 'You can only publish events for your declared college.';
      end if;
    end if;
  end if;

  /* refuse switching registration modes once responses exist */
  if p_reg_type is distinct from v_row.reg_type then
    if exists (
      select 1 from public.event_rsvps r
      where r.event_id = v_row.id and r.status <> 'cancelled'
    ) then
      raise exception 'Responses already exist — registration mode cannot be switched.';
    end if;
  end if;

  /* never shrink capacity below the current occupancy */
  if p_capacity is not null then
    select count(*) into v_seats
    from public.event_rsvps r
    where r.event_id = v_row.id and r.status in ('registered', 'going');
    if v_seats > p_capacity then
      raise exception 'Registrations exceed the new capacity.';
    end if;
  end if;

  update public.events set
    title = btrim(p_title),
    summary = nullif(btrim(coalesce(p_summary, '')), ''),
    description = nullif(btrim(coalesce(p_description, '')), ''),
    category = p_category,
    tags = v_tags,
    cover_url = nullif(btrim(coalesce(p_cover_url, '')), ''),
    college_id = p_college,
    club_id = p_club,
    audience = p_audience,
    reg_eligibility = case when p_audience = 'community' then 'community' else p_reg_eligibility end,
    reg_type = p_reg_type,
    format = p_format,
    venue = nullif(btrim(coalesce(p_venue, '')), ''),
    venue_address = nullif(btrim(coalesce(p_venue_address, '')), ''),
    city = nullif(btrim(coalesce(p_city, '')), ''),
    map_url = nullif(btrim(coalesce(p_map_url, '')), ''),
    online_url = nullif(btrim(coalesce(p_online_url, '')), ''),
    access_notes = nullif(btrim(coalesce(p_access_notes, '')), ''),
    timezone = coalesce(p_timezone, 'Asia/Kolkata'),
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    registration_url = nullif(btrim(coalesce(p_registration_url, '')), ''),
    capacity = p_capacity,
    reg_opens_at = p_reg_opens_at,
    reg_deadline = p_reg_deadline,
    featured = p_featured
  where id = p_event;

  /* single deduped in-app notice for current attendees */
  if v_row.published then
    perform public.notify_member(r.user_id, auth.uid(), 'event_updated', 'event', v_row.id)
    from public.event_rsvps r
    where r.event_id = v_row.id
      and r.status = any (array['registered', 'waitlisted', 'going', 'interested']);
  end if;
end $$;

revoke all on function public.update_event(uuid, text, text, text, text, text[], text, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, timestamptz, timestamptz, integer, timestamptz, timestamptz, text, boolean) from public;
grant execute on function public.update_event(uuid, text, text, text, text, text[], text, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, timestamptz, timestamptz, integer, timestamptz, timestamptz, text, boolean) to authenticated;

-- publish / unpublish a draft (organizer or community owner/moderator)
create or replace function public.publish_event(p_event uuid, p_publish boolean default true)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_row public.events;
begin
  if auth.uid() is null then
    raise exception 'Sign in to manage events.';
  end if;
  select * into v_row from public.events where id = p_event;
  if v_row is null then
    raise exception 'That event does not exist.';
  end if;
  if not public.can_manage_event(p_event, auth.uid()) then
    raise exception 'Only organizers and community moderators can manage publishing.';
  end if;
  if p_publish then
    if v_row.cancelled_at is not null then
      raise exception 'Cancelled events cannot be republished.';
    end if;
    if v_row.published then
      raise exception 'This event is already published.';
    end if;
    update public.events
    set published = true, published_at = coalesce(published_at, now())
    where id = p_event;
  else
    update public.events set published = false where id = p_event;
  end if;
end $$;

revoke all on function public.publish_event(uuid, boolean) from public;
grant execute on function public.publish_event(uuid, boolean) to authenticated;

-- cancel: idempotent; notifies attendees via the dedupe helper
create or replace function public.cancel_event(p_event uuid)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_row public.events;
begin
  if auth.uid() is null then
    raise exception 'Sign in to manage events.';
  end if;
  select * into v_row from public.events where id = p_event;
  if v_row is null then
    raise exception 'That event does not exist.';
  end if;
  if not public.can_manage_event(p_event, auth.uid()) then
    raise exception 'Only organizers and community moderators can cancel an event.';
  end if;
  if v_row.cancelled_at is null then
    update public.events set cancelled_at = now() where id = p_event;
    perform public.notify_member(r.user_id, p_event::uuid, 'event_cancelled', 'event', p_event)
    from public.event_rsvps r
    where r.event_id = p_event
      and r.status = any (array['registered', 'waitlisted', 'going', 'interested']);
  end if;
end $$;

revoke all on function public.cancel_event(uuid) from public;
grant execute on function public.cancel_event(uuid) to authenticated;

-- delete: only when nobody holds a seat (cancel is the honest path then)
create or replace function public.delete_event(p_event uuid)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to manage events.';
  end if;
  if not public.can_manage_event(p_event, auth.uid()) then
    raise exception 'Only organizers and community moderators can delete an event.';
  end if;
  if exists (
    select 1 from public.event_rsvps r
    where r.event_id = p_event and r.status in ('registered', 'going', 'waitlisted')
  ) then
    raise exception 'Attendees have joined — cancel the event instead of deleting it.';
  end if;
  delete from public.events where id = p_event;
end $$;

revoke all on function public.delete_event(uuid) from public;
grant execute on function public.delete_event(uuid) to authenticated;

/* ------------------------------------------------------------------ */
/* 8. Registration RPCs                                                */
/* ------------------------------------------------------------------ */

-- One entry point for every attendee action.
--   registration events: status 'registered' (seat or waitlist)
--   rsvp events:         statuses 'going' | 'interested' | 'not_going'
create or replace function public.register_event(p_event uuid, p_status text default 'registered')
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ev record;
  v_current text;
  v_my_college uuid;
  v_seats integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in to join events.';
  end if;

  select id, published, cancelled_at, reg_type, reg_eligibility, club_id,
         college_id, reg_opens_at, reg_deadline, starts_at, capacity,
         waitlist, created_by
    into v_ev
  from public.events where id = p_event;

  if v_ev.id is null then
    raise exception 'That event does not exist.';
  end if;
  if not (p_status = any (array['registered', 'going', 'interested', 'not_going'])) then
    raise exception 'Unknown registration request.';
  end if;
  if v_ev.cancelled_at is not null then
    raise exception 'This event was cancelled.';
  end if;
  if not v_ev.published then
    raise exception 'This event is not open yet.';
  end if;

  select college_id into v_my_college from public.profiles where id = auth.uid();

  select r.status into v_current
  from public.event_rsvps r
  where r.event_id = p_event and r.user_id = auth.uid();

  if v_current = 'registered' and p_status = 'registered' then
    raise exception 'You are already registered for this event.';
  end if;
  if v_current = 'waitlisted' and p_status = 'registered' then
    raise exception 'You are already on the waitlist for this event.';
  end if;

  if p_status = 'not_going' then
    if v_ev.reg_type = 'registration' then
      raise exception 'Cancel your registration instead of un-RSVPing.';
    end if;
    if v_current is null then
      raise exception 'You have not responded to this event yet.';
    end if;
    insert into public.event_rsvps (event_id, user_id, status)
    values (p_event, auth.uid(), p_status)
    on conflict (event_id, user_id) do update set status = excluded.status;
    return p_status;
  end if;

  /* audience-based eligibility (independent of visibility) */
  if v_ev.reg_eligibility = 'college'
     and (v_ev.college_id is null or v_ev.college_id is distinct from v_my_college) then
    raise exception 'Registration is limited to students of the host college.';
  end if;
  if v_ev.reg_eligibility = 'community'
     and not public.is_club_active_member(v_ev.club_id, auth.uid()) then
    raise exception 'Registration is limited to members of the hosting community.';
  end if;

  if p_status = 'registered' then
    if v_ev.reg_type <> 'registration' then
      raise exception 'This event uses RSVP controls instead of registration.';
    end if;
    if v_ev.reg_opens_at is not null and v_ev.reg_opens_at > now() then
      raise exception 'Registration opens soon.';
    end if;
    if v_ev.reg_deadline is not null and v_ev.reg_deadline < now() then
      raise exception 'Registration is closed — the deadline has passed.';
    end if;
    if v_ev.starts_at < now() then
      raise exception 'Registration is closed — the event already started.';
    end if;

    if v_ev.capacity is not null then
      select count(*) into v_seats
      from public.event_rsvps r
      where r.event_id = p_event and r.status = 'registered'
        and r.user_id <> auth.uid();
      if v_seats >= v_ev.capacity then
        if not coalesce(v_ev.waitlist, true) then
          raise exception 'The event is full (% of % seats taken).', v_seats, v_ev.capacity;
        end if;
        insert into public.event_rsvps (event_id, user_id, status)
        values (p_event, auth.uid(), 'waitlisted')
        on conflict (event_id, user_id) do update
          set status = 'waitlisted', created_at = now();
        return 'waitlisted';
      end if;
    end if;

    insert into public.event_rsvps (event_id, user_id, status)
    values (p_event, auth.uid(), 'registered')
    on conflict (event_id, user_id) do update
      set status = 'registered', created_at = now();
    perform public.notify_member(v_ev.created_by, auth.uid(), 'event_registered', 'event', p_event);
    return 'registered';
  end if;

  /* rsvp statuses */
  if v_ev.reg_type = 'registration' then
    raise exception 'This event requires registration instead of RSVP.';
  end if;
  if p_status = 'going' and v_ev.capacity is not null then
    select count(*) into v_seats
    from public.event_rsvps r
    where r.event_id = p_event and r.status = 'going'
      and r.user_id <> auth.uid();
    if v_seats >= v_ev.capacity then
      raise exception 'The event is full (% of % seats taken).', v_seats, v_ev.capacity;
    end if;
  end if;

  insert into public.event_rsvps (event_id, user_id, status)
  values (p_event, auth.uid(), p_status)
  on conflict (event_id, user_id) do update
    set status = excluded.status, created_at = now();
  return p_status;
end $$;

revoke all on function public.register_event(uuid, text) from public;
grant execute on function public.register_event(uuid, text) to authenticated;

-- Cancel a registration (registration-type events only).
-- Frees the seat atomically and promotes the earliest waitlisted student.
create or replace function public.cancel_registration(p_event uuid)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ev record;
  v_row record;
  v_promoted uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  select id, starts_at, cancelled_at into v_ev from public.events where id = p_event;
  if v_ev.id is null then
    raise exception 'That event does not exist.';
  end if;

  select * into v_row
  from public.event_rsvps r
  where r.event_id = p_event and r.user_id = auth.uid();

  if v_row is null then
    raise exception 'You are not registered for this event.';
  end if;

  if v_row.status = 'cancelled' then
    raise exception 'You are not registered for this event.';
  end if;

  if v_row.status = 'waitlisted' then
    delete from public.event_rsvps
    where event_id = p_event and user_id = auth.uid() and status = 'waitlisted';
    return 'left_waitlist';
  end if;

  if v_row.status = 'registered' then
    if v_ev.starts_at < now() then
      raise exception 'The event already started — contact the organizer.';
    end if;
    delete from public.event_rsvps
    where event_id = p_event and user_id = auth.uid() and status = 'registered';

    select r.user_id into v_promoted
    from public.event_rsvps r
    where r.event_id = p_event and r.status = 'waitlisted'
    order by r.created_at asc
    limit 1
    for update;

    if v_promoted is not null then
      update public.event_rsvps
      set status = 'registered'
      where event_id = p_event and user_id = v_promoted and status = 'waitlisted';
      perform public.notify_member(v_promoted, auth.uid(), 'event_promoted', 'event', p_event);
      return 'promoted';
    end if;
    return 'cancelled';
  end if;

  raise exception 'This event uses RSVP controls — change your response there.';
end $$;

revoke all on function public.cancel_registration(uuid) from public;
grant execute on function public.cancel_registration(uuid) to authenticated;

-- Toggle the personal saved-events bookmark. Returns the new state.
create or replace function public.toggle_saved_event(p_event uuid, p_saved boolean)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to save events.';
  end if;
  if not exists (select 1 from public.events e where e.id = p_event) then
    raise exception 'That event does not exist.';
  end if;
  if p_saved then
    insert into public.saved_events (event_id, user_id)
    values (p_event, auth.uid())
    on conflict (event_id, user_id) do nothing;
    return true;
  end if;
  delete from public.saved_events
  where event_id = p_event and user_id = auth.uid();
  return false;
end $$;

revoke all on function public.toggle_saved_event(uuid, boolean) from public;
grant execute on function public.toggle_saved_event(uuid, boolean) to authenticated;

/* ------------------------------------------------------------------ */
/* 9. Event reporting                                                  */
/* ------------------------------------------------------------------ */

create or replace function public.report_event(p_event uuid, p_reason text, p_details text default '')
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ev record;
  v_my_college uuid;
  v_visible boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in to report a problem.';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Describe the problem in a few words.';
  end if;

  select e.id, e.audience, e.college_id, e.club_id, e.published, e.created_by
    into v_ev
  from public.events e where e.id = p_event;
  if v_ev.id is null then
    raise exception 'That event is not available.';
  end if;

  select college_id into v_my_college from public.profiles where id = auth.uid();

  v_visible := v_ev.created_by = auth.uid()
    or exists (
      select 1 from public.event_rsvps r
      where r.event_id = p_event and r.user_id = auth.uid()
        and r.status = any (array['registered', 'waitlisted', 'going', 'interested'])
    )
    or (
      v_ev.published and (
        v_ev.audience = 'public'
        or (v_ev.audience = 'college' and v_ev.college_id = v_my_college)
        or (v_ev.audience = 'community'
            and public.is_club_active_member(v_ev.club_id, auth.uid()))
      )
    );
  if not v_visible then
    raise exception 'That event is not available.';
  end if;

  insert into public.reports (reporter_id, event_id, reason, details)
  values (auth.uid(), p_event, btrim(p_reason), nullif(btrim(coalesce(p_details, '')), ''));
end $$;

revoke all on function public.report_event(uuid, text, text) from public;
grant execute on function public.report_event(uuid, text, text) to authenticated;

create or replace function public.list_event_reports(p_event uuid)
returns table (
  id uuid,
  reason text,
  details text,
  status text,
  created_at timestamptz,
  reporter_name text
)
language sql stable security definer set search_path = public as $$
  select r.id, r.reason, r.details, r.status::text, r.created_at, pr.display_name
  from public.reports r
  left join public.profiles pr on pr.id = r.reporter_id
  where r.event_id = p_event
    and public.can_manage_event(p_event, auth.uid())
  order by r.created_at desc
  limit 100
$$;

revoke all on function public.list_event_reports(uuid) from public;
grant execute on function public.list_event_reports(uuid) to authenticated;

/* ------------------------------------------------------------------ */
/* 10. Discovery RPCs                                                  */
/* ------------------------------------------------------------------ */

-- The discovery workhorse. Every mode re-checks audience visibility inside
-- the security-definer body (the RLS policy is defence in depth).
--   p_mode    discover | foryou | mycollege | following | upcoming | past
--             | registered | saved | organized
--   p_sort    recommended (default) | soonest | new
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
    or (btrim(p_scope) = 'college' and s.college_id is not null)
    or (btrim(p_scope) = 'community' and s.club_id is not null)
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

-- Single event detail by slug. Restricted meeting links / instructions are
-- only returned to the organizer, community moderators, and attendees.
create or replace function public.event_detail(p_slug text)
returns table (
  id uuid,
  slug text,
  title text,
  summary text,
  description text,
  category text,
  tags text[],
  cover_url text,
  format text,
  venue text,
  venue_address text,
  city text,
  map_url text,
  online_url text,
  access_notes text,
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
  waitlist_enabled boolean,
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
  can_manage boolean,
  links_revealed boolean
)
language sql stable security definer set search_path = public as $$
  with whoami as (
    select w.uid as me_id, p.college_id as my_college
    from (select auth.uid() as uid) w
    left join public.profiles p on p.id = w.uid
  ),
  core as (
    select e.*, w.me_id, w.my_college
    from public.events e
    cross join whoami w
    where e.slug = lower(btrim(p_slug))
      and (
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
              )
            )
          )
        )
      )
  ),
  flags as (
    select c.*,
      (c.created_by = c.me_id
       or (c.club_id is not null and public.is_club_moderator(c.club_id, c.me_id))
      ) as can_manage,
      (select r.status from public.event_rsvps r where r.event_id = c.id and r.user_id = c.me_id limit 1) as my_status
    from core c
  )
  select
    f.id, f.slug, f.title, f.summary, f.description, f.category, f.tags, f.cover_url, f.format,
    f.venue, f.venue_address, f.city, f.map_url,
    case when f.can_manage
              or f.my_status = any (array['registered', 'waitlisted', 'going', 'interested'])
         then f.online_url end,
    case when f.can_manage
              or f.my_status = any (array['registered', 'waitlisted', 'going', 'interested'])
         then f.access_notes end,
    f.starts_at, f.ends_at, f.timezone as timezone_name, f.audience, f.reg_eligibility, f.reg_type,
    f.reg_opens_at, f.reg_deadline, f.registration_url, f.capacity,
    (select count(*) from public.event_rsvps r where r.event_id = f.id and r.status = 'registered')::int,
    (select count(*) from public.event_rsvps r where r.event_id = f.id and r.status = 'going')::int,
    (select count(*) from public.event_rsvps r where r.event_id = f.id and r.status = 'interested')::int,
    f.waitlist as waitlist_enabled, f.featured, f.published, f.cancelled_at, f.created_at, f.updated_at,
    f.college_id, cg.name, cg.short_name, f.club_id, cb.name, cb.slug,
    f.created_by, op.display_name, op.username,
    f.my_status,
    exists (select 1 from public.saved_events sv where sv.event_id = f.id and sv.user_id = f.me_id),
    f.can_manage,
    (f.can_manage or f.my_status = any (array['registered', 'waitlisted', 'going', 'interested'])) as links_revealed
  from flags f
  left join public.colleges cg on cg.id = f.college_id
  left join public.clubs cb on cb.id = f.club_id
  left join public.profiles op on op.id = f.created_by
$$;

revoke all on function public.event_detail(text) from public;
grant execute on function public.event_detail(text) to anon, authenticated;

/* ------------------------------------------------------------------ */
/* 11. Organizer tools                                                 */
/* ------------------------------------------------------------------ */

-- Attendee list: owner/moderator/organizer only (CSV export is derived
-- client-side from this authorized list).
create or replace function public.list_event_attendees(p_event uuid)
returns table (
  user_id uuid,
  display_name text,
  username text,
  status text,
  attendance_status text,
  registered_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select r.user_id, pr.display_name, pr.username, r.status::text, r.attendance_status::text, r.created_at
  from public.event_rsvps r
  left join public.profiles pr on pr.id = r.user_id
  where r.event_id = p_event
    and r.status = any (array['registered', 'waitlisted', 'going', 'interested'])
    and public.can_manage_event(p_event, auth.uid())
  order by (case r.status
              when 'registered' then 0
              when 'going' then 1
              when 'waitlisted' then 2
              else 3 end),
           r.created_at asc
  limit 500
$$;

revoke all on function public.list_event_attendees(uuid) from public;
grant execute on function public.list_event_attendees(uuid) to authenticated;

-- Attendance marking (organizer / community moderators only)
create or replace function public.mark_attendance(p_event uuid, p_user uuid, p_present boolean default true)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to mark attendance.';
  end if;
  if not public.can_manage_event(p_event, auth.uid()) then
    raise exception 'Only organizers and community moderators can mark attendance.';
  end if;
  update public.event_rsvps
  set attendance_status = case when p_present then 'attended' else 'no_show' end
  where event_id = p_event and user_id = p_user
    and status in ('registered', 'going');
  if not found then
    raise exception 'That registration was not found.';
  end if;
end $$;

revoke all on function public.mark_attendance(uuid, uuid, boolean) from public;
grant execute on function public.mark_attendance(uuid, uuid, boolean) to authenticated;
