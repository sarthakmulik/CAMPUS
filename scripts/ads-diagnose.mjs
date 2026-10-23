/* Diagnose current DB state: leftover campaigns, impression rows, live record behavior. */
const anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnamRocW9remRpZG11Y3Z4cmd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTI5ODMsImV4cCI6MjEwNzcyODk4M30.XJrGGpSFZk6RIkKmksMfNTjaG_1SbegqPgRwCaxnsm4'
const u = 'https://ggjdhqokzdidmucvxrgz.supabase.co'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const login = async (email, password) => (await (await fetch(`${u}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json())
const rpc = (t, name, args) => fetch(`${u}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: anon, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args ?? {}) }).then(async r => ({ status: r.status, body: await r.text() }))

const main = async () => {
  const admin = await login('sarthakmulik16@gmail.com', 'test@123')
  const A = { apikey: anon, Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' }
  const probe = await login('notif-probe-1.campus.test@gmail.com', 'Np-2026xQ!')
  const P = { apikey: anon, Authorization: `Bearer ${probe.access_token}`, 'Content-Type': 'application/json' }

  // all campaigns (counts)
  const camps = await (await fetch(`${u}/rest/v1/ad_campaigns?select=id,name,status,start_at,end_at,impressions_count,clicks_count`, { headers: A })).json()
  console.log('campaigns:', JSON.stringify(camps, null, 1))

  // impression rows (admin has select)
  const imps = await (await fetch(`${u}/rest/v1/ad_impressions?select=id,campaign_id,display_id,created_at&order=id.desc&limit=10`, { headers: A })).json()
  console.log('impressions:', JSON.stringify(imps))
  const clks = await (await fetch(`${u}/rest/v1/ad_clicks?select=id,campaign_id,display_id&limit=10`, { headers: A })).json()
  console.log('clicks:', JSON.stringify(clks))

  // fresh create + publish + record with FULL status capture
  const created = await rpc(admin.access_token, 'create_sponsored_campaign', {
    p_name: 'Diag Campaign', p_advertiser_name: 'Diag Co', p_headline: 'Diagnostic only', p_description: 'Diagnose impression recording.',
    p_cta: 'learn_more', p_destination_url: 'https://example.com/d', p_start_at: new Date(Date.now() - 60000).toISOString(), p_end_at: new Date(Date.now() + 5 * 60000).toISOString(),
  })
  const cid = JSON.parse(created.body)
  console.log('created:', cid)
  await rpc(admin.access_token, 'set_sponsored_campaign_targets', { p_campaign: cid, p_colleges: ['1fba2225-352e-4abc-afd2-a628e7e2474a'] })
  await fetch(`${u}/storage/v1/object/ad-media/campaigns/${cid}/d.png`, { method: 'POST', headers: { apikey: anon, Authorization: `Bearer ${admin.access_token}`, 'cache-control': '3600', 'content-type': 'image/png' }, body: png })
  console.log('attach:', (await rpc(admin.access_token, 'attach_sponsored_creative', { p_campaign: cid, p_kind: 'image', p_mime: 'image/png', p_path: `campaigns/${cid}/d.png`, p_size_bytes: png.length })))
  console.log('activate:', (await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: cid, p_status: 'active' })))
  const serve = await rpc(probe.access_token, 'serve_sponsored_ads', { p_limit: 3 })
  console.log('serve:', serve.status, serve.body.slice(0, 200))
  const disp = '66666666-6666-6666-6666-666666666666'
  const rec = await rpc(probe.access_token, 'record_sponsored_impression', { p_campaign: cid, p_display: disp })
  console.log('record impression:', rec.status, '|', rec.body)
  const direct = await fetch(`${u}/rest/v1/ad_impressions?select=id&limit=5`, { headers: P })
  console.log('student read impressions:', direct.status, (await direct.text()).slice(0, 100))
  const imps2 = await (await fetch(`${u}/rest/v1/ad_impressions?select=id,campaign_id,display_id&limit=5`, { headers: A })).json()
  console.log('impressions after record:', JSON.stringify(imps2))

  console.log('diag campaign:', cid)
}
main().catch(e => { console.error('ERR', e); process.exit(1) })
