import { supabase } from './supabase'

/**
 * Typed data access for CAMPUS.
 *
 * Every function here works against the Supabase project configured in `.env`
 * and degrades gracefully: when a table or function from
 * `supabase/migrations/0001_explore_first_onboarding.sql` has not been applied
 * yet, the capability flags in `probeCaps()` are false and callers fall back to
 * the parts of the schema that already exist. Errors are always surfaced to the
 * UI — nothing here pretends that a write succeeded.
 */

export type College = {
  id: string
  name: string
  short_name: string
  city: string
  verified: boolean
}

export type Topic = { id: string; name: string; post_count: number }
export type Club = { id: string; name: string; description: string }

export type Profile = {
  id: string
  username: string | null
  display_name: string
  first_name: string | null
  last_name: string | null
  bio: string
  avatar_url: string | null
  college_id: string | null
  course: string | null
  department: string | null
  year_of_study: number | null
  /** 0010: verification lives here — only admins can flip it (trigger + RPC) */
  is_verified: boolean
  is_private: boolean
  role: string
  /** 0043: 'active' | 'suspended' — present when the caller selects it */
  account_status?: string
  onboarding_step: number | null
  onboarding_completed_at: string | null
  /** 0009: last time the username changed — null until the first change */
  username_changed_at: string | null
}

export type Caps = {
  loaded: boolean
  /** profiles.first_name / department / onboarding_step / onboarding_completed_at exist */
  profileExtras: boolean
  /** public.college_suggestions exists */
  suggestions: boolean
  /** public.profile_interests exists */
  interests: boolean
  /** public.user_blocks exists */
  blocks: boolean
  /** public.username_available() exists */
  usernameRpc: boolean
  /** public.reports is readable (always true once schema.sql is applied) */
  reports: boolean
  /** storage bucket 'avatars' exists and accepts uploads */
  avatars: boolean
  /** 0026: public.list_saved_items + saved_resources exist (Saved page) */
  savedItems: boolean
  /** 0027: public.list_leaderboard exists (Leaderboard page) */
  leaderboard: boolean
}

export const EMPTY_CAPS: Caps = {
  loaded: false,
  profileExtras: false,
  suggestions: false,
  interests: false,
  blocks: false,
  usernameRpc: false,
  reports: false,
  avatars: false,
  savedItems: false,
  leaderboard: false,
}

export const PROFILE_BASE_COLUMNS =
  'id, username, display_name, bio, avatar_url, college_id, course, year_of_study, is_private'
export const PROFILE_EXTRA_COLUMNS =
  'first_name, last_name, department, role, onboarding_step, onboarding_completed_at, username_changed_at, is_verified'

const USERNAME_RE = /^[a-z0-9_]{3,20}$/

/** Lowercase, strip a leading @, turn spaces into underscores, drop anything else. */
export function normalizeUsername(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
}

/** Returns a human message when the username is not acceptable, else null. */
export function usernameError(value: string): string | null {
  if (value.length < 3) return 'Usernames are at least 3 characters.'
  if (value.length > 20) return 'Usernames are at most 20 characters.'
  if (!USERNAME_RE.test(value)) return 'Use only letters, numbers and underscores.'
  if (/^(admin|campus|root|support|official|system)$/i.test(value)) return 'That username is reserved.'
  return null
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** Turn Supabase/Postgres errors into sentences a student can act on. */
export function friendlyMessage(error: unknown): string {
  const anyError = error as { message?: string; code?: string } | null
  const raw = String(anyError?.message ?? error ?? 'Something went wrong.')
  if (/23505|unique constraint|duplicate key/i.test(raw)) {
    return 'That username was just taken by someone else. Please choose another.'
  }
  if (/permission denied|row-level security/i.test(raw)) {
    // keep the raw message — it names the exact table/policy that refused,
    // which is what honest diagnosis of RLS failures needs
    return raw
  }
  if (/does not exist|schema cache|PGRST20|PGRST3/i.test(raw)) {
    return 'A required database piece is missing. Apply supabase/migrations/0001_explore_first_onboarding.sql and 0002_real_feed.sql in the Supabase SQL editor.'
  }
  if (/invalid login credentials/i.test(raw)) return 'That email and password combination did not match.'
  if (/email not confirmed/i.test(raw)) return 'Confirm your email address first — check your inbox for the CAMPUS link.'
  if (/rate limit|too many/i.test(raw)) return 'Too many attempts. Wait a moment and try again.'
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return 'Could not reach CAMPUS. Check your internet connection and try again.'
  return raw
}

const isMissingRelation = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST205' || /Could not find the table|schema cache/i.test(error.message ?? ''))

const isMissingColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST204' || /does not exist/i.test(error.message ?? ''))

const isMissingFunction = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST202' || /Could not find the function|does not exist/i.test(error.message ?? ''))

/* -------------------------------------------------------------------------- */
/* Capability probe                                                            */
/* -------------------------------------------------------------------------- */

export async function probeCaps(): Promise<Caps> {
  const caps: Caps = { ...EMPTY_CAPS }
  const client = supabase
  if (!client) return caps

  const hasColumn = async (table: string, column: string) => {
    const { error } = await client.from(table).select(column).limit(0)
    return !error
  }
  const hasRelation = async (table: string) => {
    const { error } = await client.from(table).select('*').limit(0)
    if (!error) return true
    return !isMissingRelation(error) && !/PGRST2/.test(error.code ?? '')
  }

  const [profileExtras, suggestions, interests, blocks, reports] = await Promise.all([
    hasColumn('profiles', 'onboarding_step'),
    hasRelation('college_suggestions'),
    hasRelation('profile_interests'),
    hasRelation('user_blocks'),
    hasRelation('reports'),
  ])

  const { error: rpcError } = await client.rpc('username_available', { p_username: 'campus_probe_user' })
  const usernameRpc = !rpcError || !isMissingFunction(rpcError)

  // 0026: the Saved page read path exists only after the migration is applied
  const { error: savedError } = await client.rpc('list_saved_items', {
    p_kind: 'all', p_query: null, p_before: null, p_limit: 1, p_after_id: null,
  })
  const savedItems = !savedError || !isMissingFunction(savedError)

  // 0027: the Leaderboard read path exists only after the migration is applied
  const { error: lbError } = await client.rpc('list_leaderboard', {
    p_category: 'overall', p_period: 'week', p_limit: 1, p_offset: 0,
  })
  const leaderboard = !lbError || !isMissingFunction(lbError)

  // Storage: ask the bucket list; the avatars bucket is created by migration 0001.
  let avatars = false
  try {
    const { data, error } = await client.storage.listBuckets()
    if (!error && Array.isArray(data)) avatars = data.some(bucket => bucket.id === 'avatars')
  } catch {
    avatars = false
  }

  return { loaded: true, profileExtras, suggestions, interests, blocks, usernameRpc, reports, avatars, savedItems, leaderboard }
}

/* -------------------------------------------------------------------------- */
/* Public directory data (readable by everyone)                                */
/* -------------------------------------------------------------------------- */

export async function loadColleges(): Promise<College[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('colleges')
    .select('id, name, short_name, city, verified')
    .order('name')
    .limit(500)
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as College[]
}

export async function loadTopics(): Promise<Topic[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('topics')
    .select('id, name, post_count')
    .order('post_count', { ascending: false })
    .limit(40)
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as Topic[]
}

export async function loadClubs(): Promise<Club[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('clubs').select('id, name, description').order('name').limit(60)
  if (error) {
    if (isMissingRelation(error)) return []
    throw new Error(friendlyMessage(error))
  }
  return (data ?? []) as Club[]
}

/* -------------------------------------------------------------------------- */
/* Profiles                                                                    */
/* -------------------------------------------------------------------------- */

const selectProfile = () =>
  `${PROFILE_BASE_COLUMNS}, ${PROFILE_EXTRA_COLUMNS}`

export async function fetchProfile(userId: string): Promise<Profile | null> {
  if (!supabase) return null
  const first = await supabase.from('profiles').select(selectProfile()).eq('id', userId).maybeSingle()
  let data: unknown = first.data
  let error = first.error

  // Migration 0001 not applied yet: retry with the columns that exist today.
  if (error && isMissingColumn(error)) {
    const retry = await supabase.from('profiles').select(PROFILE_BASE_COLUMNS).eq('id', userId).maybeSingle()
    data = retry.data
    error = retry.error
  }
  if (error) throw new Error(friendlyMessage(error))
  return (data as Profile | null) ?? null
}

/**
 * Make sure a profile row exists for the signed in user. The signup trigger in
 * schema.sql normally creates it; this is the safety net for accounts created
 * before that trigger existed. It never creates a duplicate row.
 */
export async function ensureProfile(user: { id: string; email?: string }): Promise<Profile | null> {
  const existing = await fetchProfile(user.id)
  if (existing) return existing
  if (!supabase) return null

  const display = (user.email ?? 'Campus Student').split('@')[0]
  const { error } = await supabase.from('profiles').insert({ id: user.id, display_name: display })
  if (error && !/duplicate key|23505/i.test(error.message ?? '')) throw new Error(friendlyMessage(error))
  return fetchProfile(user.id)
}

export type ProfilePatch = Partial<{
  first_name: string
  last_name: string
  display_name: string
  username: string
  bio: string
  avatar_url: string | null
  college_id: string | null
  college_declared_at: string | null
  course: string | null
  department: string | null
  year_of_study: number | null
  is_private: boolean
  onboarding_step: number
  onboarding_completed_at: string | null
}>

/**
 * Persist profile changes. Columns from migration 0001 are dropped from the
 * payload (and reported through `degraded`) when the migration has not been
 * applied, so onboarding still works on the baseline schema.
 */
export async function saveProfile(
  userId: string,
  patch: ProfilePatch,
  caps: Caps,
): Promise<{ degraded: boolean }> {
  if (!supabase) throw new Error('CAMPUS is not connected. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.')
  const extraKeys = ['first_name', 'last_name', 'department', 'onboarding_step', 'onboarding_completed_at', 'college_declared_at']
  const payload: Record<string, unknown> = {}
  let degraded = false

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (extraKeys.includes(key) && !caps.profileExtras) {
      degraded = true
      continue
    }
    payload[key] = value
  }
  if (Object.keys(payload).length === 0) return { degraded: true }

  // `.select('id')` makes a silently filtered update (RLS mismatch, missing
  // row) visible: zero returned rows means nothing was written, and we say so
  // instead of pretending the change was saved.
  const { data, error } = await supabase.from('profiles').update(payload).eq('id', userId).select('id')
  if (error) throw new Error(friendlyMessage(error))
  if (!data || data.length === 0) {
    throw new Error('Your session could not save that change to your profile. Sign in again and retry.')
  }
  return { degraded }
}

export type UsernameCheck = 'idle' | 'checking' | 'available' | 'taken' | 'invalid'

/**
 * Username availability. Uses the security-definer RPC when migration 0001 is
 * applied and falls back to an equality lookup otherwise. Both paths return a
 * single boolean and never expose emails or other account data.
 */
export async function checkUsername(
  raw: string,
  caps: Caps,
  currentUsername?: string | null,
): Promise<{ state: UsernameCheck; message?: string }> {
  const value = normalizeUsername(raw)
  if (usernameError(value)) return { state: 'invalid', message: usernameError(value) ?? undefined }
  if (!supabase) return { state: 'taken', message: 'Connect Supabase to check availability.' }

  // Re-editing your own username must not read as "taken" (the RPC excludes
  // the caller in migration 0001; this covers pre-migration databases too).
  const current = currentUsername ? normalizeUsername(currentUsername) : ''
  if (current && value === current) {
    return { state: 'available', message: 'That is your current username.' }
  }

  if (caps.usernameRpc) {
    const { data, error } = await supabase.rpc('username_available', { p_username: value })
    if (error) return { state: 'idle', message: friendlyMessage(error) }
    return data === true ? { state: 'available' } : { state: 'taken' }
  }

  const { data, error } = await supabase.from('profiles').select('username').eq('username', value).limit(1)
  if (error) return { state: 'idle', message: friendlyMessage(error) }
  return (data ?? []).length === 0 ? { state: 'available' } : { state: 'taken' }
}

