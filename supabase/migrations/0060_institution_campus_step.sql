-- 0060 - CAMPUS SELECTION FOR THE SIGNUP WIZARD (completes the academic tree)
--
-- The academic identity is: group -> campus -> institution -> program ->
-- department -> year -> semester. 0057 stores all of it; this migration adds
-- the ONE missing read: the wizard asks "which campus?" whenever an
-- institution operates more than one (institution_campuses), auto-selects
-- when exactly one is verified, and falls back to the institution's primary
-- campus from search otherwise. Groups and departments stay DERIVED
-- (college -> institution_group_id / department_id) - never duplicated onto
-- profiles, so the tree can be re-parented later without a user migration.
--
-- Rollback: drop the function; nothing else is touched.

create or replace function public.list_institution_campuses(p_college uuid)
returns table (
  id         uuid,
  name       text,
  locality   text,
  city       text,
  address    text,
  is_primary boolean
)
language sql stable security definer set search_path = ''
as $$
  select
    cam.id,
    cam.name,
    cam.locality,
    cam.city,
    cam.address,
    ic.is_primary
  from public.institution_campuses ic
  join public.campuses cam on cam.id = ic.campus_id
  where ic.institution_id = p_college
    and cam.status = 'active'
  order by ic.is_primary desc, cam.name
$$;

revoke all on function public.list_institution_campuses(uuid) from public;
grant execute on function public.list_institution_campuses(uuid) to anon, authenticated;
