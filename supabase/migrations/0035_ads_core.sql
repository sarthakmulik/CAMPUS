-- ============================================================================
-- 0035 — CAMPUS ADVERTISING (core schema)
--
-- Admin-managed sponsored campaigns targeted at colleges.
--
-- Design notes (map to the product requirements):
--   * Campaign targeting is MANY-TO-MANY against `colleges` (ad_cam_target).
--     Nothing on the campaign inherits the creating admin's own profile
--     college — an admin may advertise for any college their privileges let
--     them manage, while students affiliate through profiles.college_id,
--     which stays exactly as it is today.
--   * Advertiser identity is separated from campaign authorship:
--       created_by       = the CAMPUS admin who created the campaign
--       owner_profile_id = future self-service business owner (nullable now)
--       owner_kind       = 'campus_admin' today, 'business' later
--     A future business account can own campaigns without becoming admin,
--     and ownership never implies approval rights.
--   * Private advertiser contact info + internal notes live in a separate
--     admin-only table so they can never leak through public reads.
--   * Budget is stored as a PLANNING field; no billing/revenue claims.
--   * Impressions and clicks are individual event rows (never client-trusted
--     aggregates), deduped per display instance, with trigger-maintained
--     counters for cheap dashboard reads.
-- ============================================================================

-- ---------------------------------------------------------------- colleges --
-- The directory had city/domain but no state; city/state are searchable.
alter table public.colleges add column if not exists state text;

create index if not exists colleges_lower_name_idx on public.colleges (lower(name));