/* -------------------------------------------------------------------------- */
/* Interests                                                                   */
/* -------------------------------------------------------------------------- */

export async function loadInterests(userId: string): Promise<string[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('profile_interests').select('topic_id').eq('user_id', userId)
  if (error) return [] // table not migrated yet, or nothing saved
  return (data ?? []).map(row => (row as { topic_id: string }).topic_id)
}

export async function saveInterests(userId: string, topicIds: string[], caps: Caps): Promise<boolean> {
  if (!supabase || !caps.interests) return false
  const del = await supabase.from('profile_interests').delete().eq('user_id', userId)
  if (del.error) throw new Error(friendlyMessage(del.error))
  if (topicIds.length > 0) {
    const ins = await supabase.from('profile_interests').insert(topicIds.map(topic_id => ({ user_id: userId, topic_id })))
    if (ins.error) throw new Error(friendlyMessage(ins.error))
  }
  return true
}

/* -------------------------------------------------------------------------- */
/* Staff console data loaders (0043)                                          */
/* -------------------------------------------------------------------------- */
/* staff_accounts is staff-RLS protected: members simply see nothing and these */
/* throw honest errors rendered as "staff only" states in the console.        */

export type StaffAccountRow = {
  user_id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  tier: string
  scopes: string[]
  title: string | null
  is_active: boolean
  account_status: string
  provisioned_at: string
  revoked_at: string | null
}

export type StaffAuditRow = {
  id: string
  created_at: string
  action: string
  actor_name: string | null
  actor_username: string | null
  target_id: string | null
  metadata: Record<string, unknown> | null
}

export async function loadStaffRoster(): Promise<StaffAccountRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('staff_accounts')
    .select('user_id, tier, scopes, title, is_active, provisioned_at, revoked_at, profile:profiles!staff_accounts_user_id_fkey(username, display_name, avatar_url, account_status)')
    .order('is_active', { ascending: false })
    .order('tier')
    .limit(100)
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
    user_id: row.user_id as string,
    username: ((row.profile as Record<string, unknown>)?.username as string) ?? null,
    display_name: ((row.profile as Record<string, unknown>)?.display_name as string) ?? null,
    avatar_url: ((row.profile as Record<string, unknown>)?.avatar_url as string) ?? null,
    tier: row.tier as string,
    scopes: (row.scopes as string[]) ?? [],
    title: (row.title as string) ?? null,
    is_active: Boolean(row.is_active),
    account_status: (((row.profile as Record<string, unknown>)?.account_status as string) ?? 'active'),
    provisioned_at: row.provisioned_at as string,
    revoked_at: (row.revoked_at as string) ?? null,
  }))
}

export async function loadStaffAudit(limit = 80): Promise<StaffAuditRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('staff_audit_log')
    .select('id, created_at, action, actor_id, target_id, metadata')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(friendlyMessage(error))
  const rows = ((data ?? []) as Array<Record<string, unknown>>)
  const actorIds = [...new Set(rows.map(r => r.actor_id).filter(Boolean))] as string[]
  const nameMap = new Map<string, { name: string | null; username: string | null }>()
  if (actorIds.length) {
    const people = await supabase
      .from('profiles')
      .select('id, username, display_name')
      .in('id', actorIds)
    for (const p of ((people.data ?? []) as Array<Record<string, unknown>>)) {
      nameMap.set(p.id as string, {
        name: (p.display_name as string) ?? null,
        username: (p.username as string) ?? null,
      })
    }
  }
  return rows.map(row => {
    const actor = nameMap.get(row.actor_id as string)
    return {
      id: row.id as string,
      created_at: row.created_at as string,
      action: row.action as string,
      actor_name: actor?.name ?? null,
      actor_username: actor?.username ?? null,
      target_id: (row.target_id as string) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? null,
    }
  })
}

/** Trusted staff RPC passthrough — errors surface verbatim (they are the UX). */
export async function staffRpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  // Dynamic RPC names arrive from the console; tiers + ops are enforced inside
  // the database functions themselves.
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(friendlyMessage(error))
  return data
}

/** Console People search: thin directory lookup (member-visible profiles). */
export async function findStaffTargets(query: string): Promise<Profile[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const q = query.trim().replace(/^@/, '')
  if (q.length < 2) return []
  const { data, error } = await supabase
    .from('profiles')
    .select(`${PROFILE_BASE_COLUMNS}, role, account_status`)
    .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
    .order('username')
    .limit(6)
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as Profile[]
}

/* Moderation Center (0044)                                                    */
/* -------------------------------------------------------------------------- */
/* The reports table is member-RLS'd (read own only), so the staff queue lives  */
/* behind the 0044 security-definer RPCs — errors surface verbatim.             */

export type ModerationReportRow = {
  report_id: string
  status: string
  reason: string
  details: string | null
  created_at: string
  subject_kind: 'post' | 'person' | 'post+person'
  reporter_username: string | null
  reporter_name: string | null
  post_id: string | null
  post_excerpt: string | null
  post_author_id: string | null
  post_author_username: string | null
  post_is_published: boolean | null
  post_created_at: string | null
  reported_user_id: string | null
  reported_username: string | null
  reported_name: string | null
  reported_role: string | null
  reported_account_status: string | null
  reviewed_by_username: string | null
  reviewed_at: string | null
}

export function loadStaffReports(status: string, limit = 60): Promise<ModerationReportRow[]> {
  return staffRpc('staff_list_reports', { p_status: status, p_limit: limit }) as Promise<ModerationReportRow[]>
}

export function loadStaffReportCounts(): Promise<{ open: number; reviewing: number; resolved: number; dismissed: number }> {
  return staffRpc('staff_report_counts') as Promise<{ open: number; reviewing: number; resolved: number; dismissed: number }>
}

/* College suggestions                                                         */
/* -------------------------------------------------------------------------- */

export async function submitCollegeSuggestion(name: string, city: string, caps: Caps): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  if (!caps.suggestions) {
    // Table missing: keep the request honest instead of faking success.
    throw new Error('College suggestions are not enabled yet. Apply supabase/migrations/0001_explore_first_onboarding.sql first.')
  }
  const { error } = await supabase.rpc('request_college_suggestion', { p_name: name, p_city: city })
  if (error) throw new Error(friendlyMessage(error))
}

/* -------------------------------------------------------------------------- */
/* Reporting and blocking                                                      */
/* -------------------------------------------------------------------------- */

export type ReportInput = { reason: string; postId?: string | null; reportedUserId?: string | null; details?: string }

export async function submitReport(input: ReportInput): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('submit_report', {
    p_reason: input.reason,
    p_post_id: isValidUuid(input.postId ?? '') ? input.postId : null,
    p_reported_user_id: isValidUuid(input.reportedUserId ?? '') ? input.reportedUserId : null,
    p_details: input.details ?? null,
  })
  if (error) throw new Error(friendlyMessage(error))
}

export type ReportRow = { id: string; reason: string; status: string; created_at: string }

export async function loadMyReports(): Promise<ReportRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('reports')
    .select('id, reason, status, created_at')
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) return []
  return (data ?? []) as ReportRow[]
}

export type BlockedRow = { blocked_id: string; created_at: string; display_name: string | null; username: string | null }

/** Resolve a public handle to a profile id (null when it cannot be read). */
export async function findProfileIdByUsername(username: string): Promise<string | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.from('profiles').select('id').eq('username', username).maybeSingle()
  if (error) throw new Error(friendlyMessage(error))
  return (data as { id: string } | null)?.id ?? null
}

export type RelationRow = { id: string; username: string | null; display_name: string | null }

/** Remove a block or mute relation of the signed-in member. */
export async function unsetUserRelation(
  table: 'user_blocks' | 'user_mutes',
  blockerId: string,
  targetId: string,
): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase
    .from(table)
    .delete()
    .eq('blocker_id', blockerId)
    .eq('blocked_id', targetId)
  if (error) throw new Error(friendlyMessage(error))
}

/** Block or mute someone. Re-adding an existing relation is not an error. */export async function setUserRelation(
  table: 'user_blocks' | 'user_mutes',
  blockerId: string,
  targetId: string,
): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.from(table).insert({ blocker_id: blockerId, blocked_id: targetId })
  if (error && !/duplicate key|23505/i.test(error.message ?? '')) throw new Error(friendlyMessage(error))
}

/** Accounts the signed-in member has blocked or muted (RLS limits rows to their own). */
export async function loadUserRelation(
  table: 'user_blocks' | 'user_mutes',
  blockerId: string,
): Promise<RelationRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from(table)
    .select('blocked_id, profiles:blocked_id ( username, display_name )')
    .eq('blocker_id', blockerId)
    .order('created_at', { ascending: false })
  if (error) return []
  const rows = (data ?? []) as unknown as {
    blocked_id: string
    profiles: { username: string; display_name: string } | { username: string; display_name: string }[] | null
  }[]
  return rows.map(row => {
    const target = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles
    return { id: row.blocked_id, username: target?.username ?? null, display_name: target?.display_name ?? null }
  })
}

export async function loadBlocked(userId: string): Promise<BlockedRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('user_blocks')
    .select('blocked_id, created_at, profiles:blocked_id ( display_name, username )')
    .eq('blocker_id', userId)
    .order('created_at', { ascending: false })
  if (error) return []
  const rows = (data ?? []) as unknown as { blocked_id: string; created_at: string; profiles: { display_name: string; username: string } | { display_name: string; username: string }[] | null }[]
  return rows.map(row => {
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles
    return { blocked_id: row.blocked_id, created_at: row.created_at, display_name: profile?.display_name ?? null, username: profile?.username ?? null }
  })
}

export async function blockUser(userId: string, targetId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.from('user_blocks').insert({ blocker_id: userId, blocked_id: targetId })
  if (error && !/duplicate key|23505/i.test(error.message ?? '')) throw new Error(friendlyMessage(error))
}

export async function unblockUser(userId: string, targetId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.from('user_blocks').delete().eq('blocker_id', userId).eq('blocked_id', targetId)
  if (error) throw new Error(friendlyMessage(error))
}

export async function setPrivateProfile(userId: string, value: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.from('profiles').update({ is_private: value }).eq('id', userId)
  if (error) throw new Error(friendlyMessage(error))
}

/** Change the signed-in member's auth password (Supabase auth session). */
export async function changePassword(newPassword: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw new Error(friendlyMessage(error))
}

/** The email behind the current session — shown read-only in Account. */
export async function currentEmail(): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getUser()
  return data.user?.email ?? null
}

/* -------------------------------------------------------------------------- */
/* Avatars                                                                     */
/* -------------------------------------------------------------------------- */

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** Validate a picked image before it is uploaded. Returns an error message or null. */
export function validateAvatarFile(file: File): string | null {
  if (!file.type.startsWith('image/')) return 'Choose an image file (JPG, PNG or WebP).'
  if (file.size > MAX_AVATAR_BYTES) return 'That image is over 2 MB. Please pick a smaller one.'
  return null
}

export async function uploadAvatar(userId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const extension = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const path = `${userId}/avatar-${Date.now()}.${extension}`
  const { error } = await supabase.storage.from('avatars').upload(path, file, { cacheControl: '3600', upsert: false })
  if (error) throw new Error(friendlyMessage(error))
  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  return data.publicUrl
}

/* -------------------------------------------------------------------------- */
/* Feed                                                                        */
/* -------------------------------------------------------------------------- */

import type { CampusPost, PostKind } from '../types'
export type { CampusPost }

