/* Storage-only cleanup: delete every file under campaigns/ (recursive). */
const anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnamRocW9remRpZG11Y3Z4cmd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTI5ODMsImV4cCI6MjEwNzcyODk4M30.XJrGGpSFZk6RIkKmksMfNTjaG_1SbegqPgRwCaxnsm4'
const u = 'https://ggjdhqokzdidmucvxrgz.supabase.co'
const login = async (e, pw) => (await (await fetch(`${u}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: pw }) })).json())

const main = async () => {
  const admin = await login('sarthakmulik16@gmail.com', 'test@123')
  const AL = { apikey: anon, Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' } // list (POST with body)
  const AD = { apikey: anon, Authorization: `Bearer ${admin.access_token}` } // delete must be body-less (storage DELETE 400s with a json header)
  const folders = (await (await fetch(`${u}/storage/v1/object/list/ad-media`, { method: 'POST', headers: AL, body: JSON.stringify({ prefix: 'campaigns/', limit: 1000 }) })).json())
    .filter(o => o.id === null) // folders have null ids, files carry metadata
  for (const f of folders) {
    const files = await (await fetch(`${u}/storage/v1/object/list/ad-media`, { method: 'POST', headers: AL, body: JSON.stringify({ prefix: `campaigns/${f.name}/`, limit: 1000 }) })).json()
    for (const file of files) {
      const d = await fetch(`${u}/storage/v1/object/ad-media/campaigns/${f.name}/${file.name}`, { method: 'DELETE', headers: AD })
      console.log(`deleted campaigns/${f.name}/${file.name} → ${d.status}`)
    }
  }
  const check = await (await fetch(`${u}/storage/v1/object/list/ad-media`, { method: 'POST', headers: AL, body: JSON.stringify({ prefix: 'campaigns/', limit: 1000, recursive: true }) })).json()
  console.log('remaining (recursive):', JSON.stringify(check))
}
main().catch(e => { console.error('ERR', e); process.exit(1) })
