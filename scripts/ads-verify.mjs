const anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnamRocW9remRpZG11Y3Z4cmd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTI5ODMsImV4cCI6MjEwNzcyODk4M30.XJrGGpSFZk6RIkKmksMfNTjaG_1SbegqPgRwCaxnsm4'
const u = 'https://ggjdhqokzdidmucvxrgz.supabase.co'
const H = { apikey: anon, Authorization: `Bearer ${anon}` }

const main = async () => {
  const t1 = await fetch(`${u}/rest/v1/ad_campaigns?select=id,status&limit=1`, { headers: H })
  console.log('ad_campaigns anon:', t1.status, (await t1.text()).slice(0, 120))

  const t2 = await fetch(`${u}/rest/v1/ad_cam_private?select=campaign_id&limit=1`, { headers: H })
  console.log('ad_cam_private anon:', t2.status, (await t2.text()).slice(0, 120))

  const t3 = await fetch(`${u}/rest/v1/ad_impressions?select=id&limit=1`, { headers: H })
  console.log('ad_impressions anon:', t3.status, (await t3.text()).slice(0, 120))

  const api = await (await fetch(`${u}/rest/v1/`, { headers: H })).text()
  for (const fn of ['serve_sponsored_ads', 'record_sponsored_impression', 'record_sponsored_click', 'ad_overview_metrics', 'list_sponsored_campaigns_admin', 'search_colleges_for_ads', 'set_sponsored_campaign_status', 'attach_sponsored_creative', 'duplicate_sponsored_campaign', 'update_sponsored_campaign', 'set_sponsored_campaign_targets', 'get_sponsored_campaign_admin', 'ad_campaign_analytics', 'create_sponsored_campaign']) {
    console.log(api.includes(`/rpc/${fn}"`) ? `OK   rpc/${fn}` : `MISS rpc/${fn}`)
  }

  const b = await fetch(`${u}/storage/v1/bucket/ad-media`, { headers: H })
  console.log('bucket ad-media:', b.status, (await b.text()).slice(0, 200))
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