type FeedRow = {
  id: string
  body: string
  kind: string
  media_urls: string[] | null
  is_anonymous: boolean
  created_at: string
  edited_at: string | null
  author_id: string | null
  author_display_name: string | null
  author_username: string | null
  author_avatar_url: string | null
  author_is_verified?: boolean | null
  college_id: string | null
  college_short_name: string | null
  like_count: number | string | null
  comment_count: number | string | null
  liked_by_me: boolean
}

/** Feed-relative time, also reused for the "edited · 2 hours ago" marker. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  if (hours < 48) return 'yesterday'
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function initialsFor(name?: string | null, username?: string | null): string {
  const source = (name ?? '').trim() || (username ?? '').trim()
  return (
    source
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'C'
  )
}

/** Map one list_public_posts() row to the UI's CampusPost shape. */
export function mapFeedRow(row: FeedRow): CampusPost {
  const anonymous = Boolean(row.is_anonymous)
  const name = anonymous ? 'Anonymous' : row.author_display_name ?? 'Student'
  const username = anonymous ? '' : row.author_username ?? ''
  const kind: PostKind = row.kind === 'confession' || row.kind === 'poll' || row.kind === 'reel' ? row.kind : 'post'
  return {
    id: row.id,
    author: name,
    handle: username ? `@${username}` : '',
    createdAt: row.created_at,
    initials: anonymous ? '' : initialsFor(name, username),
    college: row.college_short_name ?? '',
    time: relativeTime(row.created_at),
    body: row.body ?? '',
    likes: Number(row.like_count ?? 0),
    comments: Number(row.comment_count ?? 0),
    reposts: 0,
    kind,
    media: row.media_urls ?? [],
    authorId: row.author_id,
    editedAt: row.edited_at,
    authorVerified: Boolean(row.author_is_verified),
    trending: Number(row.like_count ?? 0) >= 30,
    anonymous,
    liked: Boolean(row.liked_by_me),
    saved: false,
    reposted: false,
    // No tag for named posts — the college already shows in the author line;
    // a college badge only appears on anonymous posts (where the line hides it).
    tag: anonymous ? row.college_short_name ?? '' : '',
  }
}

/**
 * Load the public feed through the list_public_posts() RPC (migration 0002).
 * Throws on any failure so the caller can decide how to degrade honestly.
 */
export async function fetchFeed(limit = 50): Promise<CampusPost[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_public_posts', {
    p_limit: Math.min(Math.max(limit, 1), 50),
    p_offset: 0,
  })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (data ?? []) as FeedRow[]
  return rows.map(row => mapFeedRow(row))
}

/**
 * Real trending tags: rank #hashtags harvested from the bodies of the most
 * recent public posts (all kinds — captions count). Returns [tag, count]
 * pairs without the leading '#', most used first.
 */
export async function fetchTrendingTags(limit = 8): Promise<[string, number][]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('posts')
    .select('body')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(friendlyMessage(error))
  const counts = new Map<string, number>()
  for (const row of (data ?? []) as { body: string | null }[]) {
    const matches = row.body?.match(/#([\p{L}\p{N}_]{2,30})/gu) ?? []
    for (const raw of matches) {
      const tag = raw.slice(1).toLowerCase()
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
}

export type FollowSuggestion = { id: string; username: string; name: string }

/**
 * Instagram-style For You ranking. Recency dominates: the ranking only gets
 * to shuffle posts once engagement or affinity is genuinely large, so a
 * "just now" post already outranks an old, mildly-liked one. Heavy virality
 * (dozens of likes) can still cut through a day later, like Instagram's.
 */
export function forYouScore(post: CampusPost, viewerFollowed: boolean, sameCollege: boolean): number {
  const ageHours = post.createdAt
    ? Math.max(0, (Date.now() - new Date(post.createdAt).getTime()) / 3_600_000)
    : 24
  const recency = Math.exp(-ageHours / 12) // fresh ≈ 1, 12h ≈ 0.37, a day ≈ 0.14, a week ≈ 0
  const engagement = Math.log2(1 + post.likes * 2 + post.comments * 3)
  const affinity = (viewerFollowed ? 0.6 : 0) + (sameCollege ? 0.3 : 0)
  return 8 * recency + 1.2 * engagement + affinity
}

/** Resolve a @username to a profile id for mention links (cached per session). */
const mentionIdCache = new Map<string, Promise<string | null>>()

export function fetchProfileIdByUsername(username: string): Promise<string | null> {
  const key = username.toLowerCase()
  let cached = mentionIdCache.get(key)
  if (!cached) {
    cached = (async () => {
      if (!supabase) return null
      const { data, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', key)
        .maybeSingle()
      if (error || !data) return null
      return (data as { id: string }).id
    })().catch(() => null)
    mentionIdCache.set(key, cached)
  }
  return cached
}

/* -------------------------------------------------------------------------- */
/* Chats (1:1 direct messages)                                                 */
/* -------------------------------------------------------------------------- */

export type ChatSummary = {
  id: string
  kind: 'dm' | 'group'
  status: 'pending' | 'accepted' | 'declined'
  iRequested: boolean
  title: string | null
  peerId: string | null
  peerName: string
  peerUsername: string
  peerAvatar: string | null
  memberCount: number
  /** server-side preview: text, "Sent a photo", "Sent a reel"… (0023) */
  lastPreview: string | null
  lastSenderId: string | null
  lastAt: string | null
  /** the other side has read MY newest message (dm) */
  lastSeen: boolean
  unread: number
  /** per-USER inbox preferences (0023) */
  pinned: boolean
  muted: boolean
  archived: boolean
  /** "clear chat" cutoff — messages at/before this are hidden from MY view (0024) */
  clearedAt: string | null
}

export type ChatAttachment = { path: string; name: string; mime: string; size: number }

/** The kind of CAMPUS content a message can REFERENCE (never duplicate). */
export type ChatSharedKind = 'reel' | 'post' | 'profile' | 'listing' | 'event'

export type ChatMessage = {
  id: string
  conversationId: string
  senderId: string | null
  senderName: string
  senderUsername: string | null
  senderAvatarUrl: string | null
  /** empty for an unsent message — render the tombstone instead */
  body: string
  createdAt: string
  editedAt: string | null
  /** set when the sender unsent the message (Instagram-style tombstone) */
  deletedAt: string | null
  /** a moderator removal when set and different from senderId */
  deletedBy: string | null
  /** replies bind to their thread root (one flat level) */
  parentMessageId: string | null
  parentAuthorName: string | null
  parentExcerpt: string | null
  attachments: ChatAttachment[]
  reactions: Record<string, string[]>
  pinnedAt: string | null
  replyCount: number
  /** an honest group event line ("X added Y"), not a member's own message */
  isSystem: boolean
  /** referenced CAMPUS content (0023) */
  sharedKind: ChatSharedKind | null
  sharedId: string | null
  sharedTitle: string | null
  sharedSubtitle: string | null
  sharedAuthor: string | null
  sharedImage: string | null
  /** #m/<slug> / #e/<slug> deep links use this */
  sharedSlug: string | null
  /** false → the referenced content is gone/restricted for THIS reader */
  sharedAvailable: boolean
  /** read receipts (0023): the others' newest read + how many read this */
  seenAt: string | null
  seenCount: number
}

type ChatMessageRow = {
  id: string
  conversation_id: string
  sender_id: string | null
  sender_username: string | null
  sender_display_name: string | null
  sender_avatar_url?: string | null
  body: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
  deleted_by?: string | null
  parent_message_id?: string | null
  parent_author_name?: string | null
  parent_excerpt?: string | null
  attachments?: ChatAttachment[] | null
  reactions?: Record<string, string[]> | null
  pinned_at?: string | null
  reply_count?: number | null
  is_system?: boolean | null
  shared_kind?: string | null
  shared_id?: string | null
  shared_title?: string | null
  shared_subtitle?: string | null
  shared_author?: string | null
  shared_image?: string | null
  shared_slug?: string | null
  shared_available?: boolean | null
  seen_at?: string | null
  seen_count?: number | null
}

export function mapChatMessage(row: ChatMessageRow): ChatMessage {
  const name = row.sender_display_name?.trim() || 'Student'
  const unsent = Boolean(row.deleted_at)
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: name,
    senderUsername: row.sender_username ?? null,
    senderAvatarUrl: row.sender_avatar_url ?? null,
    body: unsent ? '' : (row.body as string),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by ?? null,
    parentMessageId: row.parent_message_id ?? null,
    parentAuthorName: row.parent_author_name ?? null,
    parentExcerpt: row.parent_excerpt ?? null,
    attachments: unsent ? [] : (row.attachments ?? []),
    reactions: unsent ? {} : (row.reactions ?? {}),
    pinnedAt: row.pinned_at ?? null,
    replyCount: Number(row.reply_count ?? 0),
    isSystem: Boolean(row.is_system),
    sharedKind: unsent ? null : ((row.shared_kind as ChatSharedKind | null) ?? null),
    sharedId: unsent ? null : (row.shared_id ?? null),
    sharedTitle: row.shared_title ?? null,
    sharedSubtitle: row.shared_subtitle ?? null,
    sharedAuthor: row.shared_author ?? null,
    sharedImage: row.shared_image ?? null,
    sharedSlug: row.shared_slug ?? null,
    sharedAvailable: row.shared_available !== false,
    seenAt: row.seen_at ?? null,
    seenCount: Number(row.seen_count ?? 0),
  }
}

function mapConversationRow(row: Record<string, unknown>): ChatSummary {
  const kind = row.kind === 'group' ? 'group' : 'dm'
  const username = ((row.peer_username as string) ?? '')
  const displayName = ((row.display_name as string) ?? '').trim()
  const status = row.status === 'pending' ? 'pending'
    : row.status === 'declined' ? 'declined' : 'accepted'
  return {
    id: row.conversation_id as string,
    kind,
    status,
    iRequested: kind !== 'group' && status !== 'accepted' && Boolean(row.i_requested),
    title: (row.title as string) ?? null,
    peerId: kind === 'dm' ? ((row.peer_id as string) ?? null) : null,
    peerName: displayName || (username ? `@${username}` : 'Classmate'),
    peerUsername: kind === 'dm' ? username : '',
    peerAvatar: kind === 'dm' ? ((row.avatar_url as string | null) ?? null) : null,
    memberCount: Number(row.member_count ?? 0),
    lastPreview: (row.last_preview as string) ?? null,
    lastSenderId: (row.last_sender_id as string) ?? null,
    lastAt: (row.last_at as string) ?? null,
    lastSeen: Boolean(row.last_seen),
    unread: Number(row.unread_count ?? 0),
    pinned: Boolean(row.pinned),
    muted: Boolean(row.muted),
    archived: Boolean(row.archived),
    clearedAt: ((row.cleared_at as string | null) ?? null),
  }
}

/**
 * Open (or reuse) the 1:1 conversation between the signed-in member and
 * another member. Returns the conversation id; creates the pair atomically
 * server-side via the open_dm() RPC (migration 0006).
 */
export async function openDm(otherUserId: string): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('open_dm', { p_other: otherUserId })
  if (error) throw new Error(friendlyMessage(error))
  if (!data) throw new Error('The chat could not be opened.')
  return data as string
}

/**
 * The Chats list: 1:1 conversations and group chats, newest activity first.
 * Club conversations are never returned here (kind filter server-side).
 */
export async function fetchConversations(): Promise<ChatSummary[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_conversations')
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as Record<string, unknown>[]).map(mapConversationRow)
}

/**
 * Create a group chat: the caller becomes admin, listed classmates join as
 * members. Returns the conversation id.
 */
export async function createGroup(title: string, memberIds: string[]): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('create_group', {
    p_title: title,
    p_members: memberIds,
  })
  if (error) throw new Error(friendlyMessage(error))
  if (!data) throw new Error('The group could not be created.')
  return data as string
}

