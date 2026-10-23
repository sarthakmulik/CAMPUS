/* One-time cleanup: delete ALL ad campaign rows (test DB — every row is ours)
   and every storage object under the campaigns/ prefix. Verifies both. */
const anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnamRocW9remRpZG11Y3Z4cmd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTI5ODMsImV4cCI6MjEwNzcyODk4M30.XJrGGpSFZk6RIkKmksMfNTjaG_1SbegqPgRwCaxnsm4'
const u = 'https://ggjdhqokzdidmucvxrgz.supabase.co'

const login = async (email, password) => (await (await fetch(`${u}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json())

const main = async () => {
  const admin = await login('sarthakmulik16@gmail.com', 'test@123')
  const A = { apikey: anon, Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' }

  // list everything first (direct SELECT works post-0039)
  const camps = await (await fetch(`${u}/rest/v1/ad_campaigns?select=id,name,status,impressions_count,clicks_count`, { headers: A })).json()
  console.log(`before: ${Array.isArray(camps) ? camps.length : JSON.stringify(camps)} campaigns`)
  if (Array.isArray(camps)) for (const c of camps) console.log(`  ${c.id} ${c.name} [${c.status}] imp=${c.impressions_count} clk=${c.clicks_count}`)

  if (Array.isArray(camps) && camps.length > 0) {
    const ids = camps.map(c => c.id).join(',')
    const del = await fetch(`${u}/rest/v1/ad_campaigns?id=in.(${ids})`, { method: 'DELETE', headers: A })
    console.log('delete status:', del.status)
  }

  const after = await (await fetch(`${u}/rest/v1/ad_campaigns?select=id`, { headers: A })).json()
  console.log('after campaigns:', JSON.stringify(after))
  const imps = await (await fetch(`${u}/rest/v1/ad_impressions?select=id`, { headers: A })).json()
  console.log('after impressions (cascade):', JSON.stringify(imps))
  const clks = await (await fetch(`${u}/rest/v1/ad_clicks?select=id`, { headers: A })).json()
  console.log('after clicks (cascade):', JSON.stringify(clks))

  // storage: list every object under campaigns/ and delete it
  const listRes = await fetch(`${u}/storage/v1/object/list/ad-media`, {
    method: 'POST', headers: A, body: JSON.stringify({ prefix: 'campaigns/', limit: 1000 }),
  })
  const objects = await listRes.json()
  console.log(`storage objects under campaigns/: ${Array.isArray(objects) ? objects.length : JSON.stringify(objects)}`)
  if (Array.isArray(objects)) {
    for (const o of objects) {
      const d = await fetch(`${u}/storage/v1/object/ad-media/campaigns/${o.name}`, { method: 'DELETE', headers: A })
      console.log(`  deleted campaigns/${o.name} → ${d.status}`)
    }
  }
  const listRes2 = await fetch(`${u}/storage/v1/object/list/ad-media`, { method: 'POST', headers: A, body: JSON.stringify({ prefix: 'campaigns/', limit: 1000 }) })
  console.log('storage after:', JSON.stringify(await listRes2.json()))

  const ov = await (await fetch(`${u}/rest/v1/rpc/ad_overview_metrics`, { method: 'POST', headers: A, body: '{}' })).json()
  console.log('overview after cleanup:', JSON.stringify(ov))
}
main().catch(e => { console.error('ERR', e); process.exit(1) })