-- ------------------------------------------------------------- campaigns ---
create table if not exists public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 3 and 80),
  advertiser_name text not null check (char_length(btrim(advertiser_name)) between 2 and 80),
  advertiser_logo_url text,
  headline text not null check (char_length(btrim(headline)) between 4 and 96),
  description text not null check (char_length(btrim(description)) between 4 and 280),
  cta text not null check (cta in (
    'learn_more', 'visit_website', 'get_directions', 'view_offer',
    'register_now', 'explore_event')),
  destination_url text not null check (destination_url ~* '^https?://[^\s]+$'),
  -- creative: files live in the `ad-media` bucket (rows never hold bytes)
  creative_kind text check (creative_kind in ('image', 'video')),
  creative_path text check (creative_path is null or creative_path like 'campaigns/%'),
  creative_thumb_path text check (creative_thumb_path is null or creative_thumb_path like 'campaigns/%'),
  creative_mime text,
  creative_size_bytes bigint check (creative_size_bytes is null or creative_size_bytes between 1 and 26214400),
  creative_duration_seconds numeric check (creative_duration_seconds is null or (creative_duration_seconds > 0 and creative_duration_seconds <= 31)),
  -- lifecycle: draft → scheduled → active ⇄ paused / → completed → archived
  status text not null default 'draft' check (status in (
    'draft', 'scheduled', 'active', 'paused', 'completed', 'archived')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  constraint ad_campaigns_window_check check (end_at > start_at),
  -- a serving campaign can never lack a creative (defense-in-depth behind the RPC rules)
  constraint ad_campaigns_published_creative_check
    check (status in ('draft', 'archived')
      or (creative_path is not null and creative_kind is not null and creative_mime is not null)),
  -- administrative-only planner field; carries NO billing semantics
  budget numeric check (budget is null or budget >= 0),
  -- authorship vs ownership: creator is the admin who made it; owner is the
  -- advertised business (self-service future). Neither implies approval rights.
  created_by uuid references public.profiles (id) on delete set null,
  owner_profile_id uuid references public.profiles (id) on delete set null,
  owner_kind text not null default 'campus_admin' check (owner_kind in ('campus_admin', 'business')),
  -- denormalized counters maintained by triggers (write-time cost, free reads)
  impressions_count bigint not null default 0,
  clicks_count bigint not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ad_campaigns_status_window_idx
  on public.ad_campaigns (status, start_at, end_at);
create index if not exists ad_campaigns_created_by_idx
  on public.ad_campaigns (created_by);

-- ------------------------------------------------------ campaign ↔ college --
create table if not exists public.ad_cam_target (
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  college_id uuid not null references public.colleges (id) on delete cascade,
  primary key (campaign_id, college_id)
);

create index if not exists ad_cam_target_college_idx
  on public.ad_cam_target (college_id);

-- --------------------------------- private advertiser info (admin-only) -----
create table if not exists public.ad_cam_private (
  campaign_id uuid primary key references public.ad_campaigns (id) on delete cascade,
  contact_name text check (contact_name is null or char_length(btrim(contact_name)) <= 80),
  contact_email text check (contact_email is null or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_phone text check (contact_phone is null or char_length(btrim(contact_phone)) <= 24),
  internal_notes text check (internal_notes is null or char_length(btrim(internal_notes)) <= 500)
);

-- --------------------------------------------------------------- events ----
-- One row per DISPLAY INSTANCE, never per render. The client mints a fresh
-- display_id when a card mounts; the unique index makes re-observation a no-op.
create table if not exists public.ad_impressions (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  display_id uuid not null,
  -- the viewer's college affiliation AT impression time (no profile join needed later)
  college_id uuid references public.colleges (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (display_id)
);

create index if not exists ad_impressions_campaign_time_idx
  on public.ad_impressions (campaign_id, created_at desc);
create index if not exists ad_impressions_user_campaign_time_idx
  on public.ad_impressions (user_id, campaign_id, created_at desc);

create table if not exists public.ad_clicks (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  display_id uuid not null,
  college_id uuid references public.colleges (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (display_id)
);

create index if not exists ad_clicks_campaign_time_idx
  on public.ad_clicks (campaign_id, created_at desc);
create index if not exists ad_clicks_user_campaign_time_idx
  on public.ad_clicks (user_id, campaign_id, created_at desc);

-- ----------------------------------------- counter maintenance triggers -----
create or replace function public.ad_bump_counters()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.ad_campaigns set updated_at = now() where id = new.campaign_id;
  if tg_table_name = 'ad_impressions' then
    update public.ad_campaigns set impressions_count = impressions_count + 1 where id = new.campaign_id;
  else
    update public.ad_campaigns set clicks_count = clicks_count + 1 where id = new.campaign_id;
  end if;
  return null;
end $$;

drop trigger if exists ad_impression_counter on public.ad_impressions;
create trigger ad_impression_counter
  after insert on public.ad_impressions
  for each row execute function public.ad_bump_counters();

drop trigger if exists ad_click_counter on public.ad_clicks;
create trigger ad_click_counter
  after insert on public.ad_clicks
  for each row execute function public.ad_bump_counters();

-- =====================================================================
-- Storage — `ad-media` bucket: public reads (creatives are marketing
-- assets), admin-only writes, hard server-side type + size limits.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ad-media',
  'ad-media',
  true,
  26214400, -- 25 MB, matching the rest of CAMPUS media handling
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- public read (same trust level as the `media` bucket)
drop policy if exists "ad-media public read" on storage.objects;
create policy "ad-media public read" on storage.objects
  for select to public
  using (bucket_id = 'ad-media');

-- uploads managed ONLY by CAMPUS admins, inside campaigns/<campaignId>/…
drop policy if exists "ad-media admin write" on storage.objects;
create policy "ad-media admin write" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'ad-media'
    and (storage.foldername(name))[1] = 'campaigns'
    and (storage.foldername(name))[2] is not null
    and public.is_admin()
  )
  with check (
    bucket_id = 'ad-media'
    and (storage.foldername(name))[1] = 'campaigns'
    and (storage.foldername(name))[2] is not null
    and public.is_admin()
  );

-- =====================================================================
-- RLS — students may only ever read campaigns that are genuinely
-- serving to THEIR college; every admin write path requires
-- public.is_admin(). profiles.role stays the single trusted source
-- of admin privileges and campus affiliation never grants any.
-- =====================================================================

alter table public.ad_campaigns enable row level security;
alter table public.ad_cam_target enable row level security;
alter table public.ad_cam_private enable row level security;
alter table public.ad_impressions enable row level security;
alter table public.ad_clicks enable row level security;

-- campaigns: read = admin, or a live campaign currently serving to the
-- reader's own college (missing affiliation matches nothing → no ads).
drop policy if exists "ad campaigns read" on public.ad_campaigns;
create policy "ad campaigns read" on public.ad_campaigns
  for select to authenticated
  using (
    public.is_admin()
    or (
      status = 'active'
      and now() >= start_at
      and now() <= end_at
      and creative_path is not null
      and exists (
        select 1 from public.ad_cam_target t
        where t.campaign_id = ad_campaigns.id
          and t.college_id = (select p.college_id from public.profiles p where p.id = auth.uid())
      )
    )
  );

drop policy if exists "ad campaigns admin insert" on public.ad_campaigns;
create policy "ad campaigns admin insert" on public.ad_campaigns
  for insert to authenticated with check (public.is_admin());

drop policy if exists "ad campaigns admin update" on public.ad_campaigns;
create policy "ad campaigns admin update" on public.ad_campaigns
  for update to authenticated using (public.is_admin());

drop policy if exists "ad campaigns admin delete" on public.ad_campaigns;
create policy "ad campaigns admin delete" on public.ad_campaigns
  for delete to authenticated using (public.is_admin());

-- targets: same visibility as their campaign; admins only may write.
drop policy if exists "ad targets read" on public.ad_cam_target;
create policy "ad targets read" on public.ad_cam_target
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.ad_campaigns c
      where c.id = ad_cam_target.campaign_id
        and c.status = 'active'
        and now() >= c.start_at and now() <= c.end_at
        and c.creative_path is not null
        and exists (
          select 1 from public.ad_cam_target t2
          where t2.campaign_id = c.id
            and t2.college_id = (select p.college_id from public.profiles p where p.id = auth.uid())
        )
    )
  );

drop policy if exists "ad targets admin write" on public.ad_cam_target;
create policy "ad targets admin write" on public.ad_cam_target
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- private advertiser info: admins only, every operation.
drop policy if exists "ad private admin all" on public.ad_cam_private;
create policy "ad private admin all" on public.ad_cam_private
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- events: a student may append an event ABOUT THEMSELVES for a campaign
-- that is really serving; nobody may read event data except admins.
drop policy if exists "ad impressions insert" on public.ad_impressions;
create policy "ad impressions insert" on public.ad_impressions
  for insert to authenticated with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.ad_campaigns c
      where c.id = ad_impressions.campaign_id
        and c.status = 'active'
        and now() >= c.start_at and now() <= c.end_at
        and c.creative_path is not null
        and exists (
          select 1 from public.ad_cam_target t
          where t.campaign_id = c.id
            and t.college_id = (select p.college_id from public.profiles p where p.id = auth.uid())
        )
    )
  );