/**
 * The classmate receiving a chat request accepts or declines it. Only the
 * recipient may respond, and only once.
 */
export async function respondChatRequest(
  conversationId: string,
  action: 'accept' | 'decline',
): Promise<'accepted' | 'declined'> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('respond_dm', {
    p_conversation: conversationId,
    p_action: action,
  })
  if (error) throw new Error(friendlyMessage(error))
  return (data as 'accepted' | 'declined') ?? (action === 'accept' ? 'accepted' : 'declined')
}

/* ------------------------------------------------------------------ */
/* Follows                                                             */
/* ------------------------------------------------------------------ */

export async function followUser(followerId: string, followedId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  // follower_id must be sent explicitly — the RLS policy checks it against
  // auth.uid(), and a NULL follower would fail that check
  const { error } = await supabase.from('follows').insert({ follower_id: followerId, followed_id: followedId })
  if (error) throw new Error(friendlyMessage(error))
}

export async function unfollowUser(followedId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.from('follows').delete().eq('followed_id', followedId)
  if (error) throw new Error(friendlyMessage(error))
}

/** The people the signed-in member follows (handles list, for feed filters). */
export async function fetchFollowing(followerId: string): Promise<string[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('follows')
    .select('followed_id')
    .eq('follower_id', followerId)
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []).map(row => (row as { followed_id: string }).followed_id)
}

/** True when the signed-in member follows the given profile. */
export async function isFollowing(followerId: string, followedId: string): Promise<boolean> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('follows')
    .select('followed_id')
    .eq('follower_id', followerId)
    .eq('followed_id', followedId)
    .maybeSingle()
  if (error) throw new Error(friendlyMessage(error))
  return Boolean(data)
}

export type ProfileStats = { postCount: number; reelCount: number; followerCount: number; followingCount: number }

export async function fetchProfileStats(profileId: string): Promise<ProfileStats> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('profile_stats', { p_profile: profileId })
  if (error) throw new Error(friendlyMessage(error))
  const row = (data ?? [{}]) as Record<string, unknown>[]
  const first = row[0] ?? {}
  return {
    postCount: Number(first.post_count ?? 0),
    reelCount: Number(first.reel_count ?? 0),
    followerCount: Number(first.follower_count ?? 0),
    followingCount: Number(first.following_count ?? 0),
  }
}

// list_member_posts/list_followers share row shapes with list_public_posts/search_members
export async function fetchMemberPosts(profileId: string, kind: 'post' | 'reel', limit = 24): Promise<CampusPost[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_member_posts', {
    p_profile: profileId,
    p_kind: kind,
    p_limit: limit,
  })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as FeedRow[]).map(mapFeedRow)
}

export async function fetchFollowersList(profileId: string, followers: boolean, limit = 50) {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_followers', {
    p_profile: profileId,
    p_followers: followers,
  })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as MemberRow[]).slice(0, limit).map<PersonResult>(row => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name?.trim() || (row.username ? `@${row.username}` : 'Student'),
    avatarUrl: row.avatar_url,
    collegeShort: null,
    isPrivate: Boolean(row.is_private),
    isVerified: Boolean(row.is_verified),
  }))
}

/**
 * Message history for one conversation, newest last; pass `beforeIso` to
 * page further back in time. Errors if the caller is not a member.
 */
export async function fetchChatMessages(
  conversationId: string,
  beforeIso?: string | null,
  limit = 40,
): Promise<ChatMessage[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_chat_messages', {
    p_conversation: conversationId,
    p_before: beforeIso ?? null,
    p_limit: limit,
  })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as ChatMessageRow[])
    .map(mapChatMessage)
    .reverse() // chronological order in the thread
}

/**
 * Send one message through the trusted send_chat_message RPC: validates
 * membership, body length, burst limit (8/30s), attachment metadata, reply
 * integrity (same conversation, not a tombstone) and runs the mention +
 * reply notification fan-out. senderId stays in the signature for callers
 * that already have it; the server always re-derives the sender as auth.uid().
 */
export async function sendChatMessage(
  conversationId: string,
  body: string,
  senderId: string, // eslint-disable-line @typescript-eslint/no-unused-vars — kept for call-site compatibility
  options: {
    parentId?: string | null
    attachments?: ChatAttachment[]
    sharedKind?: ChatSharedKind | null
    sharedId?: string | null
  } = {},
): Promise<ChatMessage> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('send_chat_message', {
    p_conversation: conversationId,
    p_body: body,
    p_parent_id: options.parentId ?? null,
    p_attachments: options.attachments?.length ? options.attachments : null,
    p_shared_kind: options.sharedKind ?? null,
    p_shared_id: options.sharedId ?? null,
  })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (data ?? []) as unknown as ChatMessageRow[]
  const row = rows[0]
  if (!row) throw new Error('The message did not come back — reload the chat.')
  return mapChatMessage(row)
}

/** Edit one of your own sent messages (server rule: sender only, within 24h). */
export async function editChatMessage(messageId: string, body: string): Promise<string | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('edit_chat_message', { p_message: messageId, p_body: body })
  if (error) throw new Error(friendlyMessage(error))
  return (data as string | null) ?? null
}

/** Unsend one of your own messages — the text leaves the DB, a tombstone stays. */
export async function unsendChatMessage(messageId: string): Promise<string | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('unsend_chat_message', { p_message: messageId })
  if (error) throw new Error(friendlyMessage(error))
  return (data as string | null) ?? null
}

/** Count the signed-in member's unread notifications (topbar bell badge). */
export async function fetchUnreadNotificationCount(): Promise<number> {
  if (!supabase) return 0
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)
    .eq('inapp_visible', true)
  if (error) throw new Error(friendlyMessage(error))
  return count ?? 0
}

/** Raw client access for components composing a few own-scoped reads
    (notification follow-suggestions). Never used for anything needing
    server validation — those always go through definer RPCs. */
export function getSupabaseClient() {
  return supabase
}

/** Mark a conversation read by the caller (drives unread badges). */
export async function markConversationRead(conversationId: string, userId?: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  let query = supabase
    .from('conversation_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
  if (userId) query = query.eq('user_id', userId)
  const { error } = await query
  if (error) throw new Error(friendlyMessage(error))
}

/* ------------------------------------------------------------------ */
/* Chat 2.0: threads, reactions, pins, search, mention targets         */
/* ------------------------------------------------------------------ */

/** One thread: the root message + every reply bound to it, oldest first. */
export async function fetchChatThread(messageId: string): Promise<ChatMessage[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_chat_thread', { p_message: messageId })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as unknown as ChatMessageRow[]).map(mapChatMessage)
}

/** Search THIS conversation's history (text, author name, or #hashtag). */
export async function searchChatMessages(
  conversationId: string,
  query: string,
  hashtag: string,
  beforeIso?: string | null,
): Promise<ChatMessage[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('search_chat', {
    p_conversation: conversationId,
    p_query: query,
    p_hashtag: hashtag,
    p_before: beforeIso ?? null,
  })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as unknown as ChatMessageRow[]).map(mapChatMessage)
}

/** Newest pinned messages of a conversation (drives the pinned banner). */
export async function fetchChatPins(conversationId: string): Promise<ChatMessage[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_chat_pins', { p_conversation: conversationId })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as unknown as ChatMessageRow[]).map(mapChatMessage)
}

/** Toggle one emoji on one message; returns the message's new reaction map. */
export async function toggleChatReaction(messageId: string, emoji: string): Promise<Record<string, string[]>> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('toggle_chat_reaction', { p_message: messageId, p_emoji: emoji })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? {}) as Record<string, string[]>) ?? {}
}

/** Sender self-removal or community-moderator removal (same tombstone path). */
export async function removeChatMessage(messageId: string): Promise<string | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('moderate_delete_chat_message', { p_message: messageId })
  if (error) throw new Error(friendlyMessage(error))
  return (data as string | null) ?? null
}

/** Moderators pin / unpin a message; returns the new pinned_at (or null). */
export async function setChatMessagePin(messageId: string, pinned: boolean): Promise<string | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('set_chat_message_pin', { p_message: messageId, p_pinned: pinned })
  if (error) throw new Error(friendlyMessage(error))
  return (data as string | null) ?? null
}

export type MentionTarget = { id: string; username: string; displayName: string; avatarUrl: string | null }

/** Members of THIS conversation for @-autocomplete (never beyond it). */
export async function fetchMentionTargets(conversationId: string, query: string): Promise<MentionTarget[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_chat_mention_targets', {
    p_conversation: conversationId,
    p_query: query,
  })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
    id: row.id as string,
    username: (row.username as string) ?? '',
    displayName: ((row.display_name as string) ?? '').trim() || (row.username as string) || 'Student',
    avatarUrl: (row.avatar_url as string | null) ?? null,
  }))
}

const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
const CHAT_ATTACHMENT_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
  'text/plain', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // ordinary video attachments and voice notes (0023); reels are referenced, never re-encoded
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav',
])

/** Upload one chat attachment to the PRIVATE chat-media bucket, inside this
 *  conversation's own folder. Throws with honest reasons before any upload. */
export async function uploadChatAttachment(conversationId: string, file: File): Promise<ChatAttachment> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  if (!CHAT_ATTACHMENT_MIMES.has(file.type)) throw new Error('That file type is not supported.')
  if (file.size <= 0) throw new Error('That file is empty.')
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) throw new Error('Attachments can be at most 25 MB.')
  // keep the extension, sanitize the rest of the name into the stored path
  // (the human-visible name travels inside the message)
  const dot = file.name.lastIndexOf('.')
  const ext = dot > 0 ? file.name.slice(dot).toLowerCase().slice(0, 12) : ''
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
  const path = `${conversationId}/${Date.now()}-${random}${ext}`
  const { error } = await supabase.storage.from('chat-media').upload(path, file, { cacheControl: '3600' })
  if (error) throw new Error(friendlyMessage(error))
  return { path, name: file.name.slice(0, 180), mime: file.type, size: file.size }
}

/** Short-lived signed URLs for private chat attachments (1 hour).
 *  Session-cached: repeated renders of the same bubble never re-hit
 *  storage (heavy chats would otherwise mint one signed URL per render
 *  cycle per attachment). */
const attachmentUrlCache = new Map<string, { url: string; exp: number }>()
const ATTACHMENT_URL_TTL_MS = 45 * 60 * 1000 // re-mint before the 60 min expiry

export async function chatAttachmentUrls(paths: string[]): Promise<Record<string, string>> {
  if (!supabase || paths.length === 0) return {}
  const now = Date.now()
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const path of paths) {
    const hit = attachmentUrlCache.get(path)
    if (hit && hit.exp > now) out[path] = hit.url
    else missing.push(path)
  }
  if (missing.length > 0) {
    const entries = await Promise.all(missing.map(async path => {
      const { data, error } = await supabase!.storage.from('chat-media').createSignedUrl(path, 3600)
      return [path, error ? null : (data?.signedUrl ?? null)] as const
    }))
    for (const [path, url] of entries) {
      if (url) {
        attachmentUrlCache.set(path, { url, exp: now + ATTACHMENT_URL_TTL_MS })
        out[path] = url
      }
    }
    // keep the cache bounded: drop expired entries once it grows past 500
    if (attachmentUrlCache.size > 500) {
      for (const [path, entry] of attachmentUrlCache) {
        if (entry.exp <= now) attachmentUrlCache.delete(path)
      }
    }
  }
  return out
}

/**
 * Live message stream for one conversation via Supabase Realtime: INSERT for
 * new messages AND UPDATE for edits / unsends / reactions / pins, so an open
 * thread stays up-to-the-second without any refetch. Returns an unsubscribe
 * function; callers dedupe inserts by message id and replace rows on update.
 */
/* sender persona cache shared by every chat subscription (module scope) */
const personaCache = new Map<string, { username: string; name: string; avatar: string | null }>()

