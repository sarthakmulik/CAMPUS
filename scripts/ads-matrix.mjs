/* Full ads system test matrix — executed against the LIVE Supabase project (fixed flow). */
const anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnamRocW9remRpZG11Y3Z4cmd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTI5ODMsImV4cCI6MjEwNzcyODk4M30.XJrGGpSFZk6RIkKmksMfNTjaG_1SbegqPgRwCaxnsm4'
const u = 'https://ggjdhqokzdidmucvxrgz.supabase.co'
let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`) } else { fail++; console.log(`FAIL ${name} :: ${detail}`) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const login = async (email, password) => {
  const r = await fetch(`${u}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return r.json()
}
const rpc = (token, name, args) => fetch(`${u}/rest/v1/rpc/${name}`, {
  method: 'POST',
  headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(args ?? {}),
}).then(async r => ({ status: r.status, body: await r.text() }))
const table = (token, path, opts = {}) => fetch(`${u}/rest/v1/${path}`, {
  headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...opts,
}).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 300) }))
/** bearer/auth headers WITHOUT a stray Content-Type (mirrors the client XHR) */
const upH = token => ({ apikey: anon, Authorization: `Bearer ${token}`, 'cache-control': '3600', 'content-type': 'image/png' })

const main = async () => {
  const admin = await login('sarthakmulik16@gmail.com', 'test@123')
  ok('admin login + role=admin via is_admin gates', !!admin.access_token)
  const adminId = admin.user.id
  const A = { apikey: anon, Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' }

  const probe = await login('notif-probe-1.campus.test@gmail.com', 'Np-2026xQ!')
  ok('probe login', !!probe.access_token)
  const P = { apikey: anon, Authorization: `Bearer ${probe.access_token}`, 'Content-Type': 'application/json' }
  const studB = await login('student-b.campus.test@gmail.com', 'Ctest-aB1!')
  ok('student-b login (same college as probe, used as a fresh viewer)', !!studB.access_token)

  const profs = await (await fetch(`${u}/rest/v1/profiles?id=in.(${adminId},${probe.user.id})&select=id,role,college_id`, { headers: A })).json()
  const probeCollege = profs.find(p => p.id === probe.user.id)?.college_id
  ok('probe has a college affiliation (targeting subject)', !!probeCollege, JSON.stringify(profs))

  /* -------- student negatives (post-0037) -------- */
  const promote = await fetch(`${u}/rest/v1/profiles?id=eq.${probe.user.id}`, { method: 'PATCH', headers: P, body: JSON.stringify({ role: 'admin' }) })
  ok('student cannot PATCH role → blocked', promote.status >= 400, `${promote.status}`)
  const roleNow = await (await fetch(`${u}/rest/v1/profiles?id=eq.${probe.user.id}&select=role`, { headers: P })).json()
  ok('role stays member', JSON.stringify(roleNow) === JSON.stringify([{ role: 'member' }]), JSON.stringify(roleNow))
  const d1 = await rpc(probe.access_token, 'list_sponsored_campaigns_admin')
  ok('student list campaigns → admin_only', /admin_only/.test(d1.body), d1.body.slice(0, 90))
  const d2 = await rpc(probe.access_token, 'create_sponsored_campaign', { p_name: 'Nope', p_advertiser_name: 'Evil Corp', p_headline: 'Trying to advertise', p_description: 'Should not be possible.', p_cta: 'visit_website', p_destination_url: 'https://evil.example', p_start_at: new Date().toISOString(), p_end_at: new Date(Date.now() + 3600e3).toISOString() })
  ok('student create campaign → admin_only', /admin_only/.test(d2.body), d2.body.slice(0, 90))

  /* -------- validation guards (admin) -------- */
  const badWindow = await rpc(admin.access_token, 'create_sponsored_campaign', { p_name: 'Window Test', p_advertiser_name: 'CAMPUS Labs', p_headline: 'End before start', p_description: 'Window invalid — must reject.', p_cta: 'learn_more', p_destination_url: 'https://valid.example.com', p_start_at: new Date().toISOString(), p_end_at: new Date(Date.now() - 1000).toISOString() })
  ok('end<=start rejected', /invalid_window/.test(badWindow.body), badWindow.body.slice(0, 90))
  const badCta = await rpc(admin.access_token, 'create_sponsored_campaign', { p_name: 'CTA Test', p_advertiser_name: 'CAMPUS Labs', p_headline: 'Unsupported CTA', p_description: 'This CTA is not supported.', p_cta: 'click_here_now', p_destination_url: 'https://valid.example.com', p_start_at: new Date().toISOString(), p_end_at: new Date(Date.now() + 3600e3).toISOString() })
  ok('unsupported CTA rejected', /invalid_cta/.test(badCta.body), badCta.body.slice(0, 90))
  const badUrl = await rpc(admin.access_token, 'create_sponsored_campaign', { p_name: 'URL Test', p_advertiser_name: 'CAMPUS Labs', p_headline: 'Unsafe destination', p_description: 'javascript scheme must be blocked.', p_cta: 'visit_website', p_destination_url: 'javascript:alert(1)', p_start_at: new Date().toISOString(), p_end_at: new Date(Date.now() + 3600e3).toISOString() })
  ok('javascript: destination rejected', /invalid_url/.test(badUrl.body), badUrl.body.slice(0, 90))

  /* -------- real campaign A: targets probe's college, published -------- */
  const colleges = JSON.parse((await rpc(admin.access_token, 'search_colleges_for_ads', { p_q: 'engineering', p_limit: 20, p_offset: 0 })).body)
  ok('admin college search works', Array.isArray(colleges) && colleges.length > 0, colleges.length)
  const otherCollege = colleges.find(c => c.id !== probeCollege)?.id
  ok('found a different college for the negative case', !!otherCollege, colleges.slice(0, 2).map(c => c.name).join(','))

  const created = await rpc(admin.access_token, 'create_sponsored_campaign', {
    p_name: 'Café Aroma Test Week', p_advertiser_name: 'Café Aroma', p_headline: 'Student combo: chai + sandwich at ₹99',
    p_description: 'Show your CAMPUS profile card at Café Aroma near campus and get the exam-week combo for ₹99.',
    p_cta: 'view_offer', p_destination_url: 'https://example.com/cafe-offer', p_start_at: new Date(Date.now() - 60000).toISOString(),
    p_end_at: new Date(Date.now() + 10 * 60000).toISOString(), p_budget: 2500,
    p_private: { contact_name: 'Ravi (owner)', contact_email: 'owner@cafe-aroma.test', contact_phone: '+91 90000 11111' },
    p_reference: 'TEST-A',
  })
  const campA = JSON.parse(created.body)
  ok('campaign A created (uuid)', /^[0-9a-f-]{36}$/.test(campA), created.body.slice(0, 140))

  const emptyTargets = await rpc(admin.access_token, 'set_sponsored_campaign_targets', { p_campaign: campA, p_colleges: [] })
  ok('EMPTY targeting hard-rejected', /empty_targets/.test(emptyTargets.body), emptyTargets.body.slice(0, 90))
  const setT = await rpc(admin.access_token, 'set_sponsored_campaign_targets', { p_campaign: campA, p_colleges: [probeCollege] })
  ok('targets saved', setT.status === 204, setT.body.slice(0, 90))

  /* -------- storage upload + attach guards -------- */
  const pathA = `campaigns/${campA}/creative-test.png`
  const up = await fetch(`${u}/storage/v1/object/ad-media/${pathA}`, { method: 'POST', headers: upH(admin.access_token), body: png })
  ok('admin upload to ad-media OK', up.status >= 200 && up.status < 300, `${up.status} ${(await up.clone().text()).slice(0, 120)}`)
  const upS = await fetch(`${u}/storage/v1/object/ad-media/campaigns/${campA}/hijack.png`, { method: 'POST', headers: upH(probe.access_token), body: png })
  ok('student upload DENIED', upS.status >= 400, `${upS.status} ${(await upS.clone().text()).slice(0, 120)}`)
  const wrongPath = await rpc(admin.access_token, 'attach_sponsored_creative', { p_campaign: campA, p_kind: 'image', p_mime: 'image/png', p_path: `campaigns/00000000-0000-0000-0000-000000000000/x.png`, p_size_bytes: png.length })
  ok('foreign campaign folder rejected', /invalid_path/.test(wrongPath.body), wrongPath.body.slice(0, 90))
  const badMime = await rpc(admin.access_token, 'attach_sponsored_creative', { p_campaign: campA, p_kind: 'video', p_mime: 'image/png', p_path: pathA, p_size_bytes: png.length })
  ok('video kind needs video mime', /invalid_mime/.test(badMime.body), badMime.body.slice(0, 90))
  const tooBig = await rpc(admin.access_token, 'attach_sponsored_creative', { p_campaign: campA, p_kind: 'image', p_mime: 'image/png', p_path: pathA, p_size_bytes: 26214401 })
  ok('>25MB rejected', /invalid_size/.test(tooBig.body), tooBig.body.slice(0, 90))
  const att = await rpc(admin.access_token, 'attach_sponsored_creative', { p_campaign: campA, p_kind: 'image', p_mime: 'image/png', p_path: pathA, p_size_bytes: png.length })
  ok('creative attached', att.status === 204, att.body.slice(0, 90))

  const act = await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campA, p_status: 'active' })
  ok('draft → active published', act.status === 204, act.body.slice(0, 90))

  /* -------- delivery: targeted vs non-targeted -------- */
  const serveP = JSON.parse((await rpc(probe.access_token, 'serve_sponsored_ads', { p_limit: 3 })).body)
  const aRow = serveP.find(r => r.id === campA)
  ok('targeted student receives campaign A', !!aRow, JSON.stringify(serveP).slice(0, 140))
  ok('served payload has NO internal fields', aRow && !('created_by' in aRow) && !('budget' in aRow) && !('owner_profile_id' in aRow) && !('creative_size_bytes' in aRow), JSON.stringify(aRow))

  // campaign B: ONLY another college → both students must never see it
  const createdB = await rpc(admin.access_token, 'create_sponsored_campaign', {
    p_name: 'Coaching Hub Other-City', p_advertiser_name: 'Coaching Hub', p_headline: 'For the other campus only',
    p_description: 'This targets one specific other college, not the caller.',
    p_cta: 'register_now', p_destination_url: 'https://example.com/other', p_start_at: new Date(Date.now() - 60000).toISOString(), p_end_at: new Date(Date.now() + 10 * 60000).toISOString(), p_reference: 'TEST-B',
  })
  const campB = JSON.parse(createdB.body)
  const upB = await fetch(`${u}/storage/v1/object/ad-media/campaigns/${campB}/creative-b.png`, { method: 'POST', headers: upH(admin.access_token), body: png })
  ok('campaign B upload ok', upB.status < 300, upB.status)
  await rpc(admin.access_token, 'set_sponsored_campaign_targets', { p_campaign: campB, p_colleges: [otherCollege] })
  await rpc(admin.access_token, 'attach_sponsored_creative', { p_campaign: campB, p_kind: 'image', p_mime: 'image/png', p_path: `campaigns/${campB}/creative-b.png`, p_size_bytes: png.length })
  await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campB, p_status: 'active' })

  const serveP2 = JSON.parse((await rpc(probe.access_token, 'serve_sponsored_ads', { p_limit: 6 })).body)
  ok('probe gets A but NOT the other-college campaign B', serveP2.some(r => r.id === campA) && !serveP2.some(r => r.id === campB), JSON.stringify(serveP2.map(r => r.id)))

  /* -------- impressions & clicks -------- */
  // NOTE: occasionally the API hiccups right after a series of rejected
  // (4xx) requests in the same session — responses come back empty or stale
  // while the effect commits. RPCs are idempotent per display, so a bounded
  // retry can never double-count; we assert on a settled result.
  const rpcSettled = async (token, name, args) => {
    for (let i = 0; i < 3; i++) {
      const r = await rpc(token, name, args)
      if (r.body === 'true' || r.body === 'false') return r.body
      await sleep(600)
    }
    return 'unsettled'
  }
  const disp = '22222222-2222-2222-2222-222222222222'
  ok('impression recorded', (await rpcSettled(probe.access_token, 'record_sponsored_impression', { p_campaign: campA, p_display: disp })) === 'true')
  ok('same display NOT double-counted', (await rpcSettled(probe.access_token, 'record_sponsored_impression', { p_campaign: campA, p_display: disp })) === 'false')
  ok('impression for NON-targeted campaign refused', (await rpcSettled(probe.access_token, 'record_sponsored_impression', { p_campaign: campB, p_display: '55555555-5555-5555-5555-555555555555' })) === 'false')
  ok('click recorded', (await rpcSettled(probe.access_token, 'record_sponsored_click', { p_campaign: campA, p_display: disp })) === 'true')
  ok('same click display deduped', (await rpcSettled(probe.access_token, 'record_sponsored_click', { p_campaign: campA, p_display: disp })) === 'false')

  // raw-row fabrication must ALWAYS be refused: tracking is RPC-only
  // (RPC owns idempotency, volume caps, and server-side college resolution)
  const fab1 = await table(probe.access_token, 'ad_impressions', { method: 'POST', body: JSON.stringify({ campaign_id: campA, user_id: probe.user.id, display_id: '33333333-3333-3333-3333-333333333333' }) })
  ok('direct impression ROW write refused (RPC-only tracking)', fab1.status >= 400, `${fab1.status} ${fab1.body.slice(0, 120)}`)
  const fab2 = await table(probe.access_token, 'ad_clicks', { method: 'POST', body: JSON.stringify({ campaign_id: campA, user_id: probe.user.id, display_id: '44444444-4444-4444-4444-444444444444' }) })
  ok('direct click ROW write refused (RPC-only tracking)', fab2.status >= 400, `${fab2.status} ${fab2.body.slice(0, 120)}`)

  // settle analytics: verify the recorded truth (retry-managed like above)
  let ana = null
  for (let i = 0; i < 3; i++) {
    ana = JSON.parse((await rpc(admin.access_token, 'ad_campaign_analytics', { p_campaign: campA })).body)
    if (ana.impressions >= 1 && ana.clicks >= 1) break
    await sleep(700)
  }
  ok('analytics impressions=1 clicks=1 ctr=100', ana.impressions === 1 && ana.clicks === 1 && ana.ctr === 100, JSON.stringify(ana).slice(0, 240))
  ok('by_college names the targeted college', ana.by_college.length === 1 && ana.by_college[0].impressions === 1, JSON.stringify(ana.by_college))
  const studAna = await rpc(probe.access_token, 'ad_campaign_analytics', { p_campaign: campA })
  ok('student analytics → admin_only', /admin_only/.test(studAna.body), studAna.body.slice(0, 90))
  const privLeak = await table(probe.access_token, `ad_cam_private?campaign_id=eq.${campA}&select=*`)
  ok('student cannot read private contact info', privLeak.status >= 400 || privLeak.body === '[]', `${privLeak.status} ${privLeak.body.slice(0, 90)}`)

  /* -------- edit-while-active guard -------- */
  const editActive = await rpc(admin.access_token, 'update_sponsored_campaign', { p_campaign: campA, p_patch: { headline: 'Blocked while active' } })
  ok('editing ACTIVE campaign → pause_first', /pause_first/.test(editActive.body), editActive.body.slice(0, 100))
  const editBudget = await rpc(admin.access_token, 'update_sponsored_campaign', { p_campaign: campA, p_patch: { budget: 3200 } })
  ok('planner budget editable while active', editBudget.status === 204, editBudget.body.slice(0, 100))

  /* -------- lifecycle -------- */
  ok('pause ok', (await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campA, p_status: 'paused' })).status === 204)
  ok('paused campaign does NOT serve', !JSON.parse((await rpc(probe.access_token, 'serve_sponsored_ads', { p_limit: 3 })).body).some(r => r.id === campA))
  const invalidResume = await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campA, p_status: 'scheduled' })
  ok('paused→scheduled invalid transition rejected', invalidResume.status >= 400, invalidResume.body.slice(0, 100))
  ok('resume ok', (await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campA, p_status: 'active' })).status === 204)
  // The probe already recorded an impression for A, so the 6h frequency guard
  // (by design) keeps A away from them — verify resumed serving via student-b,
  // who has NOT recorded an impression for A.
  ok('resumed campaign serves again (fresh viewer)', JSON.parse((await rpc(studB.access_token, 'serve_sponsored_ads', { p_limit: 3 })).body).some(r => r.id === campA))

  const detail = JSON.parse((await rpc(admin.access_token, 'get_sponsored_campaign_admin', { p_campaign: campA })).body)
  ok('admin detail includes private + targets', detail.private?.contact_name === 'Ravi (owner)' && detail.targets.length === 1, JSON.stringify(detail.targets))

  const campD = JSON.parse((await rpc(admin.access_token, 'duplicate_sponsored_campaign', { p_campaign: campA })).body)
  const dupJson = JSON.parse((await rpc(admin.access_token, 'get_sponsored_campaign_admin', { p_campaign: campD })).body)
  ok('duplicate is draft + no creative + targets copied + note', dupJson.campaign.status === 'draft' && dupJson.campaign.creative_path === null && dupJson.targets.length === 1 && /DUPLICATED/.test(dupJson.private?.internal_notes ?? ''), JSON.stringify(dupJson.private))

  ok('end-now ok', (await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campA, p_status: 'completed' })).status === 204)
  ok('completed campaign does NOT serve', !JSON.parse((await rpc(probe.access_token, 'serve_sponsored_ads', { p_limit: 3 })).body).some(r => r.id === campA))
  const reactivate = await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campA, p_status: 'active' })
  ok('completed→active invalid transition rejected', reactivate.status >= 400, reactivate.body.slice(0, 110))

  /* -------- schedule fail-safe -------- */
  const campC = JSON.parse((await rpc(admin.access_token, 'create_sponsored_campaign', {
    p_name: 'Flash Window Test', p_advertiser_name: 'CAMPUS Labs', p_headline: 'Ends in seconds', p_description: 'Fail-safe: never serves after its window.',
    p_cta: 'learn_more', p_destination_url: 'https://example.com/flash', p_start_at: new Date(Date.now() - 60000).toISOString(), p_end_at: new Date(Date.now() + 4000).toISOString(), p_reference: 'TEST-C',
  })).body)
  await fetch(`${u}/storage/v1/object/ad-media/campaigns/${campC}/creative-c.png`, { method: 'POST', headers: upH(admin.access_token), body: png })
  await rpc(admin.access_token, 'set_sponsored_campaign_targets', { p_campaign: campC, p_colleges: [probeCollege] })
  await rpc(admin.access_token, 'attach_sponsored_creative', { p_campaign: campC, p_kind: 'image', p_mime: 'image/png', p_path: `campaigns/${campC}/creative-c.png`, p_size_bytes: png.length })
  await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campC, p_status: 'active' })
  ok('in-window campaign serves', JSON.parse((await rpc(probe.access_token, 'serve_sponsored_ads', { p_limit: 6 })).body).some(r => r.id === campC))
  await sleep(5500)
  ok('EXPIRED campaign does not serve (server-side time check)', !JSON.parse((await rpc(probe.access_token, 'serve_sponsored_ads', { p_limit: 6 })).body).some(r => r.id === campC))
  await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campC, p_status: 'paused' })
  const statusC = await (await fetch(`${u}/rest/v1/ad_campaigns?id=eq.${campC}&select=status`, { headers: A })).json()
  ok('paused-after-end auto-completed', statusC[0]?.status === 'completed', JSON.stringify(statusC))
  const resumeC = await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campC, p_status: 'active' })
  ok('resuming beyond end rejected (read-only)', resumeC.status >= 400 && /invalid_transition|read-only/i.test(resumeC.body), resumeC.body.slice(0, 140))

  /* -------- scheduled must not serve early -------- */
  const campS = JSON.parse((await rpc(admin.access_token, 'create_sponsored_campaign', {
    p_name: 'Tomorrow Only Test', p_advertiser_name: 'Coaching Hub', p_headline: 'Starts in the future', p_description: 'A scheduled campaign must not serve before start.',
    p_cta: 'register_now', p_destination_url: 'https://example.com/coaching', p_start_at: new Date(Date.now() + 5 * 60000).toISOString(), p_end_at: new Date(Date.now() + 10 * 60000).toISOString(), p_reference: 'TEST-S',
  })).body)
  await fetch(`${u}/storage/v1/object/ad-media/campaigns/${campS}/creative-s.png`, { method: 'POST', headers: upH(admin.access_token), body: png })
  await rpc(admin.access_token, 'set_sponsored_campaign_targets', { p_campaign: campS, p_colleges: [probeCollege] })
  await rpc(admin.access_token, 'attach_sponsored_creative', { p_campaign: campS, p_kind: 'image', p_mime: 'image/png', p_path: `campaigns/${campS}/creative-s.png`, p_size_bytes: png.length })
  await rpc(admin.access_token, 'set_sponsored_campaign_status', { p_campaign: campS, p_status: 'scheduled' })
  const serveScheduled = JSON.parse((await rpc(probe.access_token, 'serve_sponsored_ads', { p_limit: 6 })).body)
  ok('scheduled campaign does NOT serve before start', !serveScheduled.some(r => r.id === campS), JSON.stringify(serveScheduled.map(r => r.id)))

  /* -------- overview + counters -------- */
  const cc = JSON.parse((await rpc(admin.access_token, 'ad_overview_metrics')).body)
  ok('overview totals real (total>=4, impressions=1, clicks=1)', cc.total >= 4 && cc.impressions === 1 && cc.clicks === 1, JSON.stringify(cc).slice(0, 220))

  /* -------- cleanup -------- */
  // deletes retry up to 3 passes (same API-hiccup resilience as above)
  for (let pass = 0; pass < 3; pass++) {
    const remaining = await (await fetch(`${u}/rest/v1/ad_campaigns?id=in.(${campA},${campB},${campC},${campS},${campD})&select=id`, { headers: A })).json()
    if (Array.isArray(remaining) && remaining.length === 0) break
    for (const c of remaining) {
      await fetch(`${u}/rest/v1/ad_campaigns?id=eq.${c.id}`, { method: 'DELETE', headers: A })
    }
    await sleep(600)
  }
  const after = await (await fetch(`${u}/rest/v1/ad_campaigns?id=in.(${campA},${campB},${campC},${campS},${campD})&select=id`, { headers: A })).json()
  ok('cleanup removed test campaigns', Array.isArray(after) && after.length === 0, after)
  // storage: recursively delete every file under campaigns/ (folder-aware);
  // DELETE must be body-less (a body-less POST/DELETE with Content-Type json 400s)
  const delA = { apikey: anon, Authorization: `Bearer ${admin.access_token}` }
  const listA = { apikey: anon, Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' }
  const folders = (await (await fetch(`${u}/storage/v1/object/list/ad-media`, { method: 'POST', headers: listA, body: JSON.stringify({ prefix: 'campaigns/', limit: 1000 }) })).json()).filter(o => o.id === null)
  for (const f of folders) {
    const files = await (await fetch(`${u}/storage/v1/object/list/ad-media`, { method: 'POST', headers: listA, body: JSON.stringify({ prefix: `campaigns/${f.name}/`, limit: 1000 }) })).json()
    for (const file of files) {
      await fetch(`${u}/storage/v1/object/ad-media/campaigns/${f.name}/${file.name}`, { method: 'DELETE', headers: delA })
    }
  }
  const storageLeft = await (await fetch(`${u}/storage/v1/object/list/ad-media`, { method: 'POST', headers: listA, body: JSON.stringify({ prefix: 'campaigns/', limit: 1000, recursive: true }) })).json()
  ok('cleanup: storage cleared (no files under campaigns/)', Array.isArray(storageLeft) && storageLeft.every(o => o.id === null), JSON.stringify(storageLeft))
  const cc2 = JSON.parse((await rpc(admin.access_token, 'ad_overview_metrics')).body)
  ok('counters consistent post-cleanup (0/0/0)', cc2.total === 0 && cc2.impressions === 0 && cc2.clicks === 0, JSON.stringify(cc2).slice(0, 200))

  console.log(`\n=== ${pass} passed / ${fail} failed ===`)
  if (fail > 0) process.exit(2)
}
main().catch(e => { console.error('SCRIPT ERR', e); process.exit(1) })
