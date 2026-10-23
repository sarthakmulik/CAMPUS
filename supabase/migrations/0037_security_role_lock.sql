-- ============================================================================
-- 0037 — TRUSTED ROLE ASSIGNMENT (security hardening)
--
-- Live penetration finding: an authenticated member could PATCH their own
-- profiles row and set role = 'admin' (204), because the baseline
-- "users update own profile" policy constrains only id = auth.uid().
-- The 0010 trigger protects is_verified but NOT role — the single column
-- every admin guard in CAMPUS (and the whole advertising system) trusts.
--
-- Fix, mirroring the 0010 pattern:
--   * SQL-editor / service contexts (no auth.uid()) keep full control —
--     promoting an admin stays a deliberate manual operation.
--   * Any authenticated client write that tries to CHANGE role is rejected.
--   * Any authenticated client INSERT of a profile is forced to 'member',
--     so no signup path can start at admin.
--   * Revert the live escalation found during testing.
-- ============================================================================

-- 1. revert the escalation discovered by the pen-test probe -------------------
update public.profiles
  set role = 'member'
  where id = 'f9500db1-a0e6-405d-8781-457c9bad5d1d'
    and role = 'admin';

-- 2. role may only change through trusted tooling -----------------------------
create or replace function public.enforce_role_trusted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No auth uid = SQL editor / service jobs: human-administered by design.
  if auth.uid() is null then
    return new;
  end if;

  if TG_OP = 'UPDATE' and new.role is distinct from old.role then
    raise exception 'Role changes are handled only by trusted CAMPUS tooling — your edit was rejected.'
      using errcode = '42501';
  end if;

  if TG_OP = 'INSERT' and coalesce(new.role, 'member') <> 'member' then
    new.role := 'member'; -- first-row inserts can never self-assign privileges
  end if;

  return new;
end;
$$;

drop trigger if exists role_only_admin on public.profiles;
create trigger role_only_admin
  before insert or update on public.profiles
  for each row
  execute function public.enforce_role_trusted();