export function subscribeChatMessages(
  conversationId: string,
  onChange: (message: ChatMessage, type: 'insert' | 'update') => void,
): () => void {
  if (!supabase) return () => {}
  const client = supabase
  /* Realtime postgres_changes payloads on chat_messages carry table
     columns only — sender persona (username / display name / avatar) and
     the derived reply-quote fields never travel on the wire. Quoted
     reply fields are preserved client-side by the panel's merge; the
     persona is hydrated here once per sender (small, cached): the bare
     row is delivered FIRST so the bubble appears instantly, then the
     name lands a moment later. The cache is module-scope + shared
     across re-subscribes (navigating between chats used to rebuild it
     and re-query every sender's profile). */
  // profiles that returned nothing this session are not re-queried
  const personaMisses = new Set<string>()
  const applyPersona = (bare: ChatMessage, persona: { username: string; name: string; avatar: string | null }) => {
    onChange({
      ...bare,
      senderUsername: persona.username || null,
      senderName: persona.name,
      senderAvatarUrl: persona.avatar,
    }, 'update')
  }
  const hydratePersona = (bare: ChatMessage, senderId: string | null | undefined) => {
    if (!senderId || !bare.id || personaMisses.has(senderId)) return
    const cached = personaCache.get(senderId)
    if (cached) { applyPersona(bare, cached); return }
    void (async () => {
      const { data, error } = await client
        .from('profiles')
        .select('username, display_name, avatar_url')
        .eq('id', senderId)
        .single()
      if (error || !data) { personaMisses.add(senderId); return }
      const entry = {
        username: (data.username as string) ?? '',
        name: ((data.display_name as string) || (data.username as string) || 'Student').trim(),
        avatar: (data.avatar_url as string) ?? null,
      }
      personaCache.set(senderId, entry)
      applyPersona(bare, entry)
    })()
  }

  const handle = (row: Record<string, unknown>, type: 'insert' | 'update') => {
    if (!row?.id) return
    const bare = mapChatMessage({
      id: row.id as string,
      conversation_id: (row.conversation_id as string) ?? conversationId,
      sender_id: (row.sender_id as string | null) ?? null,
      sender_username: null,
      sender_display_name: null,
      sender_avatar_url: null,
      body: (row.body as string | null) ?? '',
      created_at: (row.created_at as string) ?? new Date().toISOString(),
      edited_at: (row.edited_at as string | null) ?? null,
      deleted_at: (row.deleted_at as string | null) ?? null,
      deleted_by: (row.deleted_by as string | null) ?? null,
      parent_message_id: (row.parent_message_id as string | null) ?? null,
      parent_author_name: null,
      parent_excerpt: null,
      attachments: (row.attachments as ChatAttachment[] | null) ?? [],
      reactions: (row.reactions as Record<string, string[]> | null) ?? {},
      pinned_at: (row.pinned_at as string | null) ?? null,
      reply_count: null,
      is_system: (row.is_system as boolean | null) ?? false,
      shared_kind: (row.shared_kind as string | null) ?? null,
      shared_id: (row.shared_id as string | null) ?? null,
      // shared previews and receipts are resolved by the chat_all readers;
      // bare realtime rows carry none — the panel merge keeps the held row's
      shared_title: null,
      shared_subtitle: null,
      shared_author: null,
      shared_image: null,
      shared_slug: null,
      shared_available: null,
      seen_at: null,
      seen_count: null,
    })
    onChange(bare, type)
    // the bare row shows instantly; the persona lands a moment later
    hydratePersona(bare, (row.sender_id as string) ?? null)
  }
  const channel = client
    .channel(`chat:${conversationId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${conversationId}` },
      payload => handle(payload.new as Record<string, unknown>, 'insert'),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${conversationId}` },
      payload => handle(payload.new as Record<string, unknown>, 'update'),
    )
    .subscribe()
  return () => {
    void client.removeChannel(channel)
  }
}

/**
 * Chats-level live feed: every insert / edit / unsend across your
 * conversations pings the callback, so the Chats list reorders, updates
 * previews and unread badges without any navigation or polling. The server
 * already applies RLS to deliver only rows you may read.
 */
export function subscribeChatActivity(onChange: (conversationId: string) => void): () => void {
  if (!supabase) return () => {}
  const client = supabase
  const channel = client
    .channel('chats-activity')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_messages' },
      payload => {
        const row = payload.new as Record<string, unknown>
        onChange((row?.conversation_id as string) ?? '')
      },
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'chat_messages' },
      payload => {
        const row = payload.new as Record<string, unknown>
        onChange((row?.conversation_id as string) ?? '')
      },
    )
    .subscribe()
  return () => {
    void client.removeChannel(channel)
  }
}

/* -------------------------------------------------------------------------- */
/* Presence: who is online RIGHT NOW (live presence channel; nothing persisted)  */
/* -------------------------------------------------------------------------- */

export function subscribeOnlinePresence(
  myUserId: string,
  onChange: (onlineUserIds: string[]) => void,
): () => void {
  if (!supabase) return () => {}
  const client = supabase
  const channel = client
    .channel('campus-online', { config: { presence: { key: myUserId } } })
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState()
      onChange(Object.keys(state))
    })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        void channel.track({ seen_at: new Date().toISOString() })
      }
    })
  return () => {
    void channel.untrack()
    void client.removeChannel(channel)
  }
}

/* -------------------------------------------------------------------------- */
/* Chats 2.0 (0023): shared content, prefs, groups, forwarding, search         */
/* -------------------------------------------------------------------------- */

/** One per-user inbox preference action; the other side is never affected. */
export type ConversationPrefAction =
  | 'pin' | 'unpin' | 'mute' | 'unmute'
  | 'archive' | 'unarchive' | 'mark_unread' | 'clear'

export async function setConversationPrefs(
  conversationId: string,
  action: ConversationPrefAction,
): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('set_conversation_prefs', {
    p_conversation: conversationId,
    p_action: action,
  })
  if (error) throw new Error(friendlyMessage(error))
}

export type ConversationMember = {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  role: 'member' | 'admin' | 'moderator'
  joinedAt: string
}

export async function fetchConversationMembers(conversationId: string): Promise<ConversationMember[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('get_conversation_members', { p_conversation: conversationId })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
    id: row.user_id as string,
    username: (row.username as string) ?? '',
    displayName: ((row.display_name as string) ?? '').trim() || (row.username as string) || 'Student',
    avatarUrl: (row.avatar_url as string | null) ?? null,
    role: (row.role as ConversationMember['role']) ?? 'member',
    joinedAt: (row.joined_at as string) ?? '',
  }))
}

export async function addGroupMembers(conversationId: string, userIds: string[]): Promise<number> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('add_group_members', {
    p_conversation: conversationId,
    p_user_ids: userIds,
  })
  if (error) throw new Error(friendlyMessage(error))
  return Number(data ?? 0)
}

export async function removeGroupMember(conversationId: string, userId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('remove_group_member', {
    p_conversation: conversationId,
    p_user_id: userId,
  })
  if (error) throw new Error(friendlyMessage(error))
}

export async function leaveGroup(conversationId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('leave_group', { p_conversation: conversationId })
  if (error) throw new Error(friendlyMessage(error))
}

export async function renameGroup(conversationId: string, title: string): Promise<string | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('rename_group', {
    p_conversation: conversationId,
    p_title: title,
  })
  if (error) throw new Error(friendlyMessage(error))
  return (data as string | null) ?? null
}

/**
 * Send one CAMPUS content reference into a chat: the message row carries
 * kind + id only — the reel/post/profile/listing/event record stays the
 * single source of truth and the preview resolves at read time.
 */
export async function shareContentToChat(
  conversationId: string,
  shared: { kind: ChatSharedKind; id: string },
  note: string,
): Promise<ChatMessage> {
  return sendChatMessage(conversationId, note.trim(), '', {
    sharedKind: shared.kind,
    sharedId: shared.id,
  })
}

/** One search hit across all of the caller's conversations (0023). */
export type AllChatsSearchHit = {
  messageId: string
  conversationId: string
  kind: 'dm' | 'group' | 'club'
  conversationTitle: string
  senderId: string | null
  senderName: string
  body: string
  createdAt: string
}

export async function searchAllChats(query: string, limit = 30): Promise<AllChatsSearchHit[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const trimmed = query.trim()
  if (!trimmed) return []
  const { data, error } = await supabase.rpc('search_all_chats', { p_query: trimmed, p_limit: limit })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as Array<Record<string, unknown>>).map(row => ({
    messageId: row.message_id as string,
    conversationId: row.conversation_id as string,
    kind: (row.kind as AllChatsSearchHit['kind']) ?? 'dm',
    conversationTitle: ((row.conversation_title as string) ?? 'Conversation'),
    senderId: (row.sender_id as string | null) ?? null,
    senderName: ((row.sender_name as string) ?? 'Student'),
    body: ((row.body as string) ?? ''),
    createdAt: ((row.created_at as string) ?? ''),
  }))
}

/**
 * Forward one of my messages into another of my conversations. Media
 * attachments are FIRST copied into the target conversation's own folder
 * (with my own session — the receiver would otherwise need rights on the
 * source chat), then the RPC writes the copied metadata. Returns the new
 * message.
 */
export async function forwardChatMessage(
  messageId: string,
  targetConversationId: string,
  attachments?: ChatAttachment[],
): Promise<ChatMessage> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('forward_chat_message', {
    p_message: messageId,
    p_target: targetConversationId,
    p_attachments: attachments?.length ? attachments : null,
  })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (data ?? []) as unknown as ChatMessageRow[]
  const row = rows[0]
  if (!row) throw new Error('The message did not come back — reload the chat.')
  return mapChatMessage(row)
}

/** Copy ONE chat attachment into another conversation's folder, file by file. */
async function copyChatAttachment(
  attachment: ChatAttachment,
  targetConversationId: string,
): Promise<ChatAttachment> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  if (!attachment.path || !attachment.path.includes('/')) throw new Error('That file cannot be copied.')
  const dot = attachment.name.lastIndexOf('.')
  const ext = dot > -1 ? attachment.name.slice(dot).toLowerCase() : '.' + (attachment.path.split('.')[1] ?? 'bin').slice(0, 8)
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
  const newPath = `${targetConversationId}/${Date.now()}-${random}${ext}`
  // path A: server-side copy — no double download when the bucket allows it
  try {
    const { error } = await supabase.storage.from('chat-media').copy(attachment.path, newPath)
    if (!error) {
      return { path: newPath, name: attachment.name, mime: attachment.mime, size: attachment.size }
    }
  } catch {
    // fall through to the download path
  }
  // path B: download through a short-lived signed URL, re-upload with my
  // own session into the target conversation's folder
  const { data: urlData, error: urlError } = await supabase.storage
    .from('chat-media')
    .createSignedUrl(attachment.path, 300)
  if (urlError || !urlData?.signedUrl) throw new Error('That file could not be copied.')
  const response = await fetch(urlData.signedUrl)
  if (!response.ok) throw new Error('That file could not be copied.')
  const blob = await response.blob()
  const { error } = await supabase.storage
    .from('chat-media')
    .upload(newPath, blob, { cacheControl: '3600' })
  if (error) throw new Error(friendlyMessage(error))
  return { path: newPath, name: attachment.name, mime: attachment.mime, size: attachment.size }
}

export async function copyChatAttachments(
  attachments: ChatAttachment[],
  targetConversationId: string,
): Promise<ChatAttachment[]> {
  const copied: ChatAttachment[] = []
  for (const attachment of attachments.slice(0, 4)) {
    copied.push(await copyChatAttachment(attachment, targetConversationId))
  }
  return copied
}

/**
 * Typing indicators: ONE realtime BROADCAST channel per open conversation.
 * Nothing is ever written to the database, and any interruption just lets
 * the indicator expire (no stale "typing…" survives 3.5 seconds).
 * Returns a `ping()` for the sender + an unsubscribe.
 */
export type TypingPing = { userId: string; at: number }

export function subscribeTyping(
  conversationId: string,
  myUserId: string,
  onTypingChange: (typingUserIds: string[]) => void,
): { ping: () => Promise<void>; unsubscribe: () => void } {
  if (!supabase) {
    return { ping: async () => {}, unsubscribe: () => {} }
  }
  const client = supabase
  const typing = new Map<string, number>() // userId → last ping (ms epoch)
  /** The sweeper runs on a timer, but the subscriber callback fires ONLY
   *  when the set of typers actually changed — an idle open thread stays
   *  render-silent instead of re-rendering every 1.2 s. */
  let lastEmittedSig = '' // comma-joined typer ids, '' = nobody
  const emit = () => {
    const now = Date.now()
    for (const [userId, at] of [...typing]) {
      if (now - at > 3500) typing.delete(userId)
    }
    const ids = [...typing.keys()].filter(userId => userId !== myUserId)
    const sig = ids.join(',')
    if (sig === lastEmittedSig) return
    lastEmittedSig = sig
    onTypingChange(ids)
  }

  const channel = client.channel(`typing:${conversationId}`)
    .on('broadcast', { event: 'typing' }, payload => {
      const ping = (payload.payload ?? {}) as TypingPing
      if (!ping?.userId || ping.userId === myUserId) return
      typing.set(ping.userId, Date.now())
      emit()
    })
    .subscribe()
  const sweeper = window.setInterval(emit, 1200)

  return {
    ping: async () => {
      // send on the SAME subscription — no per-ping channel setup
      await channel.send({
        type: 'broadcast',
        event: 'typing',
        payload: { userId: myUserId, at: Date.now() } satisfies TypingPing,
      })
    },
    unsubscribe: () => {
      window.clearInterval(sweeper)
      void client.removeChannel(channel)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

export type PersonResult = {
  id: string
  username: string | null
  displayName: string
  avatarUrl: string | null
  collegeShort: string | null
  isPrivate: boolean
  isVerified: boolean
}

type MemberRow = {
  id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  college_short_name: string | null
  is_private: boolean
  is_verified?: boolean | null
}

/** Find members by display name or @username (self excluded server-side). */
export async function searchMembers(query: string, limit = 10): Promise<PersonResult[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const trimmed = query.trim()
  if (!trimmed) return []
  const { data, error } = await supabase.rpc('search_members', { p_query: trimmed, p_limit: limit })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as MemberRow[]).map(row => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name?.trim() || (row.username ? `@${row.username}` : 'Student'),
    avatarUrl: row.avatar_url,
    collegeShort: row.college_short_name,
    isPrivate: Boolean(row.is_private),
    isVerified: Boolean(row.is_verified),
  }))
}

/** Verify (or unverify) a member's profile — admin-only; server re-checks. */
export async function setProfileVerified(targetId: string, verified: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('set_profile_verified', {
    p_user: targetId,
    p_verified: verified,
  })
  if (error) throw new Error(friendlyMessage(error))
}

/** Find published posts whose body matches; authors stay hidden if anonymous. */
export async function searchPosts(query: string, limit = 10): Promise<CampusPost[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const trimmed = query.trim()
  if (!trimmed) return []
  const { data, error } = await supabase.rpc('search_posts', { p_query: trimmed, p_limit: limit })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as FeedRow[]).map(mapFeedRow)
}

/**
 * Load one post (or reel) by id for shared deep links (#p/<id>). Anonymous
 * or missing posts return null — the caller decides the message. Requires
 * migration 0012_share_links.sql.
 */
export async function fetchPostById(postId: string): Promise<CampusPost | null> {
  if (!supabase) return null
  const { data, error } = await supabase.rpc('get_public_post', { p_post: postId })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (data ?? []) as FeedRow[]
  return rows.length ? mapFeedRow(rows[0]) : null
}

/** Shareable link for a post or reel — a hash the app reads on boot. */
export function postLink(postId: string): string {
  if (typeof window === 'undefined') return `/#p/${postId}`
  return `${window.location.origin}${window.location.pathname}#p/${postId}`
}

