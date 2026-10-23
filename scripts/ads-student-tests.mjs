/* Student-side security matrix for the ads system (migration 0035/0036 applied). */
const anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnamRocW9remRpZG11Y3Z4cmd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTI5ODMsImV4cCI6MjEwNzcyODk4M30.XJrGGpSFZk6RIkKmksMfNTjaG_1SbegqPgRwCaxnsm4'
const u = 'https://ggjdhqokzdidmucvxrgz.supabase.co'

const rpc = async (token, name, args) => {
  const r = await fetch(`${u}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { status: r.status, body: (await r.text()).slice(0, 220) }
}

const main = async () => {
  // 1. sign in as the probe student
  const r = await fetch(`${u}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'notif-probe-1.campus.test@gmail.com', password: 'Np-2026xQ!' }),
  })
  const auth = await r.json()
  const token = auth.access_token
  const uid = auth.user?.id
  console.log('login:', r.status, 'uid:', uid)

  const H = { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // 2. profile read
  const prof = await (await fetch(`${u}/rest/v1/profiles?id=eq.${uid}&select=id,role,college_id,onboarding_completed_at`, { headers: H })).json()
  console.log('profile:', JSON.stringify(prof))

  // 3. profile CANNOT self-promote to admin (update role field)
  const promote = await fetch(`${u}/rest/v1/profiles?id=eq.${uid}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ role: 'admin' }),
  })
  console.log('self-promote attempt:', promote.status, (await promote.text()).slice(0, 160))
  const prof2 = await (await fetch(`${u}/rest/v1/profiles?id=eq.${uid}&select=role`, { headers: H })).json()
  console.log('role after attempt:', JSON.stringify(prof2))

  // 4. student cannot create a campaign
  console.log('create attempt:', JSON.stringify(await rpc(token, 'create_sponsored_campaign', { p_name: 'x', p_advertiser_name: 'y', p_headline: 'abc', p_description: 'abc', p_cta: 'learn_more', p_destination_url: 'https://x.com', p_start_at: new Date().toISOString(), p_end_at: new Date(Date.now() + 86400000).toISOString() })))

  // 5. student cannot set targets / attach creative / change status / edit / list / overview
  const fake = '00000000-0000-0000-0000-000000000000'
  for (const [name, args] of [
    ['set_sponsored_campaign_targets', { p_campaign: fake, p_colleges: [fake] }],
    ['attach_sponsored_creative', { p_campaign: fake, p_kind: 'image', p_mime: 'image/png', p_path: `campaigns/${fake}/a.png`, p_size_bytes: 100 }],
    ['set_sponsored_campaign_status', { p_campaign: fake, p_status: 'active' }],
    ['update_sponsored_campaign', { p_campaign: fake, p_patch: { name: 'hi' } }],
    ['duplicate_sponsored_campaign', { p_campaign: fake }],
    ['list_sponsored_campaigns_admin', {}],
    ['ad_overview_metrics', {}],
    ['get_sponsored_campaign_admin', { p_campaign: fake }],
    ['ad_campaign_analytics', { p_campaign: fake }],
    ['search_colleges_for_ads', { p_q: null, p_limit: 5, p_offset: 0 }],
  ]) {
    const res = await rpc(token, name, args).catch(e => ({ status: 'ERR', body: e.message }))
    console.log(`denied ${name}:`, res.status, String(res.body).slice(0, 110))
  }

  // 6. serve (student, empty right now) — should be a clean empty payload
  console.log('serve:', JSON.stringify(await rpc(token, 'serve_sponsored_ads', { p_limit: 2 })))

  // 7. impression recording against a fake campaign must return false (no error, no row)
  console.log('record_impression fake:', JSON.stringify(await rpc(token, 'record_sponsored_impression', { p_campaign: fake, p_display: '11111111-1111-1111-1111-111111111111' })))
  console.log('record_click fake:', JSON.stringify(await rpc(token, 'record_sponsored_click', { p_campaign: fake, p_display: '11111111-1111-1111-1111-111111111111' })))

  // 8. student cannot read event rows (RLS)
  const imp = await fetch(`${u}/rest/v1/ad_impressions?select=id&limit=5`, { headers: H })
  console.log('read ad_impressions as student:', imp.status, (await imp.text()).slice(0, 60))
  const clk = await fetch(`${u}/rest/v1/ad_clicks?select=id&limit=5`, { headers: H })
  console.log('read ad_clicks as student:', clk.status, (await clk.text()).slice(0, 60))
  const priv = await fetch(`${u}/rest/v1/ad_cam_private?select=campaign_id&limit=5`, { headers: H })
  console.log('read ad_cam_private as student:', priv.status, (await priv.text()).slice(0, 60))
}
main().catch(e => { console.error('ERR', e); process.exit(1) })
