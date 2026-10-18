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

  // Storage: ask the bucket list; the avatars bucket is created by migration 0001.
  let avatars = false
  try {
    const { data, error } = await client.storage.listBuckets()
    if (!error && Array.isArray(data)) avatars = data.some(bucket => bucket.id === 'avatars')
  } catch {
    avatars = false
  }

  return { loaded: true, profileExtras, suggestions, interests, blocks, usernameRpc, reports, avatars }
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
  memberCount: number
  lastBody: string | null
  lastAt: string | null
  unread: number
}

export type ChatMessage = {
  id: string
  conversationId: string
  senderId: string | null
  senderName: string
  /** empty for an unsent message — render the tombstone instead */
  body: string
  createdAt: string
  editedAt: string | null
  /** set when the sender unsent the message (Instagram-style tombstone) */
  deletedAt: string | null
}

type ChatMessageRow = {
  id: string
  conversation_id: string
  sender_id: string | null
  sender_username: string | null
  sender_display_name: string | null
  body: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
}

export function mapChatMessage(row: ChatMessageRow): ChatMessage {
  const name = row.sender_display_name?.trim() || 'Student'
  const unsent = Boolean(row.deleted_at)
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: name,
    body: unsent ? '' : (row.body as string),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
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
    memberCount: Number(row.member_count ?? 0),
    lastBody: (row.last_body as string) ?? null,
    lastAt: (row.last_at as string) ?? null,
    unread: Number(row.unread_count ?? 0),
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

/** Send one message; RLS guarantees sender = caller and membership. */
export async function sendChatMessage(conversationId: string, body: string, senderId: string): Promise<ChatMessage> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  // sender_id must be sent explicitly — the RLS policy checks it against
  // auth.uid(), and a NULL sender would fail that check
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({ conversation_id: conversationId, sender_id: senderId, body })
    .select('id, conversation_id, sender_id, body, created_at, edited_at, deleted_at')
    .single()
  if (error) throw new Error(friendlyMessage(error))
  const row = (data ?? {}) as Record<string, unknown>
  // sender name comes from identity at call site; db lookup not needed
  return mapChatMessage({
    id: row.id as string,
    conversation_id: row.conversation_id as string,
    sender_id: row.sender_id as string | null,
    sender_username: null,
    sender_display_name: null,
    body: row.body as string | null,
    created_at: row.created_at as string,
    edited_at: (row.edited_at as string | null) ?? null,
    deleted_at: (row.deleted_at as string | null) ?? null,
  })
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

/** Mark a conversation read by the caller (drives unread badges). */
export async function markConversationRead(conversationId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase
    .from('conversation_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
  if (error) throw new Error(friendlyMessage(error))
}

/**
 * Live message stream for one conversation via Supabase Realtime: INSERT for
 * new messages AND UPDATE for edits / unsends, so an open thread stays
 * up-to-the-second without any refetch. Returns an unsubscribe function;
 * callers dedupe inserts by message id and replace rows on update.
 */
export function subscribeChatMessages(
  conversationId: string,
  onChange: (message: ChatMessage, type: 'insert' | 'update') => void,
): () => void {
  if (!supabase) return () => {}
  const client = supabase
  const handle = (row: Record<string, unknown>, type: 'insert' | 'update') => {
    if (!row?.id) return
    onChange(mapChatMessage({
      id: row.id as string,
      conversation_id: (row.conversation_id as string) ?? conversationId,
      sender_id: (row.sender_id as string | null) ?? null,
      sender_username: null,
      sender_display_name: null,
      body: (row.body as string | null) ?? '',
      created_at: (row.created_at as string) ?? new Date().toISOString(),
      edited_at: (row.edited_at as string | null) ?? null,
      deleted_at: (row.deleted_at as string | null) ?? null,
    }), type)
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
