-- ============================================================================
-- 0036 — CAMPUS ADVERTISING (server-side logic)
--
-- Every rule the product depends on lives here, NOT in the frontend:
--   * admin authorization via public.is_admin() (profiles.role, server-only)
--   * campaign edit rules — an ACTIVE campaign must be paused before its
--     creative, targeting, schedule, copy or destination may change
--   * explicit lifecycle transitions with validation
--   * delivery eligibility: status + schedule + creative validity +
--     college targeting matched against the CALLER's profiles.college_id —
--     results never include internal fields, and empty/absent targeting
--     can never degrade into "show everyone"
--   * idempotent impression/click recording (deduped per display instance)
--   * analytics aggregates computed from raw event rows
--   * server-side, paginated college directory search
-- ============================================================================

-- ------------------------------------------------------- colleges search ----
-- Admin college picker feed: search name / short_name / city / state / domain,
-- paginated, with real member counts. The client never loads the whole table.
create or replace function public.search_colleges_for_ads(
  p_q text default null,
  p_limit int default 20,
  p_offset int default 0
)
returns table (
  id uuid,
  name text,
  short_name text,
  city text,
  state text,
  verified boolean,
  member_count bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'College directory search is admin-only.' using hint = 'admin_only';
  end if;
  return query
    select
      g.id,
      g.name,
      g.short_name,
      g.city,
      g.state,
      g.verified,
      (select count(*) from public.profiles p where p.college_id = g.id) as member_count
    from public.colleges g
    where p_q is null or btrim(p_q) = ''
      or coalesce(g.name, '')       ilike '%' || btrim(p_q) || '%'
      or coalesce(g.short_name, '') ilike '%' || btrim(p_q) || '%'
      or coalesce(g.city, '')       ilike '%' || btrim(p_q) || '%'
      or coalesce(g.state, '')      ilike '%' || btrim(p_q) || '%'
      or coalesce(g.domain, '')     ilike '%' || btrim(p_q) || '%'
    order by g.verified desc nulls last, g.name
    limit greatest(least(coalesce(p_limit, 20), 50), 1)
    offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- --------------------------------------------------------------- create -----
-- An admin creates a campaign on behalf of any advertiser — the advertiser
-- never needs a CAMPUS account. Ownership (created_by vs the business) is
-- recorded separately for the future self-service platform.
create or replace function public.create_sponsored_campaign(
  p_name text,
  p_advertiser_name text,
  p_headline text,
  p_description text,
  p_cta text,
  p_destination_url text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_budget numeric default null,
  p_advertiser_logo_url text default null,
  p_private jsonb default null,       -- {contact_name?, contact_email?, contact_phone?, internal_notes?}
  p_reference text default null,      -- free internal reference (admin-only)
  p_owner_kind text default null,
  p_owner_profile_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_campaign uuid;
  v_notes text;
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS admins can manage advertising campaigns.' using hint = 'admin_only';
  end if;

  if char_length(btrim(p_name)) not between 3 and 80
    or char_length(btrim(p_advertiser_name)) < 2
    or char_length(btrim(p_headline)) < 4
    or char_length(btrim(p_description)) < 4 then
    raise exception 'Campaign copy is incomplete or too long.' using hint = 'invalid_copy';
  end if;

  if p_cta not in ('learn_more', 'visit_website', 'get_directions', 'view_offer', 'register_now', 'explore_event') then
    raise exception 'Unsupported call-to-action.' using hint = 'invalid_cta';
  end if;

  if btrim(p_destination_url) !~* '^https?://[^\s]+$' then
    raise exception 'The destination must be a valid http(s) URL.' using hint = 'invalid_url';
  end if;

  if p_end_at <= p_start_at then
    raise exception 'The campaign must end after it starts.' using hint = 'invalid_window';
  end if;

  if p_budget is not null and p_budget < 0 then
    raise exception 'Budget cannot be negative.' using hint = 'invalid_budget';
  end if;

  insert into public.ad_campaigns (
    name, advertiser_name, advertiser_logo_url, headline, description,
    cta, destination_url, start_at, end_at, budget,
    created_by, owner_kind, owner_profile_id
  )
  values (
    btrim(p_name), btrim(p_advertiser_name), nullif(btrim(coalesce(p_advertiser_logo_url, '')), ''),
    btrim(p_headline), btrim(p_description), p_cta, btrim(p_destination_url),
    p_start_at, p_end_at, p_budget,
    auth.uid(), coalesce(nullif(p_owner_kind, ''), 'campus_admin'), p_owner_profile_id
  )
  returning id into v_campaign;

  -- private bookkeeping (never delivered to students; admin-only table)
  v_notes := nullif(btrim(concat_ws(
    case when nullif(btrim(coalesce(p_reference, '')), '') is not null then 'Ref: ' || btrim(p_reference) end,
    case when p_private is not null and nullif(btrim(coalesce(p_private ->> 'internal_notes', '')), '') is not null
         then btrim(p_private ->> 'internal_notes') end
  )), '');

  insert into public.ad_cam_private (campaign_id, contact_name, contact_email, contact_phone, internal_notes)
  values (
    v_campaign,
    nullif(btrim(coalesce(p_private ->> 'contact_name', '')), ''),
    nullif(btrim(coalesce(p_private ->> 'contact_email', '')), ''),
    nullif(btrim(coalesce(p_private ->> 'contact_phone', '')), ''),
    v_notes
  )
  on conflict (campaign_id) do nothing;

  return v_campaign;
end $$;

-- ------------------------------------------------------------- targeting ----
-- Replace the whole target set atomically. An EMPTY set is a hard error:
-- missing targeting must never silently become global targeting.
create or replace function public.set_sponsored_campaign_targets(
  p_campaign uuid,
  p_colleges uuid[]
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS admins can manage advertising campaigns.' using hint = 'admin_only';
  end if;
  if not exists (select 1 from public.ad_campaigns where id = p_campaign) then
    raise exception 'Campaign not found.' using hint = 'not_found';
  end if;
  if p_colleges is null or cardinality(p_colleges) = 0 then
    raise exception 'A campaign must target at least one college.' using hint = 'empty_targets';
  end if;
  if cardinality(p_colleges) > 200 then
    raise exception 'A campaign can target at most 200 colleges.' using hint = 'too_many_targets';
  end if;
  if exists (select 1 from public.ad_campaigns where id = p_campaign and status = 'active') then
    raise exception 'Pause an active campaign before changing its targeting.' using hint = 'pause_first';
  end if;

  delete from public.ad_cam_target where campaign_id = p_campaign;
  insert into public.ad_cam_target (campaign_id, college_id)
  select p_campaign, c
  from unnest(array(select distinct c from unnest(p_colleges) as c order by 1)) as ids (c);
end $$;

-- ------------------------------------------------------------- creative -----
-- Called after the file landed in `ad-media` under campaigns/<campaignId>/… —
-- the path must belong to THIS campaign's folder (cannot claim another's file).
create or replace function public.attach_sponsored_creative(
  p_campaign uuid,
  p_kind text,
  p_mime text,
  p_path text,
  p_size_bytes bigint,
  p_duration_seconds numeric default null,
  p_thumb_path text default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS admins can manage advertising campaigns.' using hint = 'admin_only';
  end if;
  if not exists (select 1 from public.ad_campaigns where id = p_campaign) then
    raise exception 'Campaign not found.' using hint = 'not_found';
  end if;
  if exists (select 1 from public.ad_campaigns where id = p_campaign and status = 'active') then
    raise exception 'Pause an active campaign before replacing its creative.' using hint = 'pause_first';
  end if;
  if p_kind not in ('image', 'video') then
    raise exception 'Creative kind must be image or video.' using hint = 'invalid_kind';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 26214400 then
    raise exception 'Creative file is missing or exceeds the 25 MB limit.' using hint = 'invalid_size';
  end if;
  if p_path !~ ('^campaigns/' || p_campaign::text || '/') then
    raise exception 'Creative file must live inside this campaign folder.' using hint = 'invalid_path';
  end if;
  if p_kind = 'video' then
    if p_mime is null or p_mime not like 'video/%' then
      raise exception 'A video creative needs a video file.' using hint = 'invalid_mime';
    end if;
    if p_duration_seconds is null or p_duration_seconds <= 0 or p_duration_seconds > 31 then
      raise exception 'Video ads can be at most 30 seconds.' using hint = 'invalid_duration';
    end if;
  elsif p_mime is null or p_mime not like 'image/%' then
    raise exception 'An image creative needs an image file.' using hint = 'invalid_mime';
  end if;

  update public.ad_campaigns
    set creative_kind = p_kind,
        creative_mime = p_mime,
        creative_path = p_path,
        creative_size_bytes = p_size_bytes,
        creative_duration_seconds = p_duration_seconds,
        creative_thumb_path = nullif(btrim(coalesce(p_thumb_path, '')), ''),
        updated_at = now()
    where id = p_campaign;
end $$;

-- ----------------------------------------------------------- update (edit) --
-- Typed patch. While ACTIVE only the planner budget (and nothing else)
-- changes; every user-visible field requires pausing first — the managed
-- model treats "edit then resume" as the creative re-review checkpoint.
create or replace function public.update_sponsored_campaign(
  p_campaign uuid,
  p_patch jsonb
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.ad_campaigns%rowtype;
  v_editable boolean;
  v_name text;
  v_headline text;
  v_desc text;
  v_cta text;
  v_url text;
  v_logo text;
  v_budget numeric;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS admins can manage advertising campaigns.' using hint = 'admin_only';
  end if;

  select * into v_row from public.ad_campaigns where id = p_campaign;
  if not found then
    raise exception 'Campaign not found.' using hint = 'not_found';
  end if;
  if v_row.status = 'archived' then
    raise exception 'Archived campaigns cannot be edited.' using hint = 'invalid_transition';
  end if;
  v_editable := v_row.status in ('draft', 'scheduled', 'paused');

  -- parse fields out of the patch
  v_name := case when p_patch ? 'name' then btrim(p_patch ->> 'name') end;
  if v_name is not null and char_length(v_name) not between 3 and 80 then
    raise exception 'Campaign name must be 3–80 characters.' using hint = 'invalid_copy';
  end if;

  v_headline := case when p_patch ? 'headline' then btrim(p_patch ->> 'headline') end;
  if v_headline is not null and char_length(v_headline) < 4 then
    raise exception 'Headline must be at least 4 characters.' using hint = 'invalid_copy';
  end if;

  v_desc := case when p_patch ? 'description' then btrim(p_patch ->> 'description') end;
  if v_desc is not null and char_length(v_desc) < 4 then
    raise exception 'Description must be at least 4 characters.' using hint = 'invalid_copy';
  end if;

  v_cta := case when p_patch ? 'cta' then p_patch ->> 'cta' end;
  if v_cta is not null and v_cta not in ('learn_more', 'visit_website', 'get_directions', 'view_offer', 'register_now', 'explore_event') then
    raise exception 'Unsupported call-to-action.' using hint = 'invalid_cta';
  end if;

  v_url := case when p_patch ? 'destination_url' then btrim(p_patch ->> 'destination_url') end;
  if v_url is not null and v_url !~* '^https?://[^\s]+$' then
    raise exception 'The destination must be a valid http(s) URL.' using hint = 'invalid_url';
  end if;

  v_logo := case when p_patch ? 'advertiser_logo_url' then nullif(btrim(p_patch ->> 'advertiser_logo_url'), '') end;

  v_budget := case when p_patch ? 'budget' then nullif(p_patch ->> 'budget', '')::numeric end;
  if v_budget is not null and v_budget < 0 then
    raise exception 'Budget cannot be negative.' using hint = 'invalid_budget';
  end if;

  v_start := case when p_patch ? 'start_at' then (p_patch ->> 'start_at')::timestamptz end;
  v_end := case when p_patch ? 'end_at' then (p_patch ->> 'end_at')::timestamptz end;

  -- if the changed advertiser name is present, validate it happens on the editable path only
  if p_patch ? 'advertiser_name' and btrim(p_patch ->> 'advertiser_name') is not null then
    if not v_editable then
      raise exception 'Pause the campaign before editing it.' using hint = 'pause_first';
    end if;
    update public.ad_campaigns
      set advertiser_name = btrim(p_patch ->> 'advertiser_name'), updated_at = now()
      where id = p_campaign;
  end if;

  -- user-visible edits need a paused/draft/scheduled state
  if v_name is not null or v_headline is not null or v_desc is not null
    or v_cta is not null or v_url is not null or v_start is not null or v_end is not null then
    if not v_editable then
      raise exception 'Pause the campaign before editing it.' using hint = 'pause_first';
    end if;
  end if;

  update public.ad_campaigns
    set name            = coalesce(v_name, name),
        headline        = coalesce(v_headline, headline),
        description     = coalesce(v_desc, description),
        cta             = coalesce(v_cta, cta),
        destination_url = coalesce(v_url, destination_url),
        advertiser_logo_url = case when p_patch ? 'advertiser_logo_url' then v_logo else advertiser_logo_url end,
        budget          = case when p_patch ? 'budget' then v_budget else budget end,
        start_at        = coalesce(v_start, start_at),
        end_at          = coalesce(v_end, end_at),
        updated_at      = now()
    where id = p_campaign
      and (not p_patch ? 'budget' or v_budget is null or v_budget >= 0);

  -- schedule sanity recheck
  if (p_patch ? 'start_at' or p_patch ? 'end_at') then
    if exists (select 1 from public.ad_campaigns where id = p_campaign and end_at <= start_at) then
      raise exception 'The campaign must end after it starts.' using hint = 'invalid_window';
    end if;
  end if;

  -- private bookkeeping
  if p_patch ? 'internal_notes' or p_patch ? 'contact_name' or p_patch ? 'contact_email' or p_patch ? 'contact_phone' then
    insert into public.ad_cam_private (campaign_id) values (p_campaign)
    on conflict (campaign_id) do nothing;
    update public.ad_cam_private
      set contact_name   = case when p_patch ? 'contact_name'  then nullif(btrim(coalesce(p_patch ->> 'contact_name', '')), '') else contact_name end,
          contact_email  = case when p_patch ? 'contact_email' then nullif(btrim(coalesce(p_patch ->> 'contact_email', '')), '') else contact_email end,
          contact_phone  = case when p_patch ? 'contact_phone' then nullif(btrim(coalesce(p_patch ->> 'contact_phone', '')), '') else contact_phone end,
          internal_notes = case when p_patch ? 'internal_notes' then nullif(btrim(coalesce(p_patch ->> 'internal_notes', '')), '') else internal_notes end
      where campaign_id = p_campaign;
  end if;
end $$;

-- ------------------------------------------------- lifecycle transitions ----
create or replace function public.set_sponsored_campaign_status(
  p_campaign uuid,
  p_status text
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.ad_campaigns%rowtype;
  v_effective text := p_status;
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS admins can manage advertising campaigns.' using hint = 'admin_only';
  end if;

  select * into v_row from public.ad_campaigns where id = p_campaign;
  if not found then
    raise exception 'Campaign not found.' using hint = 'not_found';
  end if;
  if v_effective not in ('draft', 'scheduled', 'active', 'paused', 'completed', 'archived') then
    raise exception 'Unknown campaign state.' using hint = 'invalid_status';
  end if;

  case
    when v_row.status = v_effective then
      null; -- idempotent

    when v_row.status = 'draft' then
      if v_effective not in ('scheduled', 'active', 'archived') then
        raise exception 'A draft can be scheduled, published or archived.' using hint = 'invalid_transition';
      end if;
      if v_effective in ('scheduled', 'active') and v_row.creative_path is null then
        raise exception 'Add a creative before publishing the campaign.' using hint = 'no_creative';
      end if;
      if v_effective in ('scheduled', 'active') and now() > v_row.end_at then
        raise exception 'This schedule already ended — extend the window first.' using hint = 'window_ended';
      end if;

    when v_row.status = 'scheduled' then
      if v_effective not in ('active', 'paused', 'draft', 'archived') then
        raise exception 'A scheduled campaign can go live, pause, return to draft, or archive.' using hint = 'invalid_transition';
      end if;

    when v_row.status = 'active' then
      if v_effective not in ('paused', 'completed', 'archived') then
        raise exception 'An active campaign can pause, complete or archive.' using hint = 'invalid_transition';
      end if;
      -- pausing after the window already ended completes it instead
      if v_effective = 'paused' and now() > v_row.end_at then
        v_effective := 'completed';
      end if;

    when v_row.status = 'paused' then
      if v_effective not in ('active', 'completed', 'draft', 'archived') then
        raise exception 'A paused campaign can resume, complete, return to draft, or archive.' using hint = 'invalid_transition';
      end if;
      -- an expired paused campaign can never resume beyond its end date
      if v_effective = 'active' and now() > v_row.end_at then
        raise exception 'This campaign window already ended — extend the schedule or complete it.' using hint = 'window_ended';
      end if;

    when v_row.status = 'completed' then
      if v_effective not in ('draft', 'archived') then
        raise exception 'Ended campaigns are read-only — duplicate it and edit the copy in draft.' using hint = 'invalid_transition';
      end if;

    when v_row.status = 'archived' then
      null; -- archived is terminal
  end case;

  update public.ad_campaigns
    set status = v_effective,
        completed_at = case
          when v_effective = 'completed' and v_row.status <> 'completed' then now()
          else completed_at
        end,
        updated_at = now()
    where id = p_campaign;
end $$;

-- ------------------------------------------------------------- duplicate ----
-- Copy for re-runs: always lands as DRAFT (an ended campaign cannot simply be
-- reset to active). The creative file stays under the ORIGINAL campaign's
-- folder, so the copy explicitly re-attaches before it can publish.
create or replace function public.duplicate_sponsored_campaign(p_campaign uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_row public.ad_campaigns%rowtype;
  v_new uuid;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS admins can manage advertising campaigns.' using hint = 'admin_only';
  end if;
  if not exists (select 1 from public.ad_campaigns where id = p_campaign) then
    raise exception 'Campaign not found.' using hint = 'not_found';
  end if;

  select * into v_row from public.ad_campaigns where id = p_campaign;
  v_start := greatest(now() + interval '1 hour', v_row.start_at);
  v_end := v_start + least(greatest(v_row.end_at - v_row.start_at, interval '1 hour'), interval '30 days');

  insert into public.ad_campaigns (
    name, advertiser_name, advertiser_logo_url, headline, description, cta,
    destination_url, status, start_at, end_at, budget, created_by, owner_kind, owner_profile_id
  )
  values (
    case when char_length(v_row.name || ' (copy)') <= 80 then v_row.name || ' (copy)' else v_row.name end,
    v_row.advertiser_name, v_row.advertiser_logo_url, v_row.headline, v_row.description, v_row.cta,
    v_row.destination_url, 'draft', v_start, v_end, v_row.budget, auth.uid(), v_row.owner_kind, v_row.owner_profile_id
  )
  returning id into v_new;

  insert into public.ad_cam_target (campaign_id, college_id)
  select v_new, college_id from public.ad_cam_target where campaign_id = p_campaign;

  insert into public.ad_cam_private (campaign_id, contact_name, contact_email, contact_phone, internal_notes)
  select v_new, c.contact_name, c.contact_email, c.contact_phone,
         coalesce('DUPLICATED from ' || v_row.name || ' — re-attach the creative file to publish.', 'duplicated from ' || v_row.id::text)
    from public.ad_cam_private c where c.campaign_id = p_campaign
    on conflict (campaign_id) do nothing;

  return v_new;
end $$;

-- =====================================================================
--  DELIVERY
-- =====================================================================
-- Only campaigns that are truly serving right now are returned, only to
-- callers belonging to a targeted college, with a per-user frequency guard.
-- Returns minimal, public-safe columns; paths are resolved against ad-media
-- by the client (never returns created_by, owner ids, budget, notes…).
create or replace function public.serve_sponsored_ads(p_limit int default 2)
returns table (
  id uuid,
  advertiser_name text,
  advertiser_logo_url text,
  headline text,
  description text,
  cta text,
  destination_url text,
  creative_kind text,
  creative_path text,
  creative_mime text,
  creative_thumb_path text,
  creative_duration_seconds numeric
)
language sql stable security definer set search_path = public as $$
  select
    c.id,
    c.advertiser_name,
    c.advertiser_logo_url,
    c.headline,
    c.description,
    c.cta,
    c.destination_url,
    c.creative_kind,
    c.creative_path,
    c.creative_mime,
    c.creative_thumb_path,
    c.creative_duration_seconds
  from public.ad_campaigns c
  where c.status = 'active'
    and c.creative_path is not null
    and now() >= c.start_at
    and now() <= c.end_at
    -- STRICT college targeting: no target row can match the caller → no ad
    and exists (
      select 1
      from public.ad_cam_target t
      join public.profiles p on p.college_id = t.college_id
      where t.campaign_id = c.id
        and p.id = auth.uid()
    )
    -- frequency guard: same viewer + same campaign at most once per 6 hours
    and not exists (
      select 1 from public.ad_impressions i
      where i.user_id = auth.uid()
        and i.campaign_id = c.id
        and i.created_at > now() - interval '6 hours'
    )
  order by random()
  limit greatest(least(coalesce(p_limit, 2), 6), 1)
$$;

-- ------------------------------------------------------------ impressions ---
-- Idempotent per display instance (unique(display_id)). The caller's college
-- is resolved server-side — never trusted from the client payload.
create or replace function public.record_sponsored_impression(
  p_campaign uuid,
  p_display uuid
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_college uuid;
  v_inserted boolean := false;
begin
  if auth.uid() is null or p_campaign is null then
    return false;
  end if;
  select p.college_id into v_college from public.profiles p where p.id = auth.uid();

  -- record only for campaigns genuinely serving to THIS viewer right now
  if not exists (
    select 1
    from public.ad_campaigns c
    join public.ad_cam_target t on t.campaign_id = c.id
    where c.id = p_campaign
      and c.status = 'active'
      and c.creative_path is not null
      and now() >= c.start_at and now() <= c.end_at
      and t.college_id = v_college
  ) then
    return false;
  end if;

  -- volume guard: a scripted client cannot fabricate unbounded impressions
  -- (per-user cap over 24h; index (user_id, campaign_id, created_at) covers it)
  if (
    select count(*) from public.ad_impressions
    where user_id = auth.uid() and created_at > now() - interval '24 hours'
  ) >= 300 then
    return false;
  end if;

  insert into public.ad_impressions (campaign_id, user_id, display_id, college_id)
    values (p_campaign, auth.uid(), p_display, v_college)
    on conflict (display_id) do nothing;
  v_inserted := found;
  return v_inserted;
end $$;

-- click recording — same eligibility rules, deduped per display instance.
create or replace function public.record_sponsored_click(
  p_campaign uuid,
  p_display uuid
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_college uuid;
begin
  if auth.uid() is null or p_campaign is null then
    return false;
  end if;
  select p.college_id into v_college from public.profiles p where p.id = auth.uid();

  if not exists (
    select 1
    from public.ad_campaigns c
    join public.ad_cam_target t on t.campaign_id = c.id
    where c.id = p_campaign
      and c.status = 'active'
      and c.creative_path is not null
      and now() >= c.start_at and now() <= c.end_at
      and t.college_id = v_college
  ) then
    return false;
  end if;

  -- volume guard: clicks are capped per user per 24h against scripted abuse
  if (
    select count(*) from public.ad_clicks
    where user_id = auth.uid() and created_at > now() - interval '24 hours'
  ) >= 50 then
    return false;
  end if;

  insert into public.ad_clicks (campaign_id, user_id, display_id, college_id)
    values (p_campaign, auth.uid(), p_display, v_college)
    on conflict (display_id) do nothing;
  return found;
end $$;

-- =====================================================================
--  ANALYTICS (admin-only)
-- =====================================================================
create or replace function public.ad_campaign_analytics(p_campaign uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Campaign analytics are admin-only.' using hint = 'admin_only';
  end if;
  if not exists (select 1 from public.ad_campaigns where id = p_campaign) then
    raise exception 'Campaign not found.' using hint = 'not_found';
  end if;

  with d as (
    select day, sum(impressions) as imps, sum(clicks) as clicks from (
      select date_trunc('day', created_at) as day, count(*)::int as impressions, 0 as clicks
        from public.ad_impressions where campaign_id = p_campaign group by 1
      union all
      select date_trunc('day', created_at), 0, count(*)::int
        from public.ad_clicks where campaign_id = p_campaign group by 1
    ) u
    group by day
  )
  select jsonb_build_object(
    'impressions', (select count(*) from public.ad_impressions where campaign_id = p_campaign),
    'clicks', (select count(*) from public.ad_clicks where campaign_id = p_campaign),
    'ctr', (
      select case when count(*) = 0 then 0
             else round(100.0 * (select count(*) from public.ad_clicks where campaign_id = p_campaign) / count(*), 2) end
      from public.ad_impressions where campaign_id = p_campaign
    ),
    'by_day', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', to_char(day, 'YYYY-MM-DD'),
               'impressions', imps,
               'clicks', clicks) order by day), '[]'::jsonb)
      from d
    ),
    'by_college', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'college', coalesce(x.short, x.nm, 'No college'),
               'impressions', coalesce(x.imps, 0),
               'clicks', coalesce(x.clicks, 0),
               'ctr', case when coalesce(x.imps, 0) = 0 then 0
                      else round(100.0 * coalesce(x.clicks, 0) / x.imps, 2) end
             ) order by x.imps desc nulls last, x.short, x.nm), '[]'::jsonb)
      from (
        select g.short_name as short, g.name as nm, ii.imps as imps, kk.clicks as clicks
        from (select distinct college_id from public.ad_impressions where campaign_id = p_campaign) cells
        left join public.colleges g on g.id = cells.college_id
        left join (
          select college_id, count(*)::int as imps from public.ad_impressions
          where campaign_id = p_campaign group by college_id
        ) ii on ii.college_id = cells.college_id
        left join (
          select college_id, count(*)::int as clicks from public.ad_clicks
          where campaign_id = p_campaign group by college_id
        ) kk on kk.college_id = cells.college_id
      ) x
    )
  )
  into v_result;

  return v_result;
end $$;

-- dashboard overview tiles
create or replace function public.ad_overview_metrics()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Campaign analytics are admin-only.' using hint = 'admin_only';
  end if;

  return (
    select jsonb_build_object(
      'total', count(*),
      'draft', count(*) filter (where status = 'draft'),
      'scheduled', count(*) filter (where status = 'scheduled'),
      'active', count(*) filter (where status = 'active'),
      'paused', count(*) filter (where status = 'paused'),
      'completed', count(*) filter (where status = 'completed'),
      'archived', count(*) filter (where status = 'archived'),
      'impressions', coalesce(sum(impressions_count), 0),
      'clicks', coalesce(sum(clicks_count), 0),
      'ctr', case when coalesce(sum(impressions_count), 0) = 0 then 0
             else round(100.0 * coalesce(sum(clicks_count), 0) / sum(impressions_count), 2) end,
      'ending_soon', count(*) filter (
        where status = 'active' and end_at <= now() + interval '3 days'
      )
    )
    from public.ad_campaigns
  );
end $$;

-- campaign list for the management table (admins only), with metric chips
create or replace function public.list_sponsored_campaigns_admin()
returns table (
  id uuid,
  name text,
  advertiser_name text,
  advertiser_logo_url text,
  headline text,
  status text,
  creative_kind text,
  creative_mime text,
  creative_path text,
  creative_thumb_path text,
  creative_duration_seconds numeric,
  start_at timestamptz,
  end_at timestamptz,
  budget numeric,
  impressions_count bigint,
  clicks_count bigint,
  colleges jsonb,
  has_private_notes boolean,
  created_by_name text,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS admins can manage advertising campaigns.' using hint = 'admin_only';
  end if;
  return query
    select
      c.id,
      c.name,
      c.advertiser_name,
      c.advertiser_logo_url,
      c.headline,
      c.status,
      c.creative_kind,
      c.creative_mime,
      c.creative_path,
      c.creative_thumb_path,
      c.creative_duration_seconds,
      c.start_at,
      c.end_at,
      c.budget,
      c.impressions_count,
      c.clicks_count,
      coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', g.id, 'name', g.name, 'short_name', g.short_name) order by g.name)
        from public.ad_cam_target t
        join public.colleges g on g.id = t.college_id
        where t.campaign_id = c.id
      ), '[]'::jsonb),
      exists (select 1 from public.ad_cam_private v where v.campaign_id = c.id
                 and (v.internal_notes is not null or v.contact_name is not null or v.contact_phone is not null)),
      coalesce(pr.display_name, pr.username, 'CAMPUS admin'),
      c.created_at,
      c.updated_at,
      c.completed_at
    from public.ad_campaigns c
    left join public.profiles pr on pr.id = c.created_by
    order by c.created_at desc;
end $$;

-- full campaign detail (admins only) incl private bookkeeping + analytics
create or replace function public.get_sponsored_campaign_admin(p_campaign uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS admins can manage advertising campaigns.' using hint = 'admin_only';
  end if;
  if not exists (select 1 from public.ad_campaigns where id = p_campaign) then
    raise exception 'Campaign not found.' using hint = 'not_found';
  end if;

  return
    jsonb_build_object('campaign', (select row_to_json(c) from public.ad_campaigns c where id = p_campaign)) ||
    jsonb_build_object('targets', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name, 'short_name', g.short_name, 'city', g.city, 'state', g.state)
               order by g.name), '[]'::jsonb)
      from public.ad_cam_target t join public.colleges g on g.id = t.college_id
      where t.campaign_id = p_campaign
    )) ||
    jsonb_build_object('private', coalesce((
      select to_jsonb(v)
      from public.ad_cam_private v
      where v.campaign_id = p_campaign
    ), 'null'::jsonb)) ||
    jsonb_build_object('analytics', public.ad_campaign_analytics(p_campaign));
end $$;

-- remove any stale duplicate of a previous draft helper, if one exists
drop function if exists public.ad_campaign_serving(uuid);
