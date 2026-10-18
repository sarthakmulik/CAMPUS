/* 0018a — events description guard
   Amendments to 0018. Additive + idempotent: re-running is safe.
   Background: legacy events.description NOT NULL was satisfied by every UI
   path, but a direct RPC call with an omitted/blank description surfaced a raw
   23502 violation. Both write RPCs now raise an honest, friendly message.
   Old signature kept 1:1 on both functions so revokes/grants still match.
*/

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
  v_description text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to create events.';
  end if;

  v_description := nullif(btrim(coalesce(p_description, '')), '');
  if v_description is null then
    raise exception 'Add a full description so people know what to expect.';
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
    v_description,
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
  v_description text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to manage events.';
  end if;

  v_description := nullif(btrim(coalesce(p_description, '')), '');
  if v_description is null then
    raise exception 'Add a full description so people know what to expect.';
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
    description = v_description,
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

/* Fix found during the live matrix: cancel_event passed the event id as the
   notification actor, so cancelling an event with attendees violated
   notifications_actor_id_fkey and the whole cancel rolled back. The actor is
   now the organizer performing the cancellation (same convention as the
   other event notifications). */
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
    perform public.notify_member(r.user_id, auth.uid(), 'event_cancelled', 'event', p_event)
    from public.event_rsvps r
    where r.event_id = p_event
      and r.status = any (array['registered', 'waitlisted', 'going', 'interested']);
  end if;
end $$;

revoke all on function public.cancel_event(uuid) from public;
grant execute on function public.cancel_event(uuid) to authenticated;
