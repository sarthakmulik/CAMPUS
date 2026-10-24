// ============================================================================
// scripts/staff-matrix.mjs — live verification for the 0043 staff foundation
//
// Identity reality (verified): sarthakmulik16@gmail.com IS the @campus owner
// account — ONE auth user (519a0307…), profiles.username='campus',
// role='super_admin'. It doubles as the super-admin test session; the probe
// student (f9500db1…) is the staff-mechanics target: provisioned as an admin
// tier, scope-tightened, revoked, suspended, restored — then everything is
// cleaned up.
//
// Runs with anon-key + password-grant JWTs only (no service-role key).
//   node scripts/staff-matrix.mjs
// ============================================================================

const SUPABASE_URL = 'https://ggjdhqokzdidmucvxrgz.supabase.co'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnamRocW9remRpZG11Y3Z4cmd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTI5ODMsImV4cCI6MjEwNzcyODk4M30.XJrGGpSFZk6RIkKmksMfNTjaG_1SbegqPgRwCaxnsm4'

const OWNER_EMAIL = 'sarthakmulik16@gmail.com'
const OWNER_PASSWORD = 'test@123'
const PROBE_EMAIL = 'notif-probe-1.campus.test@gmail.com'
const PROBE_PASSWORD = 'Np-2026xQ!'
const PROBE_UID = 'f9500db1-a0e6-405d-8781-457c9bad5d1d'

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

