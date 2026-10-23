-- ============================================================================
-- 0039 — fix RLS recursion on ad_cam_target (42P17)
--
-- Found by the live matrix: the "ad targets read" policy queried
-- ad_cam_target from inside its own USING clause → "infinite recursion
-- detected in policy for relation ad_cam_target". Any direct SELECT on the
-- ads tables (even by admins via REST) failed; the RPC/VIEWS path worked
-- (security definer skips RLS), which is why the app functioned.
--
-- Fix: judge each target row against the caller's college directly instead
-- of re-querying the target table — no self-reference, same guarantee.
-- ============================================================================

drop policy if exists "ad targets read" on public.ad_cam_target;
create policy "ad targets read" on public.ad_cam_target
  for select to authenticated
  using (
    public.is_admin()
    or (
      -- this row's college is the caller's affiliation, and the campaign is
      -- genuinely serving right now (status + window + creative, all inline)
      ad_cam_target.college_id = (select p.college_id from public.profiles p where p.id = auth.uid())
      and exists (
        select 1 from public.ad_campaigns c
        where c.id = ad_cam_target.campaign_id
          and c.status = 'active'
          and now() >= c.start_at and now() <= c.end_at
          and c.creative_path is not null
      )
    )
  );
