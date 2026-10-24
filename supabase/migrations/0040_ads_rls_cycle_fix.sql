-- ============================================================================
-- 0040 — break the RLS policy recursion cycle for good (42P17)
--
-- The live matrix kept hitting "infinite recursion detected in policy for
-- relation ad_cam_target". Root cause is a MUTUAL cycle between policies:
--
--   "ad campaigns read" (on ad_campaigns)  → queries ad_cam_target
--   "ad targets read"    (on ad_cam_target) → queries ad_campaigns  → CYCLE
--
-- Postgres evaluates the subquery's table under its own RLS, so evaluating
-- one policy re-enters the other and Postgres aborts. This breaks every
-- direct REST SELECT (and anything RLS-protected that touches these tables),
-- even though the security-definer RPCs kept working.
--
-- Fix: move the cross-table eligibility predicates into SECURITY DEFINER
-- helper functions. A definer function bypasses RLS, so a policy can call
-- it without re-entering any policy. The helpers are fixed logic — they
-- expose nothing the serve RPC doesn't already enforce.
-- ============================================================================

-- Is this campaign genuinely serving right now? (status + window + creative)
create or replace function public.ad_campaign_is_serving(c uuid)
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from public.ad_campaigns x
    where x.id = c
      and x.status = 'active'
      and now() >= x.start_at and now() <= x.end_at
      and x.creative_path is not null
  )
$$;

-- Does this campaign target the caller's own college? (no match → false)
create or replace function public.ad_campaign_targets_viewer(c uuid)
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from public.ad_cam_target t
    where t.campaign_id = c
      and t.college_id = (
        select p.college_id from public.profiles p where p.id = auth.uid()
      )
  )
$$;

grant execute on function public.ad_campaign_is_serving(uuid) to authenticated;
grant execute on function public.ad_campaign_targets_viewer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- campaigns: read = admin, or a live campaign serving to the caller's college.
-- All cross-table work happens in the definer helper → no recursion.
-- ---------------------------------------------------------------------------
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
      and public.ad_campaign_targets_viewer(ad_campaigns.id)
    )
  );

-- targets: visible if the row IS the caller's college and the campaign is
-- genuinely serving right now. Only its own row + a definer helper.
drop policy if exists "ad targets read" on public.ad_cam_target;
create policy "ad targets read" on public.ad_cam_target
  for select to authenticated
  using (
    public.is_admin()
    or (
      ad_cam_target.college_id = (select p.college_id from public.profiles p where p.id = auth.uid())
      and public.ad_campaign_is_serving(ad_cam_target.campaign_id)
    )
  );

-- events: a student may append an event ABOUT THEMSELVES for a campaign that
-- is genuinely serving their college; read/admin stays admins only.
drop policy if exists "ad impressions insert" on public.ad_impressions;
create policy "ad impressions insert" on public.ad_impressions
  for insert to authenticated with check (
    user_id = auth.uid()
    and public.ad_campaign_is_serving(ad_impressions.campaign_id)
    and public.ad_campaign_targets_viewer(ad_impressions.campaign_id)
  );

drop policy if exists "ad impressions read" on public.ad_impressions;
create policy "ad impressions read" on public.ad_impressions
  for select to authenticated using (public.is_admin());

drop policy if exists "ad clicks insert" on public.ad_clicks;
create policy "ad clicks insert" on public.ad_clicks
  for insert to authenticated with check (
    user_id = auth.uid()
    and public.ad_campaign_is_serving(ad_clicks.campaign_id)
    and public.ad_campaign_targets_viewer(ad_clicks.campaign_id)
  );

drop policy if exists "ad clicks read" on public.ad_clicks;
create policy "ad clicks read" on public.ad_clicks
  for select to authenticated using (public.is_admin());
