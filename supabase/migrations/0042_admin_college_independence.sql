-- ============================================================================
-- 0042 — CAMPUS admins are platform-level: never assigned to a college
--
-- The official @campus admin account had picked up a college affiliation
-- (COEP) through the normal signup/onboarding flow, so its profile read
-- "@campus · COEP" and the account sat inside one college's audience.
-- Admins are staff of the whole platform: they must be college-independent.
--
-- Student signup/onboarding logic is UNCHANGED — members still declare a
-- college exactly as before. This only:
--   1. clears the affiliation off existing admin rows (data fix),
--   2. normalizes any future write that would give an admin a college
--      (so the UI can keep its current flow without special-casing writes),
--   3. marks admins onboarding-complete so the app never replays the
--      student wizard for them (they have no college step to fill).
--
-- Downstream consequences that are correct by design:
--   • ads: a viewer with no college affiliation matches nothing, so admins
--     are never served student advertising and never counted in targeting.
--   • admin authority continues to come solely from profiles.role via
--     public.is_admin() — a college was never part of that decision.
-- ============================================================================

-- 1) existing admins lose their affiliation
update public.profiles
   set college_id = null
 where role = 'admin' and college_id is not null;

-- 2) guard: an admin profile can never carry a college going forward
create or replace function public.admin_profile_guard()
returns trigger
language plpgsql
set search_path = public as $$
begin
  if new.role = 'admin' and new.college_id is not null then
    new.college_id := null;
    new.college_declared_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tr_profiles_admin_no_college on public.profiles;
create trigger tr_profiles_admin_no_college
  before insert or update on public.profiles
  for each row execute function public.admin_profile_guard();

-- 3) admins are never "stuck" in the student onboarding wizard
update public.profiles
   set onboarding_step = 6,
       onboarding_completed_at = coalesce(onboarding_completed_at, now())
 where role = 'admin'
   and (onboarding_completed_at is null or onboarding_step is null or onboarding_step < 6);
