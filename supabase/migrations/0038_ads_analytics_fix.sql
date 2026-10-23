-- ============================================================================
-- 0038 — fix ad_campaign_analytics by_college ordering
--
-- Found by the live test matrix: the ORDER BY referenced x.college, which is
-- not a column of the cells subquery (it emits short / nm). Replaces the
-- function with the corrected projection.
-- ============================================================================

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