drop policy if exists "ad impressions read" on public.ad_impressions;
create policy "ad impressions read" on public.ad_impressions
  for select to authenticated using (public.is_admin());

drop policy if exists "ad impressions admin all" on public.ad_impressions;
create policy "ad impressions admin all" on public.ad_impressions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "ad clicks insert" on public.ad_clicks;
create policy "ad clicks insert" on public.ad_clicks
  for insert to authenticated with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.ad_campaigns c
      where c.id = ad_clicks.campaign_id
        and c.status = 'active'
        and now() >= c.start_at and now() <= c.end_at
        and c.creative_path is not null
        and exists (
          select 1 from public.ad_cam_target t
          where t.campaign_id = c.id
            and t.college_id = (select p.college_id from public.profiles p where p.id = auth.uid())
        )
    )
  );

drop policy if exists "ad clicks read" on public.ad_clicks;
create policy "ad clicks read" on public.ad_clicks
  for select to authenticated using (public.is_admin());

drop policy if exists "ad clicks admin all" on public.ad_clicks;
create policy "ad clicks admin all" on public.ad_clicks
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- =====================================================================
-- Lifecycle sweep — pg_cron moves scheduled→active at start time and
-- active→completed after end time, every minute. Enforced SERVER-SIDE:
-- the feed RPC also re-checks the window, so a missed cron beat never
-- serves an expired campaign, and clients never enforce scheduling.
-- =====================================================================
create extension if not exists pg_cron with schema extensions;

create or replace function public.ad_status_sweep()
returns void language plpgsql security definer set search_path = public, cron as $$
begin
  update public.ad_campaigns
    set status = 'active', updated_at = now()
    where status = 'scheduled' and now() between start_at and end_at;

  update public.ad_campaigns
    set status = 'completed', completed_at = now(), updated_at = now()
    where status = 'active' and now() > end_at;
end $$;

select cron.unschedule('campus ads sweep')
  where exists (select 1 from cron.job where jobname = 'campus ads sweep');

select cron.schedule('campus ads sweep', '* * * * *', $$ select public.ad_status_sweep() $$);
