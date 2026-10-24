-- ============================================================================
-- 0041 — tracking is RPC-only: close the raw-row insert hole
--
-- Found by the live matrix: the insert policies on ad_impressions /
-- ad_clicks allowed an authenticated student to append their own row for a
-- campaign that was genuinely serving them. The recording RPCs exist
-- precisely because raw rows can't be trusted (they skip the per-display
-- idempotency, the daily volume caps, and server-side college resolution).
--
-- Fix: drop the student insert policies entirely. RLS denies by default, so
-- students can no longer write tracking rows directly; the definer RPCs
-- (record_sponsored_impression / record_sponsored_click) are the only path,
-- and the admin-all policies still let admins manage row data.
-- ============================================================================

drop policy if exists "ad impressions insert" on public.ad_impressions;
drop policy if exists "ad clicks insert" on public.ad_clicks;
