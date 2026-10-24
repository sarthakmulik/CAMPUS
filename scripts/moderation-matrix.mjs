// ============================================================================
// scripts/moderation-matrix.mjs — live verification for 0044 Moderation Center
//
// Round-trips against the REAL database with anon-key + password-grant JWTs
// only (no service-role key):
//   1. gates       — members/anon rejected on every 0044 RPC (42501-style)
//   2. queue       — a real report (probe → studentB) appears with honest fields
//   3. triage      — reviewing → resolved → re-open → dismissed (+ reviewed_by)
//   4. warn        — staff_warn_user → probe's notifications 'staff_warning'
//   5. content     — staff_moderate_post hide/restore, anon visibility flips
//   6. audit       — every mutation lands in staff_audit_log
//   7. cleanup     — probe deletes its matrix post (report/notification stay:
//                    reports have no delete path by design — honest history)
//
//   node scripts/moderation-matrix.mjs
// ============================================================================

const SUPABASE_URL = 'https://ggjdhqokzdidmucvxrgz.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnamRocW9remRpZG11Y3Z4cmd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTI5ODMsImV4cCI6MjEwNzcyODk4M30.XJrGGpSFZk6RIkKmksMfNTjaG_1SbegqPgRwCaxnsm4'

const OWNER_EMAIL = 'sarthakmulik16@gmail.com'
const OWNER_PASSWORD = 'test@123'
const PROBE_EMAIL = 'notif-probe-1.campus.test@gmail.com'
const PROBE_PASSWORD = 'Np-2026xQ!'
const PROBE_UID = 'f9500db1-a0e6-405d-8781-457c9bad5d1d'
const STUDENTB_UID = '1b345602-eca0-48b5-87cf-99eecf1fd024'
const OWNER_UID = '519a0307-d20e-44a8-a5d7-7af000dc9c47'

const MARK = `0044-matrix ${new Date().toISOString()}`

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  const suffix = detail ? ` — ${detail}` : ''
  if (ok) { passed++; console.log(`PASS ${name}${suffix}`) }
  else { failed++; console.log(`FAIL ${name}${suffix}`) }
}

function firstRow(json) { return Array.isArray(json) ? json[0] : json }

async function rest(method, path, headers, body) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: body === undefined ? headers : { ...headers, Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* 204 */ }
  return { status: res.status, json }
}