/** Copy text to the clipboard; returns an error message or null. */
export async function copyToClipboard(text: string): Promise<string | null> {
  try {
    if (!navigator.clipboard?.writeText) return 'Your browser does not offer a clipboard here.'
    await navigator.clipboard.writeText(text)
    return null
  } catch {
    return 'Your browser blocked the clipboard. Select the text instead.'
  }
}

/**
 * Real follow suggestions: actual member profiles, same college first.
 * Excludes the signed-in user. Private profiles are skipped — there is no
 * follow-request flow yet, so suggesting a locked account would mislead.
 */
export async function fetchFollowSuggestions(
  excludeUserId: string,
  collegeId?: string | null,
  limit = 3,
): Promise<FollowSuggestion[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const client = supabase
  type Row = { id: string; username: string | null; display_name: string | null }
  const load = async (sameCollege: boolean): Promise<Row[]> => {
    let query = client
      .from('profiles')
      .select('id, username, display_name')
      .eq('is_private', false)
      .eq('role', 'member') // 0043: staff never appear as follow suggestions
      .not('username', 'is', null)
      .neq('id', excludeUserId)
      .limit(24)
    if (sameCollege && collegeId) query = query.eq('college_id', collegeId)
    const { data, error } = await query
    if (error) throw new Error(friendlyMessage(error))
    return (data ?? []) as Row[]
  }

  // same-college classmates first, then anyone public to fill the panel
  let rows = await load(true)
  if (rows.length < limit) {
    const seen = new Set(rows.map(row => row.username))
    rows = [...rows, ...(await load(false)).filter(row => !seen.has(row.username))]
  }
  // shuffle so the panel varies between loads but still shows real members
  return rows
    .map(row => ({ row, k: Math.random() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, limit)
    .map(({ row }) => ({
      id: row.id,
      username: row.username ?? '',
      name: row.display_name?.trim() || `@${row.username ?? 'student'}`,
    }))
    .filter(s => s.username)
}

/**
 * Load one page of Reel posts for the Discover page via list_public_reels
 * (migration 0004). Paginated: pass offset = page * limit as the user
 * scrolls; an empty/short page means there are no more reels.
 */
export async function fetchReels(limit = 8, offset = 0): Promise<CampusPost[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_public_reels', {
    p_limit: Math.min(Math.max(limit, 1), 50),
    p_offset: Math.max(offset, 0),
  })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (data ?? []) as FeedRow[]
  return rows.map(row => mapFeedRow(row))
}

export type CreatePostInput = {
  userId: string
  body: string
  kind: PostKind
  isAnonymous: boolean
  collegeId: string | null
  collegeShort: string
  authorName: string
  authorUsername: string
  mediaUrls?: string[] | null
  /** 0016: when set, the post belongs to a community (RLS checks membership) */
  communityId?: string | null
}

/**
 * Insert a post and return it in the feed shape. Confessions stay attributed
 * in the database (RLS requires a real author) but list_public_posts() hides
 * the author fields for is_anonymous rows, so the feed still shows "Anonymous".
 */
export async function createPost(input: CreatePostInput): Promise<CampusPost> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('posts')
    .insert({
      author_id: input.userId,
      college_id: input.collegeId,
      body: input.body,
      kind: input.kind,
      is_anonymous: input.isAnonymous,
      is_published: true,
      media_urls: input.mediaUrls ?? [],
      ...(input.communityId ? { community_id: input.communityId } : {}),
    })
    .select('id, author_id, college_id, body, kind, media_urls, is_anonymous, is_published, created_at')
    .single()
  if (error) throw new Error(friendlyMessage(error))
  const row = data as unknown as {
    id: string
    body: string
    kind: string
    is_anonymous: boolean
    media_urls: string[] | null
    created_at: string
    author_id: string | null
    edited_at: string | null
  }
  const name = input.isAnonymous ? 'Anonymous' : input.authorName || 'Student'
  const username = input.isAnonymous ? '' : input.authorUsername
  const kind: PostKind = row.kind === 'confession' || row.kind === 'poll' || row.kind === 'reel' ? row.kind : 'post'
  return {
    id: row.id,
    author: name,
    handle: username ? `@${username}` : '',
    initials: input.isAnonymous ? '' : initialsFor(name, username),
    college: input.isAnonymous ? '' : input.collegeShort,
    time: 'just now',
    body: row.body ?? '',
    likes: 0,
    comments: 0,
    reposts: 0,
    kind,
    media: row.media_urls ?? [],
    authorId: row.author_id,
    editedAt: null,
    trending: false,
    anonymous: input.isAnonymous,
    liked: false,
    saved: false,
    reposted: false,
    tag: input.isAnonymous ? input.collegeShort : '',
  }
}

/* -------------------------------------------------------------------------- */
/* Polls (migration 0028)                                                      */
/* -------------------------------------------------------------------------- */

import type { PollState } from '../types'

type PollStateRow = {
  post_id: string
  multiple_choice: boolean
  closes_at: string | null
  is_open: boolean
  total_votes: number | string
  options: { id: string; label: string; position: number; votes: number | string; mine: boolean }[]
}

function mapPollRow(row: PollStateRow, fallbackId?: string): PollState {
  return {
    postId: row?.post_id ?? fallbackId ?? '',
    multipleChoice: Boolean(row?.multiple_choice),
    closesAt: row?.closes_at ?? null,
    isOpen: Boolean(row?.is_open),
    totalVotes: Number(row?.total_votes ?? 0),
    options: (row?.options ?? []).map(option => ({
      id: String(option.id),
      label: String(option.label ?? ''),
      position: Number(option.position ?? 0),
      votes: Number(option.votes ?? 0),
      mine: Boolean(option.mine),
    })),
  }
}

/** PGRST202/“Could not find the function” means migration 0028 has not been
 *  applied — say exactly that instead of a generic failure. */
function pollBackedMessage(error: unknown): string {
  const raw = String((error as { message?: string } | null)?.message ?? '')
  if (/Could not find the function|schema cache|PGRST202|PGRST20[45]/i.test(raw)) {
    return 'Polls are not enabled on the server yet. Apply supabase/migrations/0028_polls.sql in the Supabase SQL editor.'
  }
  return friendlyMessage(error)
}

/**
 * Authoritative snapshot for a batch of posts (one call per feed page).
 * `{ id: state }`; posts outside the batch simply stay absent. A returned
 * state is NEVER fabricated client-side — totals always come from the DB.
 */
export async function fetchPollStates(postIds: string[]): Promise<Record<string, PollState>> {
  if (!supabase || postIds.length === 0) return {}
  const { data, error } = await supabase.rpc('poll_states', { p_ids: postIds })
  if (error) throw new Error(pollBackedMessage(error))
  const out: Record<string, PollState> = {}
  for (const row of (data ?? []) as PollStateRow[]) out[row.post_id] = mapPollRow(row)
  return out
}

/**
 * Replace the caller's selections on one poll and return the fresh state.
 * The client sends only option ids — everything else is re-validated by the
 * RPC (expiry, option ownership, single-choice restriction).
 */
export async function castPollVote(postId: string, optionIds: string[]): Promise<PollState> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('cast_poll_vote', {
    p_post_id: postId,
    p_option_ids: optionIds,
  })
  if (error) throw new Error(pollBackedMessage(error))
  const rows = (data ?? []) as PollStateRow[]
  if (!rows.length) throw new Error('Your vote could not be recorded — try again.')
  return mapPollRow(rows[0], postId)
}

export type CreatePollInput = CreatePostInput & {
  options: string[]
  multipleChoice: boolean
  closeDays: number
}

/**
 * Publish a poll (post + options + settings in one server transaction).
 * Returns the post in feed shape; the poll block itself stays undefined
 * until the caller hydrates its real state — nothing is invented here.
 */