async function main() {
  const ownerJwt = await login(OWNER_EMAIL, OWNER_PASSWORD)
  const probeJwt = await login(PROBE_EMAIL, PROBE_PASSWORD)
  const ownerH = { apikey: ANON, Authorization: `Bearer ${ownerJwt}`, 'Content-Type': 'application/json' }
  const probeH = { apikey: ANON, Authorization: `Bearer ${probeJwt}`, 'Content-Type': 'application/json' }
  const anonH = { apikey: ANON, 'Content-Type': 'application/json' }

  // -------------------------------------------------------------------------
  // 1. roster / owner bootstrap
  // -------------------------------------------------------------------------
  const roster0 = await rest('GET', 'staff_accounts?select=user_id,tier,scopes,title,is_active,revoked_at', ownerH)
  const rows0 = Array.isArray(roster0.json) ? roster0.json : []
  const ownerRow = rows0.find(r => r.user_id === '519a0307-d20e-44a8-a5d7-7af000dc9c47')
  check('1.1 owner staff row active, tier super_admin, * scopes',
    Boolean(ownerRow?.is_active) && ownerRow?.tier === 'super_admin' && ownerRow?.scopes?.includes('*'), '')

  const campusProfile = await rest('GET', 'profiles?username=eq.campus&select=id,role,college_id', ownerH)
  const campusRow = firstRow(campusProfile.json)
  const OWNER_UID = campusRow?.id
  check('1.2 @campus role=super_admin, no college',
    campusRow?.role === 'super_admin' && campusRow?.college_id === null, '')

  const probeProfile0 = await rest('GET', `profiles?id=eq.${PROBE_UID}&select=role,account_status`, ownerH)
  const probeRow0 = firstRow(probeProfile0.json)
  check('1.3 probe starts as a plain active member',
    probeRow0?.role === 'member' && probeRow0?.account_status === 'active', '')

  // -------------------------------------------------------------------------
  // 2. RLS isolation of the staff tier (0043a roster gate)
  // -------------------------------------------------------------------------
  const probeRoster = await rest('GET', 'staff_accounts?select=user_id', probeH)
  check('2.1 member cannot read staff_accounts (RLS)', probeRoster.status === 200
    && Array.isArray(probeRoster.json) && probeRoster.json.length === 0, '')

  const probeRosterRpc = await rest('POST', 'rpc/staff_list', probeH, {})
  check('2.2 member gets zero rows from staff_list RPC', probeRosterRpc.status === 200
    && Array.isArray(probeRosterRpc.json) && probeRosterRpc.json.length === 0, '')

  // -------------------------------------------------------------------------
  // 3. has_op semantics — owner tier
  // -------------------------------------------------------------------------
  const o1 = await rest('POST', 'rpc/has_op', ownerH, { p_op: 'ads.create' })
  check('3.1 owner holds ads.* (implicit *)', o1.status === 200 && o1.json === true, '')
  const o2 = await rest('POST', 'rpc/has_op', ownerH, { p_op: 'moderation.suspend' })
  check('3.2 owner holds moderation.suspend', o2.status === 200 && o2.json === true, '')
  const o3 = await rest('POST', 'rpc/has_op', ownerH, { p_op: 'staff.read' })
  check('3.3 owner holds staff.read', o3.status === 200 && o3.json === true, '')
  const o4 = await rest('POST', 'rpc/has_op', ownerH, { p_op: 'staff.provision' })
  check('3.4 owner holds staff.provision', o4.status === 200 && o4.json === true, '')
  const o5 = await rest('POST', 'rpc/has_op', ownerH, { p_op: 'does.not.exist' })
  check('3.5 owner holds even unknown ops (*)', o5.status === 200 && o5.json === true, '')
  const m1 = await rest('POST', 'rpc/has_op', probeH, { p_op: 'moderation.suspend' })
  check('3.6 member holds no ops at all', m1.status === 200 && m1.json === false, '')

  // -------------------------------------------------------------------------
  // 4. hard gates — members cannot touch staff mechanics
  // -------------------------------------------------------------------------
  const n1 = await rest('POST', 'rpc/staff_provision', probeH, { p_user: PROBE_UID })
  check('4.1 member cannot staff_provision',
    n1.status !== 200 && /super admin/i.test(String(n1.json?.message ?? '')), String(n1.json?.message ?? '').slice(0, 80))

  const n2 = await rest('POST', 'rpc/member_suspend', probeH, { p_user: PROBE_UID, p_reason: 'nope' })
  check('4.2 member cannot member_suspend',
    n2.status !== 200 && /moderation.suspend/i.test(String(n2.json?.message ?? '')), String(n2.json?.message ?? '').slice(0, 80))

  const n3 = await rest('POST', 'rpc/staff_remove', ownerH, { p_user: PROBE_UID })
  check('4.3 owner cannot revoke a non-staff account',
    n3.status !== 200 && /not an active staff member/i.test(String(n3.json?.message ?? '')), String(n3.json?.message ?? '').slice(0, 80))

  const rolePatch = await rest('PATCH', `profiles?id=eq.${PROBE_UID}`, probeH, { role: 'admin' })
  const roleAfter = await rest('GET', `profiles?id=eq.${PROBE_UID}&select=role`, probeH)
  check('4.4 member cannot PATCH own role (0037 lock intact)',
    firstRow(roleAfter.json)?.role === 'member' && rolePatch.status !== 204, `HTTP ${rolePatch.status}`)

  // -------------------------------------------------------------------------
  // 5. provisioning round-trip (owner provisions the probe as admin tier)
  // -------------------------------------------------------------------------
  const launch = await rest('POST', 'rpc/staff_provision', ownerH,
    { p_user: PROBE_UID, p_tier: 'admin', p_title: 'Matrix Test Admin' })
  check('5.1 owner provisions probe as admin tier',
    launch.status === 200 && launch.json === 'admin', String(launch.json?.message ?? ''))

  const probeProfile1 = await rest('GET', `profiles?id=eq.${PROBE_UID}&select=role,college_id`, probeH)
  const probeRow1 = firstRow(probeProfile1.json)
  check('5.2 probe profile role promoted to admin, no college',
    probeRow1?.role === 'admin' && probeRow1?.college_id === null, '')

  const roster1 = await rest('GET', 'staff_accounts?select=user_id,tier,is_active', probeH)
  const probeStaffRow = (Array.isArray(roster1.json) ? roster1.json : []).find(r => r.user_id === PROBE_UID)
  check('5.3 probe now appears in the roster (staff RLS unlocked)',
    probeStaffRow?.tier === 'admin' && probeStaffRow?.is_active === true, '')

  const scav = await rest('POST', 'rpc/has_op', probeH, { p_op: 'moderation.suspend' })
  check('5.4 admin-tier probe holds moderation.suspend (default scopes)',
    scav.status === 200 && scav.json === true, '')
  const sread = await rest('POST', 'rpc/has_op', probeH, { p_op: 'staff.read' })
  check('5.5 admin-tier probe does NOT hold staff.read',
    sread.status === 200 && sread.json === false, '')

  // -------------------------------------------------------------------------
  // 6. scope tightening
  // -------------------------------------------------------------------------
  const tighten = await rest('POST', 'rpc/staff_scopes_set', ownerH,
    { p_user: PROBE_UID, p_scopes: ['ads.create'] })
  // void PL/pgSQL functions come back as 204 No Content
  check('6.1 owner tightens probe scopes to ads.create only',
    (tighten.status === 200 || tighten.status === 204), `HTTP ${tighten.status}`)

  const t1 = await rest('POST', 'rpc/has_op', probeH, { p_op: 'ads.create' })
  check('6.2 probe holds the exact granted op', t1.status === 200 && t1.json === true, '')
  const t2 = await rest('POST', 'rpc/has_op', probeH, { p_op: 'ads.refresh' })
  check('6.3 probe does NOT hold an ungranted ads op (no wildcard)', t2.status === 200 && t2.json === false, '')
  const t3 = await rest('POST', 'rpc/has_op', probeH, { p_op: 'moderation.suspend' })
  check('6.4 probe lost moderation.suspend', t3.status === 200 && t3.json === false, '')

  // -------------------------------------------------------------------------
  // 7. revoke round-trip
  // -------------------------------------------------------------------------
  const selfRevoke = await rest('POST', 'rpc/staff_remove', ownerH, { p_user: OWNER_UID })
  check('7.1 owner cannot revoke own account',
    selfRevoke.status !== 200 && /own staff account/i.test(String(selfRevoke.json?.message ?? '')), '')

  const revoke = await rest('POST', 'rpc/staff_remove', ownerH, { p_user: PROBE_UID })
  check('7.2 owner revokes probe', revoke.status === 200 && revoke.json === 'revoked', '')

  const probeProfile2 = await rest('GET', `profiles?id=eq.${PROBE_UID}&select=role,account_status`, probeH)
  const probeRow2 = firstRow(probeProfile2.json)
  check('7.3 probe demoted back to member, still active',
    probeRow2?.role === 'member' && probeRow2?.account_status === 'active', '')

  const gone = await rest('POST', 'rpc/has_op', probeH, { p_op: 'ads.create' })
  check('7.4 probe holds no ops after revoke', gone.status === 200 && gone.json === false, '')

  const roster2 = await rest('GET', `staff_accounts?select=tier,is_active,revoked_at&user_id=eq.${PROBE_UID}`, ownerH)
  const revokedRow = firstRow(roster2.json)
  check('7.5 revoked staff row kept with revoked_at (audit history)',
    revokedRow?.is_active === false && Boolean(revokedRow?.revoked_at), '')

  // -------------------------------------------------------------------------
  // 8. suspend lifecycle — write block + public hiding, reversible
  // -------------------------------------------------------------------------
  const mkPost = (body) => rest('POST', 'posts', probeH, {
    author_id: PROBE_UID, body, kind: 'post', is_anonymous: false,
    is_published: true, media_urls: [], college_id: null,
  })

  const p0 = await mkPost('staff-matrix pre-suspend probe post')
  const prePostId = firstRow(p0.json)?.id
  check('8.1 probe can post while active', p0.status === 201 && Boolean(prePostId), `HTTP ${p0.status}`)

  const suspend = await rest('POST', 'rpc/member_suspend', ownerH, { p_user: PROBE_UID, p_reason: 'staff matrix verification' })
  check('8.2 staff suspends the member', suspend.status === 200 && suspend.json === 'suspended', '')

  const sCheck = await rest('GET', `profiles?id=eq.${PROBE_UID}&select=account_status,suspended_at,suspend_reason`, ownerH)
  const sRow = firstRow(sCheck.json)
  check('8.3 suspend columns recorded with reason', sRow?.account_status === 'suspended'
    && Boolean(sRow?.suspended_at) && sRow?.suspend_reason === 'staff matrix verification', '')

  const blockedPost = await mkPost('staff-matrix must-be-blocked post')
  const blockedMsg = String(blockedPost.json?.message ?? '')
  check('8.4 suspended member write is BLOCKED (posts)',
    blockedPost.status !== 201 && /suspended/i.test(blockedMsg), `HTTP ${blockedPost.status} ${blockedMsg.slice(0, 80)}`)

  const feed = await rest('POST', 'rpc/list_public_posts', anonH, { p_limit: 50, p_offset: 0 })
  const feedRows = Array.isArray(feed.json) ? feed.json : []
  check('8.5 suspended author hidden from the public feed',
    feedRows.every(r => r.author_id !== PROBE_UID), `${feedRows.length} posts visible`)

  const board = await rest('POST', 'rpc/list_leaderboard', anonH, { p_period: 'all', p_limit: 100, p_offset: 0 })
  const boardRows = Array.isArray(board.json) ? board.json : []
  check('8.6 suspended member absent from leaderboard (all time)',
    boardRows.every(r => r.user_id !== PROBE_UID), `${boardRows.length} ranked`)

  const unsuspend = await rest('POST', 'rpc/member_unsuspend', ownerH, { p_user: PROBE_UID })
  check('8.7 staff unsuspends (reversible)', unsuspend.status === 200 && unsuspend.json === 'active', '')

  const pNew = await mkPost('staff-matrix post-unsuspend probe post')
  const newPostId = firstRow(pNew.json)?.id
  check('8.8 writes work again after unsuspend', pNew.status === 201 && Boolean(newPostId), `HTTP ${pNew.status}`)

  const feed2 = await rest('POST', 'rpc/list_public_posts', anonH, { p_limit: 50, p_offset: 0 })
  const feedRows2 = Array.isArray(feed2.json) ? feed2.json : []
  check('8.9 restored author visible again in feed',
    feedRows2.some(r => r.author_id === PROBE_UID && r.id === newPostId), '')

  // -------------------------------------------------------------------------
  // 9. staff self-protection during suspension
  // -------------------------------------------------------------------------
  const suspendSelf = await rest('POST', 'rpc/member_suspend', ownerH, { p_user: OWNER_UID, p_reason: 'nope' })
  check('9.1 staff accounts exempt from suspension',
    suspendSelf.status !== 200 && /staff|member/i.test(String(suspendSelf.json?.message ?? '')), '')

  // -------------------------------------------------------------------------
  // 10. audit trail
  // -------------------------------------------------------------------------
  const audit = await rest('GET',
    'staff_audit_log?action=in.(member.suspend,member.unsuspend)&select=action,target_id,metadata&limit=10', ownerH)
  const auditRows = Array.isArray(audit.json) ? audit.json : []
  check('10.1 suspend/unsuspend audited with metadata', auditRows.some(r => r.action === 'member.suspend'
    && r.metadata?.reason === 'staff matrix verification')
    && auditRows.some(r => r.action === 'member.unsuspend'), `${auditRows.length} rows`)

  const audit2 = await rest('GET',
    "staff_audit_log?action=in.(staff.provision,staff.scopes_set,staff.revoke)&select=action,target_id&limit=10", ownerH)
  const auditRows2 = Array.isArray(audit2.json) ? audit2.json : []
  check('10.2 provision/scopes/revoke audited for the probe',
    ['staff.provision', 'staff.scopes_set', 'staff.revoke'].every(a => auditRows2.some(r => r.action === a && r.target_id === PROBE_UID)),
    `${auditRows2.length} rows`)

  const probeAudit = await rest('GET', `staff_audit_log?select=id&id=eq.${PROBE_UID}`, probeH)
  void probeAudit

  // -------------------------------------------------------------------------
  // 11. cleanup — the matrix leaves NO test rows behind
  // -------------------------------------------------------------------------
  const del0 = await rest('DELETE', `posts?id=eq.${prePostId}`, probeH)
  const del1 = await rest('DELETE', `posts?id=eq.${newPostId}`, probeH)
  const cleanupFeed = await rest('POST', 'rpc/list_public_posts', anonH, { p_limit: 50, p_offset: 0 })
  const cleanupRows = Array.isArray(cleanupFeed.json) ? cleanupFeed.json : []
  const left = cleanupRows.filter(r => r.id === prePostId || r.id === newPostId).length
  check('11.1 matrix posts cleaned up', del0.status === 204 && del1.status === 204 && left === 0,
    `HTTP ${del0.status}/${del1.status}, ${left} left`)

  // 11.2 the provision round-trip strips college_id (0042 guard fires when the
  // probe held the admin tier). Restore it so ads targeting stays intact.
  const COLLEGE = '1fba2225-352e-4abc-afd2-a628e7e2474a'
  const restCol = await rest('PATCH', `profiles?id=eq.${PROBE_UID}`, probeH, { college_id: COLLEGE })
  const colNow = firstRow(restCol.json)?.college_id
  check('11.2 probe college affiliation restored (ads targeting intact)',
    restCol.status === 200 && colNow === COLLEGE, `HTTP ${restCol.status}`)

  // -------------------------------------------------------------------------
  console.log(`\n${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

main().catch(err => { console.error('FATAL', err); process.exit(1) })
