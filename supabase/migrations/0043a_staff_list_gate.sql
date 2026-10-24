-- ============================================================================
-- 0043a — hotfix on top of applied 0043: owner-row repair + roster gate
--
-- Two live findings from the verification round:
--
--  1. The @campus owner account is ALSO addressed by the sarthakmulik16 test
--     email (one auth user, id 519a0307…). 0043's second bootstrap insert
--     collided with the owner's staff row and demoted it to tier admin —
--     the profile stayed super_admin (powers unaffected), but the staff row
--     showed the wrong tier/scopes. This repairs the row and 0043 itself is
--     updated so it can never happen again.
--  2. staff_list() is SECURITY DEFINER, so the staff_accounts RLS never
--     applied to it — any authenticated member could pull the roster through
--     the RPC. Re-issued with an explicit is_staff() filter: members get
--     zero rows, staff see the roster.
--
-- Idempotent; safe to paste more than once.
-- ============================================================================

-- 1) repair the owner staff row (never demote an existing super_admin)
update public.staff_accounts
   set tier   = 'super_admin',
        scopes = array['*']::text[],
        title  = coalesce(title, 'Platform Owner')
 where user_id = (select p.id from public.profiles p where p.username = 'campus')
   and (tier <> 'super_admin' or scopes <> array['*']::text[]);

insert into public.staff_audit_log (actor_id, action, target_type, target_id, metadata)
select p.id, 'staff.tier_repair', 'profile', p.id, '{"tier":"super_admin"}'::jsonb
  from public.profiles p
 where p.username = 'campus'
   and not exists (
     select 1 from public.staff_audit_log a
      where a.action = 'staff.tier_repair' and a.target_id = p.id
   );

-- 2) gate the roster read against non-staff callers
create or replace function public.staff_list()
returns table (
  user_id        uuid,
  username       text,
  display_name   text,
  avatar_url     text,
  tier           text,
  scopes         text[],
  title          text,
  is_active      boolean,
  account_status text,
  provisioned_at timestamptz,
  revoked_at     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.user_id, p.username, p.display_name, p.avatar_url,
    s.tier, s.scopes, s.title, s.is_active, p.account_status,
    s.provisioned_at, s.revoked_at
  from public.staff_accounts s
  join public.profiles p on p.id = s.user_id
  where public.is_staff()
  order by s.is_active desc, s.tier, p.username nulls last
$$;

revoke all on function public.staff_list() from public;
grant  execute on function public.staff_list() to authenticated;