export async function createPoll(input: CreatePollInput): Promise<CampusPost> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('create_poll', {
    p_body: input.body,
    p_options: input.options,
    p_multiple_choice: input.multipleChoice,
    p_close_days: input.closeDays,
  })
  if (error) throw new Error(pollBackedMessage(error))
  const row = ((data ?? []) as { id: string; created_at: string }[])[0]
  if (!row?.id) throw new Error('The poll server did not return a post id — try again.')
  const name = input.authorName || 'Student'
  const username = input.authorUsername
  return {
    id: row.id,
    author: name,
    handle: username ? `@${username}` : '',
    initials: initialsFor(name, username),
    college: input.collegeShort,
    time: 'just now',
    body: input.body.trim(),
    likes: 0,
    comments: 0,
    reposts: 0,
    kind: 'poll',
    media: [],
    authorId: input.userId,
    editedAt: null,
    trending: false,
    anonymous: false,
    liked: false,
    saved: false,
    reposted: false,
    tag: '',
    poll: undefined,
  }
}

/** hydrate + merge a poll map into posts; failed lookups mark `poll: null` */
export async function pollStatesFor(posts: CampusPost[]): Promise<Record<string, PollState | null>> {
  const ids = Array.from(new Set(posts.filter(p => p.kind === 'poll').map(p => p.id)))
  if (!ids.length) return {}
  try {
    return await fetchPollStates(ids)
  } catch {
    const failed: Record<string, PollState | null> = {}
    for (const id of ids) failed[id] = null
    return failed
  }
}

/* -------------------------------------------------------------------------- */
/* Confessions page (migration 0028)                                           */
/* -------------------------------------------------------------------------- */

export type ConfessionSort = 'latest' | 'trending'

/**
 * One page of the dedicated confessions feed. Returns only eligible
 * confession posts; the RPC keeps author fields NULL for anonymous rows,
 * so real identities can never cross this boundary.
 */
export async function fetchConfessions(options: {
  sort: ConfessionSort
  collegeId?: string | null
  limit?: number
  offset?: number
}): Promise<{ posts: CampusPost[]; total: number }> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50)
  const offset = Math.max(options.offset ?? 0, 0)
  const { data, error } = await supabase.rpc('list_confessions', {
    p_sort: options.sort,
    p_college_id: options.collegeId ?? null,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) {
    const raw = String((error as { message?: string } | null)?.message ?? '')
    if (/Could not find the function|schema cache|PGRST202|PGRST20[45]/i.test(raw)) {
      throw new Error('The confessions feed is not enabled on the server yet. Apply supabase/migrations/0028_polls.sql in the Supabase SQL editor.')
    }
    throw new Error(friendlyMessage(error))
  }
  type ConfessionRow = FeedRow & { total_count: number | string }
  const rows = (data ?? []) as ConfessionRow[]
  const total = rows.length ? Number(rows[0].total_count ?? 0) : 0
  return { posts: rows.map(row => mapFeedRow(row)), total }
}

/**
 * Like / unlike a post. post_likes uses a composite key (user_id, post_id), so
 * the like side is an upsert — a re-press can never create a duplicate.
 */
export async function toggleLike(postId: string, userId: string, liked: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  if (liked) {
    const { error } = await supabase.from('post_likes').upsert({ user_id: userId, post_id: postId })
    if (error) throw new Error(friendlyMessage(error))
  } else {
    const { error } = await supabase.from('post_likes').delete().eq('user_id', userId).eq('post_id', postId)
    if (error) throw new Error(friendlyMessage(error))
  }
}

/* -------------------------------------------------------------------------- */
/* Post media (images + reels)                                                 */
/* -------------------------------------------------------------------------- */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024

/* -------------------------------------------------------------------------- */
/* Comments (migration 0005)                                                   */
/* -------------------------------------------------------------------------- */

export type CampusComment = {
  id: string
  parentId: string | null
  pinnedAt: string | null
  body: string
  time: string
  editedAt: string | null
  authorId: string
  author: string
  handle: string
  initials: string
  authorVerified: boolean
  likes: number
  likedByMe: boolean
}

type CommentRow = {
  id: string
  post_id: string
  parent_id: string | null
  body: string
  created_at: string
  edited_at: string | null
  pinned_at: string | null
  author_id: string
  author_display_name: string | null
  author_username: string | null
  author_avatar_url: string | null
  author_is_verified?: boolean | null
  like_count?: number | string | null
  liked_by_me?: boolean | null
}

function mapComment(row: CommentRow): CampusComment {
  const name = row.author_display_name || 'Student'
  const username = row.author_username
  return {
    id: row.id,
    parentId: row.parent_id,
    pinnedAt: row.pinned_at,
    body: row.body,
    time: relativeTime(row.created_at),
    editedAt: row.edited_at,
    authorId: row.author_id,
    author: name,
    handle: username ? `@${username}` : '',
    initials: initialsFor(name, username ?? ''),
    authorVerified: Boolean(row.author_is_verified),
    likes: Number(row.like_count ?? 0),
    likedByMe: Boolean(row.liked_by_me),
  }
}

/** Load one post's comment thread, oldest first, via list_post_comments(). */
export async function fetchComments(postId: string): Promise<CampusComment[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_post_comments', { p_post_id: postId })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (data ?? []) as CommentRow[]
  return rows.map(row => mapComment(row))
}

/**
 * Add a comment (or a one-level reply when `parentId` is given) as the
 * signed-in member and return the fresh row. Authorship is enforced by RLS
 * (author_id = auth.uid()); reply depth by the 0011 trigger.
 */
export async function addComment(
  postId: string,
  userId: string,
  body: string,
  authorName: string,
  authorUsername: string,
  parentId?: string | null,
): Promise<CampusComment> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('post_comments')
    .insert({ post_id: postId, author_id: userId, body, parent_id: parentId ?? null })
    .select('id, post_id, body, created_at, edited_at, author_id')
    .single()
  if (error) throw new Error(friendlyMessage(error))
  if (!data) throw new Error('CAMPUS could not post that comment. Please sign in and try again.')
  const row = data as unknown as {
    id: string
    body: string
    created_at: string
    edited_at: string | null
    author_id: string | null
  }
  return {
    id: row.id,
    parentId: parentId ?? null,
    pinnedAt: null,
    body: row.body,
    time: relativeTime(row.created_at),
    editedAt: row.edited_at,
    authorId: row.author_id ?? userId,
    author: authorName || 'Student',
    handle: authorUsername ? `@${authorUsername}` : '',
    initials: initialsFor(authorName || 'Student', authorUsername),
    authorVerified: false,
    likes: 0,
    likedByMe: false,
  }
}

/** Toggle your like on a comment. The count on screen follows the database. */
export async function toggleCommentLike(commentId: string, userId: string, liked: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  if (liked) {
    const { error } = await supabase.from('comment_likes').insert({ comment_id: commentId, user_id: userId })
    if (error && !/duplicate key|23505/i.test(error.message ?? '')) throw new Error(friendlyMessage(error))
  } else {
    const { error } = await supabase
      .from('comment_likes')
      .delete()
      .eq('comment_id', commentId)
      .eq('user_id', userId)
    if (error) throw new Error(friendlyMessage(error))
  }
}

/** Pin (or unpin) one comment to the top of the thread — post author or admin. */
export async function setCommentPinned(commentId: string, pinned: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('set_comment_pinned', { p_comment: commentId, p_pinned: pinned })
  if (error) throw new Error(friendlyMessage(error))
}

/** Edit your own comment; stamps edited_at like posts do. */
export async function updateComment(commentId: string, body: string): Promise<string | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('post_comments')
    .update({ body, edited_at: new Date().toISOString() })
    .eq('id', commentId)
    .select('id, edited_at')
    .single()
  if (error) throw new Error(friendlyMessage(error))
  if (!data) throw new Error('CAMPUS could not save that edit. You can only edit your own comments.')
  return data.edited_at ?? null
}

/** Delete your own comment. RLS makes it a no-op for anyone else's. */
export async function deleteComment(commentId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('post_comments')
    .delete()
    .eq('id', commentId)
    .select('id')
  if (error) throw new Error(friendlyMessage(error))
  if (!data || data.length === 0) {
    throw new Error('CAMPUS could not delete that comment. You can only delete your own comments.')
  }
}

/** Validate a picked image or video for a post/reel. Returns an error message or null. */
export function validateMediaFile(file: File, kind: 'image' | 'video'): string | null {
  if (kind === 'image' && !file.type.startsWith('image/')) return 'Attach an image file (JPG, PNG or WebP).'
  if (kind === 'video' && !file.type.startsWith('video/')) return 'Attach a video file (MP4 or WebM) to post a reel.'
  if (file.size > MAX_MEDIA_BYTES) return 'That file is over 25 MB. Please pick a smaller one.'
  return null
}

/**
 * Upload a post image or reel video to the 'media' bucket (migration 0002)
 * and return its public URL.
 */
export async function uploadMedia(userId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const extension = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const path = `${userId}/${Date.now()}.${extension}`
  const { error } = await supabase.storage.from('media').upload(path, file, { cacheControl: '3600', upsert: false })
  if (error) throw new Error(friendlyMessage(error))
  const { data } = supabase.storage.from('media').getPublicUrl(path)
  return data.publicUrl
}

/* -------------------------------------------------------------------------- */
/* Post CRUD (edit + delete own posts)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Save an edited post body and stamp edited_at (migration 0003). Confessions
 * cannot be edited (RLS blocks it — anonymity must not be reversible), which
 * surfaces as an honest error here.
 */
export async function updatePost(
  postId: string,
  body: string,
  options: { stampEdited?: boolean } = {},
): Promise<string | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const patch: Record<string, unknown> = { body }
  if (options.stampEdited !== false) patch.edited_at = new Date().toISOString()
  const { data, error } = await supabase
    .from('posts')
    .update(patch)
    .eq('id', postId)
    .select('id, edited_at')
    .single()
  if (error) throw new Error(friendlyMessage(error))
  if (!data) throw new Error('CAMPUS could not save your edit. You can only edit your own posts.')
  return data.edited_at ?? null
}

/**
 * Delete the author's own post. Likes and comments are cleaned up by the
 * database trigger from migration 0003.
 */
export async function deletePost(postId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase
    .from('posts')
    .delete()
    .eq('id', postId)
    .select('id')
  if (error) throw new Error(friendlyMessage(error))
  if (!data || data.length === 0) {
    throw new Error('CAMPUS could not delete that post. You can only delete your own posts.')
  }
}

/* -------------------------------------------------------------------------- */
/* Leaderboard (migration 0027)                                                */
/* -------------------------------------------------------------------------- */

export type LeaderboardCategory = 'overall' | 'college' | 'community' | 'creators' | 'events'
export type LeaderboardPeriod = 'week' | 'month' | 'all'

export type LeaderboardEntry = {
  userId: string
  displayName: string
  username: string | null
  avatarUrl: string | null
  isVerified: boolean
  collegeShortName: string | null
  points: number
  /** rank() over score — ties share the same rank */
  competitionRank: number
  /** stable display order (score desc, last earned asc, user id asc) */
  position: number
  lastEarnedAt: string | null
  /** position in the closed previous period (week/month only) */
  previousPosition: number | null
  /** negative = moved up, positive = moved down, 0 = same, null = new */
  movement: number | null
}

export type MyLeaderboardStanding = {
  status: 'ok' | 'no_college' | 'signed_out'
  points: number
  competitionRank: number | null
  position: number | null
  totalRanked: number
}

export type LeaderboardAchievement = {
  key: string
  label: string
  description: string
  earned: boolean
  progress: number
  target: number
}

export type LeaderboardRule = {
  activityType: string
  label: string
  points: number
  dailyCap: number
  enabled: boolean
}