async function login(email, password) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const json = await res.json()
  if (!json.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(json)}`)
  return json.access_token
}

const msg = (r) => String(r.json?.message ?? r.json ?? '')

async function main() {
  const ownerJwt = await login(OWNER_EMAIL, OWNER_PASSWORD)
  const probeJwt = await login(PROBE_EMAIL, PROBE_PASSWORD)
  const ownerH = { apikey: ANON, Authorization: `Bearer ${ownerJwt}`, 'Content-Type': 'application/json' }
  const probeH = { apikey: ANON, Authorization: `Bearer ${probeJwt}`, 'Content-Type': 'application/json' }
  const anonH = { apikey: ANON, 'Content-Type': 'application/json' }

  // -------------------------------------------------------------------------
  // 1. gates — the moderation RPCs belong to staff only
  // -------------------------------------------------------------------------
  const n1 = await rest('POST', 'rpc/staff_list_reports', probeH, {})
  check('1.1 member cannot staff_list_reports',
    n1.status !== 200 && /moderation\.read/i.test(msg(n1)), msg(n1).slice(0, 80))

  const n2 = await rest('POST', 'rpc/staff_report_counts', probeH, {})
  check('1.2 member cannot staff_report_counts',
    n2.status !== 200 && /moderation\.read/i.test(msg(n2)), msg(n2).slice(0, 80))

  const n3 = await rest('POST', 'rpc/staff_warn_user', probeH, { p_user: STUDENTB_UID, p_note: 'nope' })
  check('1.3 member cannot staff_warn_user',
    n3.status !== 200 && /moderation\.warn/i.test(msg(n3)), msg(n3).slice(0, 80))

  const n4 = await rest('POST', 'rpc/staff_report_review', probeH, { p_report: crypto.randomUUID(), p_status: 'dismissed' })
  check('1.4 member cannot staff_report_review',
    n4.status !== 200 && /moderation\.act/i.test(msg(n4)), msg(n4).slice(0, 80))

  const n5 = await rest('POST', 'rpc/staff_moderate_post', probeH, { p_post: crypto.randomUUID() })
  check('1.5 member cannot staff_moderate_post',
    n5.status !== 200 && /moderation\.act/i.test(msg(n5)), msg(n5).slice(0, 80))

  const n6 = await rest('POST', 'rpc/staff_report_counts', anonH, {})
  check('1.6 anon cannot staff_report_counts', n6.status !== 200, `status ${n6.status}`)

  const o1 = await rest('POST', 'rpc/staff_list_reports', ownerH, { p_status: 'weird' })
  check('1.7 owner: bad status filter rejected (22023)',
    o1.status === 400 && /unknown status/i.test(msg(o1)), msg(o1).slice(0, 80))

  // -------------------------------------------------------------------------
  // 2. seed — a real report filed by the probe on studentB (person subject)
  // -------------------------------------------------------------------------
  const seed = await rest('POST', 'rpc/submit_report', probeH, {
    p_reason: 'moderation matrix round-trip',
    p_reported_user_id: STUDENTB_UID,
    p_details: MARK,
  })
  check('2.1 probe can submit a report (member path intact)', seed.status === 200, msg(seed).slice(0, 80))

  const q0 = await rest('POST', 'rpc/staff_list_reports', ownerH, { p_status: 'open', p_limit: 100 })
  const openRows = Array.isArray(q0.json) ? q0.json : []
  const mine = openRows.find(r => r.details === MARK)
  check('2.2 owner queue shows the new report with subject person', Boolean(mine)
    && mine?.subject_kind === 'person'
    && mine?.status === 'open'
    && mine?.reported_user_id === STUDENTB_UID
    && mine?.reporter_username === 'notifprobe1campustest',
    mine ? `report ${mine.report_id}` : 'report not found in open queue')

  const counts0 = await rest('POST', 'rpc/staff_report_counts', ownerH, {})
  check('2.3 open counts include the matrix report',
    counts0.status === 200 && (counts0.json?.open ?? 0) >= 1 && (counts0.json?.dismissed ?? -1) >= 0,
    JSON.stringify(counts0.json))

  const other = await rest('POST', 'rpc/staff_list_reports', ownerH, { p_status: 'dismissed', p_limit: 100 })
  check('2.4 status filters are actually filtering',
    mine && !(Array.isArray(other.json) ? other.json : []).some(r => r.report_id === mine.report_id), '')

  // -------------------------------------------------------------------------
  // 3. triage round-trip — reviewing → resolved → open → dismissed
  // -------------------------------------------------------------------------
  let t1 = await rest('POST', 'rpc/staff_report_review', ownerH, { p_report: mine.report_id, p_status: 'reviewing' })
  check('3.1 review → reviewing', t1.status === 200 && t1.json === 'reviewing', msg(t1).slice(0, 60))

  const qReview = await rest('POST', 'rpc/staff_list_reports', ownerH, { p_status: 'reviewing', p_limit: 100 })
  const reviewedRow = (Array.isArray(qReview.json) ? qReview.json : []).find(r => r.report_id === mine.report_id)
  check('3.2 triaged row stamps @campus reviewed_by/at', Boolean(reviewedRow)
    && reviewedRow?.reviewed_by_username === 'campus'
    && Boolean(reviewedRow?.reviewed_at), '')

  t1 = await rest('POST', 'rpc/staff_report_review', ownerH, { p_report: mine.report_id, p_status: 'resolved', p_note: 'handled in matrix' })
  check('3.3 resolve with note', t1.status === 200 && t1.json === 'resolved', '')

  t1 = await rest('POST', 'rpc/staff_report_review', ownerH, { p_report: mine.report_id, p_status: 'open' })
  check('3.4 re-open works', t1.status === 200 && t1.json === 'open', '')

  t1 = await rest('POST', 'rpc/staff_report_review', ownerH, { p_report: mine.report_id, p_status: 'dismissed' })
  check('3.5 final state dismissed (honest history, no delete path)', t1.status === 200 && t1.json === 'dismissed', '')

  const bad = await rest('POST', 'rpc/staff_report_review', ownerH, { p_report: mine.report_id, p_status: 'shredded' })
  check('3.6 illegal status rejected (22023)',
    bad.status === 400 && /unknown status/i.test(msg(bad)), msg(bad).slice(0, 80))

  // -------------------------------------------------------------------------
  // 4. warn — staff_warn_user → probe notification
  // -------------------------------------------------------------------------
  const w0 = await rest('POST', 'rpc/staff_warn_user', ownerH, { p_user: PROBE_UID, p_note: '   ' })
  check('4.1 empty warning note rejected', w0.status === 400 && /needs a note/i.test(msg(w0)), msg(w0).slice(0, 80))

  const w1 = await rest('POST', 'rpc/staff_warn_user', ownerH, { p_user: OWNER_UID, p_note: 'trying staff' })
  check('4.2 staff cannot be warned', w1.status === 400 && /staff_remove/i.test(msg(w1)), msg(w1).slice(0, 80))

  const w2 = await rest('POST', 'rpc/staff_warn_user', ownerH, {
    p_user: PROBE_UID, p_note: `${MARK} — keep posts guideline-friendly`,
  })
  check('4.3 owner warns the probe (member target)', w2.status === 200 && w2.json === 'warned', msg(w2).slice(0, 60))

  const seen = await rest('GET',
    `notifications?recipient_id=eq.${PROBE_UID}&type=eq.staff_warning&order=created_at.desc&limit=1&select=actor_id,metadata,created_at`, probeH)
  const warnRow = firstRow(seen.json)
  check('4.4 probe sees the staff_warning notification with the note',
    seen.status === 200 && warnRow?.actor_id === OWNER_UID
    && String(warnRow?.metadata?.note ?? '').includes(MARK), '')

  // -------------------------------------------------------------------------
  // 5. content moderation — hide/restore a real probe post, watch anon view
  // -------------------------------------------------------------------------
  const mk = await rest('POST', 'posts', probeH, {
    author_id: PROBE_UID, body: `${MARK} — matrix post`, is_anonymous: false, kind: 'post',
  })
  const postRow = firstRow(mk.json)
  check('5.1 probe publishes a post (member path intact)',
    mk.status === 201 && Boolean(postRow?.id), msg(mk).slice(0, 60))

  const anonSees0 = await rest('GET', `posts?id=eq.${postRow.id}&select=id`, anonH)
  check('5.2 anon sees the live post',
    anonSees0.status === 200 && (anonSees0.json?.length ?? 0) === 1, '')

  const h1 = await rest('POST', 'rpc/staff_moderate_post', ownerH, { p_post: postRow.id, p_unpublish: true, p_note: 'matrix hide' })
  check('5.3 owner hides the post', h1.status === 200 && h1.json === 'hidden', msg(h1).slice(0, 60))

  const anonSees1 = await rest('GET', `posts?id=eq.${postRow.id}&select=id`, anonH)
  check('5.4 anon can no longer see the unpublished post',
    anonSees1.status === 200 && (anonSees1.json?.length ?? 0) === 0, '')

  const h2 = await rest('POST', 'rpc/staff_moderate_post', ownerH, { p_post: postRow.id, p_unpublish: true })
  check('5.5 hiding a hidden post is rejected honestly',
    h2.status === 400 && /already hidden/i.test(msg(h2)), msg(h2).slice(0, 60))

  const h3 = await rest('POST', 'rpc/staff_moderate_post', ownerH, { p_post: postRow.id, p_unpublish: false })
  check('5.6 restore works', h3.status === 200 && h3.json === 'live', '')

  const anonSees2 = await rest('GET', `posts?id=eq.${postRow.id}&select=id`, anonH)
  check('5.7 anon sees it again after restore',
    anonSees2.status === 200 && (anonSees2.json?.length ?? 0) === 1, '')

  // -------------------------------------------------------------------------
  // 6. audit trail — every mutation wrote a row
  // -------------------------------------------------------------------------
  const audit = await rest('GET',
    `staff_audit_log?action=in.(moderation.report_status,moderation.warn,moderation.post_hidden,moderation.post_restored)&select=action,actor_id,target_id,metadata&order=created_at.desc&limit=40`, ownerH)
  const auditRows = Array.isArray(audit.json) ? audit.json : []
  const actorOk = auditRows.every(r => r.actor_id === OWNER_UID)
  check('6.1 owner reads all four moderation audit actions',
    audit.status === 200
      && auditRows.some(r => r.action === 'moderation.warn')
      && auditRows.some(r => r.action === 'moderation.post_hidden')
      && auditRows.some(r => r.action === 'moderation.post_restored')
      && auditRows.some(r => r.action === 'moderation.report_status')
      && actorOk, `${auditRows.length} rows`)

  const auditDeny = await rest('GET', 'staff_audit_log?select=action', probeH)
  check('6.2 member audit read returns nothing (RLS)',
    auditDeny.status === 200 && Array.isArray(auditDeny.json) && auditDeny.json.length === 0, '')

  // -------------------------------------------------------------------------
  // 7. cleanup — probe deletes its matrix post
  // -------------------------------------------------------------------------
  const del = await rest('DELETE', `posts?id=eq.${postRow.id}`, probeH)
  check('7.1 probe cleans up the matrix post', del.status === 204 || del.status === 200, `status ${del.status}`)

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