type RawLeaderboardRow = {
  user_id: string
  display_name: string
  username: string | null
  avatar_url: string | null
  is_verified: boolean
  college_short_name: string | null
  points: number | string | null
  competition_rank: number | string | null
  display_position: number | string | null
  last_earned_at: string | null
  previous_position: number | string | null
  movement: number | null
}

function toInt(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? parsed : null
}

/** One ranked page of a category/period board. The list is a real server
 *  aggregation (security-definer SQL in migration 0027) — the browser never
 *  computes scores. Anonymous visitors get the public boards; the college
 *  board resolves the caller's own college server-side. */
export async function fetchLeaderboard(
  category: LeaderboardCategory,
  period: LeaderboardPeriod,
  offset = 0,
  limit = 50,
): Promise<LeaderboardEntry[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_leaderboard', {
    p_category: category, p_period: period, p_limit: limit, p_offset: offset,
  })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []).map((row: RawLeaderboardRow) => ({
    userId: row.user_id,
    displayName: row.display_name,
    username: row.username,
    avatarUrl: row.avatar_url,
    isVerified: row.is_verified,
    collegeShortName: row.college_short_name,
    points: toInt(row.points ?? 0),
    competitionRank: toInt(row.competition_rank ?? 0),
    position: toInt(row.display_position ?? 0),
    lastEarnedAt: row.last_earned_at,
    previousPosition: toIntOrNull(row.previous_position),
    movement: row.movement === null ? null : toInt(row.movement),
  }))
}

/** The signed-in member's own standing in a category/period. Distinguishes
 *  honestly between "ranked", "not ranked yet", and "no college selected". */
export async function fetchMyStanding(
  category: LeaderboardCategory,
  period: LeaderboardPeriod,
): Promise<MyLeaderboardStanding> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('leaderboard_me', {
    p_category: category, p_period: period,
  })
  if (error) throw new Error(friendlyMessage(error))
  const row = (data ?? [])[0]
  if (!row) return { status: 'ok', points: 0, competitionRank: null, position: null, totalRanked: 0 }
  return {
    status: (row.status as MyLeaderboardStanding['status']) ?? 'ok',
    points: toInt(row.points ?? 0),
    competitionRank: toIntOrNull(row.competition_rank),
    position: toIntOrNull(row.display_position),
    totalRanked: toInt(row.total_ranked ?? 0),
  }
}

/** Milestones for the signed-in member; computed server-side from real
 *  ledger history on every call, so they cannot be forged or re-granted. */
export async function fetchMyAchievements(): Promise<LeaderboardAchievement[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_my_achievements')
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []).map((row: Record<string, unknown>) => ({
    key: String(row.key ?? ''),
    label: String(row.label ?? ''),
    description: String(row.description ?? ''),
    earned: Boolean(row.earned),
    progress: toInt(row.progress ?? 0),
    target: toInt(row.target ?? 0),
  }))
}

/** The live scoring weights (from leaderboard_weights) for the "How points
 *  work" disclosure, so the stated rules always match what is enforced. */
export async function fetchLeaderboardRules(): Promise<LeaderboardRule[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('leaderboard_rules')
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []).map((row: Record<string, unknown>) => ({
    activityType: String(row.activity_type ?? ''),
    label: String(row.label ?? ''),
    points: toInt(row.points ?? 0),
    dailyCap: toInt(row.daily_cap ?? 0),
    enabled: Boolean(row.enabled),
  }))
}

/* ============================================================================ */
/* Notifications: center data, preferences, web-push subscriptions (0029)        */
/* ============================================================================ */

export type NotificationActor = {
  id: string
  username: string | null
  name: string | null
  avatar: string | null
}

export type NotificationItem = {
  id: string
  type: string
  entityType: string | null
  entityId: string | null
  metadata: Record<string, unknown>
  readAt: string | null
  createdAt: string
  slug: string | null
  title: string | null
  actor: NotificationActor | null
}

export type NotificationFilter =
  | 'all' | 'unread' | 'mention' | 'message' | 'community' | 'follow' | 'event'

/**
 * One paged, filtered read of the signed-in member's own notifications
 * via the definer RPC (recipient-scoped server-side; the client never
 * sees anybody else's rows even transiently).
 */
export async function fetchNotifications(
  filter: NotificationFilter = 'all',
  limit = 30,
  offset = 0,
): Promise<NotificationItem[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('list_notifications', {
    p_filter: filter,
    p_limit: Math.min(Math.max(limit, 1), 50),
    p_offset: Math.max(offset, 0),
  })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (data ?? []) as Record<string, unknown>[]
  return rows.map(row => {
    const actor = row.actor as Record<string, unknown> | null
    return {
      id: String(row.id ?? ''),
      type: String(row.type ?? ''),
      entityType: (row.entity_type as string | null) ?? null,
      entityId: (row.entity_id as string | null) ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? {},
      readAt: (row.read_at as string | null) ?? null,
      createdAt: String(row.created_at ?? ''),
      slug: (row.slug as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      actor: actor
        ? {
            id: String(actor.id ?? ''),
            username: (actor.username as string | null) ?? null,
            name: (actor.name as string | null) ?? null,
            avatar: (actor.avatar as string | null) ?? null,
          }
        : null,
    }
  })
}

/** Mark specific rows read (recipient-scoped updates, enforced by RLS). */
export async function markNotificationsRead(ids: string[]): Promise<void> {
  if (!supabase || ids.length === 0) return
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .in('id', ids)
    .is('read_at', null)
  if (error) throw new Error(friendlyMessage(error))
}

/** Mark every unread row read (optionally scoped to one filter). */
export async function markAllNotificationsRead(
  filter: NotificationFilter = 'all',
): Promise<void> {
  if (!supabase) return
  let query = supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null)
  if (filter === 'mention') query = query.in('type', ['post_mention', 'chat_mention'])
  else if (filter === 'message') query = query.eq('type', 'chat_message')
  else if (filter === 'community')
    query = query.in('type', [
      'club_join_accepted', 'club_join_rejected', 'club_invitation',
      'club_role_changed', 'club_banned', 'club_removed',
      'club_ownership', 'chat_reply', 'chat_mention',
    ])
  else if (filter === 'follow') query = query.eq('type', 'follow')
  else if (filter === 'event')
    query = query.in('type', ['event_updated', 'event_cancelled', 'event_registered', 'event_promoted'])
  const { error } = await query
  if (error) throw new Error(friendlyMessage(error))
}

/* Realtime: a targeted channel on MY notification rows only. INSERT=+1
   when unread, UPDATE (a read side-effect) settles the badge. The DB
   stays the source of truth; these events only move the UI. */
export function subscribeNotifications(
  myUserId: string,
  onChange: (event: 'insert' | 'update' | 'subscribed') => void,
): () => void {
  if (!supabase) return () => {}
  const client = supabase
  const channel = client
    .channel(`notifications:${myUserId.slice(0, 8)}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${myUserId}`,
      },
      () => onChange('insert'),
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${myUserId}`,
      },
      () => onChange('update'),
    )
    .subscribe(status => {
      if (status === 'SUBSCRIBED') onChange('subscribed')
    })
  return () => {
    void client.removeChannel(channel)
  }
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

export type NotificationPrefs = {
  likeInapp: boolean
  likePush: boolean
  commentInapp: boolean
  commentPush: boolean
  followInapp: boolean
  followPush: boolean
  mentionInapp: boolean
  mentionPush: boolean
  messageInapp: boolean
  messagePush: boolean
  communityInapp: boolean
  communityPush: boolean
  eventInapp: boolean
  eventPush: boolean
  marketplaceInapp: boolean
  marketplacePush: boolean
  messagePreview: boolean
  quietEnabled: boolean
  quietStart: string
  quietEnd: string
  timezone: string | null
}

type NotifPrefsRow = {
  user_id?: string
  like_inapp?: boolean | null
  like_push?: boolean | null
  comment_inapp?: boolean | null
  comment_push?: boolean | null
  follow_inapp?: boolean | null
  follow_push?: boolean | null
  mention_inapp?: boolean | null
  mention_push?: boolean | null
  message_inapp?: boolean | null
  message_push?: boolean | null
  community_inapp?: boolean | null
  community_push?: boolean | null
  event_inapp?: boolean | null
  event_push?: boolean | null
  marketplace_inapp?: boolean | null
  marketplace_push?: boolean | null
  message_preview?: boolean | null
  quiet_enabled?: boolean | null
  quiet_start?: string | null
  quiet_end?: string | null
  timezone?: string | null
}

function mapNotificationPrefs(row: NotifPrefsRow): NotificationPrefs {
  return {
    likeInapp: Boolean(row.like_inapp ?? true),
    likePush: Boolean(row.like_push ?? false),
    commentInapp: Boolean(row.comment_inapp ?? true),
    commentPush: Boolean(row.comment_push ?? true),
    followInapp: Boolean(row.follow_inapp ?? true),
    followPush: Boolean(row.follow_push ?? true),
    mentionInapp: Boolean(row.mention_inapp ?? true),
    mentionPush: Boolean(row.mention_push ?? true),
    messageInapp: Boolean(row.message_inapp ?? true),
    messagePush: Boolean(row.message_push ?? true),
    communityInapp: Boolean(row.community_inapp ?? true),
    communityPush: Boolean(row.community_push ?? true),
    eventInapp: Boolean(row.event_inapp ?? true),
    eventPush: Boolean(row.event_push ?? true),
    marketplaceInapp: Boolean(row.marketplace_inapp ?? true),
    marketplacePush: Boolean(row.marketplace_push ?? false),
    messagePreview: Boolean(row.message_preview ?? true),
    quietEnabled: Boolean(row.quiet_enabled ?? false),
    quietStart: String(row.quiet_start ?? '22:30'),
    quietEnd: String(row.quiet_end ?? '07:30'),
    timezone: (row.timezone as string | null) ?? null,
  }
}

/** Read (creating the row on first use) the member's notification prefs. */
export async function fetchNotificationPrefs(): Promise<NotificationPrefs> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('ensure_notification_prefs')
  if (error) throw new Error(friendlyMessage(error))
  return mapNotificationPrefs((data ?? {}) as NotifPrefsRow)
}

/** Persist a partial update; the RPC validates + downcasts every key.
    `null` is allowed for the timezone field (clears it). */
export async function saveNotificationPrefs(
  update: Partial<Record<string, boolean | string | null>>,
): Promise<NotificationPrefs> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const payload: Record<string, boolean | string | null> = {}
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) payload[key] = value
  }
  const { data, error } = await supabase.rpc('update_notification_prefs', {
    p_update: payload,
  })
  if (error) throw new Error(friendlyMessage(error))
  return mapNotificationPrefs((data ?? {}) as NotifPrefsRow)
}

/* -------------------------------------------------------------------------- */
/* Web-push subscriptions (VAPID)                                             */
/* -------------------------------------------------------------------------- */

export type PushSubscriptionRecord = {
  id: string
  endpoint: string
  createdAt: string
}

export async function savePushSubscription(sub: {
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string | null
}): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: sub.endpoint,
    p_p256dh: sub.p256dh,
    p_auth: sub.auth,
    p_user_agent: sub.userAgent ?? null,
  })
  if (error) throw new Error(friendlyMessage(error))
  return String(data ?? '')
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('remove_push_subscription', {
    p_endpoint: endpoint,
  })
  if (error) throw new Error(friendlyMessage(error))
}

export async function fetchPushSubscriptions(): Promise<PushSubscriptionRecord[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, created_at')
    .order('created_at', { ascending: false })
  if (error) throw new Error(friendlyMessage(error))
  return ((data ?? []) as Record<string, unknown>[]).map(row => ({
    id: String(row.id ?? ''),
    endpoint: String(row.endpoint ?? ''),
    createdAt: String(row.created_at ?? ''),
  }))
}

