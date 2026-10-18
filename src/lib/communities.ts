import { supabase } from './supabase'
import { friendlyMessage } from './db'

/**
 * Typed data access for Communities (migration 0016).
 *
 * Communities live in the evolved legacy `clubs` table; membership in
 * `club_members`; posts reuse `posts.community_id`; events reuse the legacy
 * `events`/`event_rsvps` tables; chat reuses the existing conversations
 * (kind = 'club'); resources live in the private `resources` storage bucket.
 * Every mutation with authority behind it goes through a security-definer RPC,
 * and every error surfaces raw here — the UI never pretends a write succeeded.
 */

export type CommunityScope = 'global' | 'college'
export type CommunityPrivacy = 'public' | 'private' | 'hidden'

export const COMMUNITY_CATEGORIES = [
  'Academics',
  'Technology',
  'Projects',
  'Careers and Placements',
  'Clubs and Societies',
  'Campus Life',
  'Gaming',
  'Arts and Creativity',
  'Sports and Fitness',
  'Lifestyle',
  'Other',
] as const

export const MAX_RESOURCE_BYTES = 25 * 1024 * 1024

/** Must mirror the community_resources_filetype_check in 0016. */
const ALLOWED_RESOURCE_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'txt', 'md', 'zip',
  'png', 'jpg', 'jpeg', 'gif', 'ipynb',
]

export interface CommunitySummary {
  id: string
  slug: string
  name: string
  description: string
  logo_url: string | null
  cover_image_url: string | null
  category: string
  privacy: CommunityPrivacy
  scope: CommunityScope
  college_id: string | null
  college_name: string | null
  college_short_name: string | null
  member_count: number
  recent_post_at: string | null
  my_status: string | null
  my_role: string | null
  created_at: string
  created_by: string | null
  creator_name: string | null
}

export interface CommunityDetail {
  id: string
  slug: string
  name: string
  description: string
  logo_url: string | null
  cover_image_url: string | null
  category: string
  privacy: CommunityPrivacy
  scope: CommunityScope
  rules: string
  college_id: string | null
  college_name: string | null
  college_short_name: string | null
  member_count: number
  post_count: number
  event_count: number
  creator_id: string | null
  creator_name: string | null
  creator_username: string | null
  my_status: string | null
  my_role: string | null
  archived: boolean
  created_at: string
}

export interface CommunityMemberRow {
  user_id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  is_verified: boolean | null
  role: string
  status: string
  joined_at: string
}

export interface JoinRequestRow {
  user_id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  requested_at: string
}

export interface InviteSummary {
  invite_id: string
  club_id: string
  club_name: string
  club_slug: string | null
  club_privacy: string
  invited_by: string | null
  invited_by_username: string | null
  created_at: string
}

export interface CommunityFeedRow {
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
  author_is_verified: boolean | null
  college_id: string | null
  college_short_name: string | null
  like_count: number | string | null
  comment_count: number | string | null
  liked_by_me: boolean
  is_pinned: boolean
}

export interface ResourceRow {
  id: string
  title: string
  description: string
  link_url: string
  file_name: string | null
  mime_type: string | null
  file_size: number | null
  storage_path: string | null
  created_at: string
  uploader_id: string
  uploader_name: string | null
  uploader_username: string | null
  mine: boolean
}

export interface CommunityEventRow {
  id: string
  title: string
  description: string
  venue: string | null
  cover_url: string | null
  registration_url: string | null
  starts_at: string
  ends_at: string | null
  capacity: number | null
  going_count: number
  interested_count: number
  my_status: string | null
  is_organizer: boolean
  created_by: string | null
  creator_name: string | null
  past: boolean
  cancelled: boolean
}

export interface ListCommunitiesParams {
  query?: string
  scope?: 'any' | CommunityScope
  category?: string
  collegeId?: string | null
  membership?: 'any' | 'member'
  sort?: 'popular' | 'new' | 'relevant'
  limit?: number
  offset?: number
}

export async function listCommunities(params: ListCommunitiesParams = {}): Promise<CommunitySummary[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_clubs', {
    p_query: params.query ?? '',
    p_scope: params.scope ?? 'any',
    p_category: params.category ?? 'any',
    p_college_id: params.collegeId ?? null,
    p_membership: params.membership ?? 'any',
    p_sort: params.sort ?? 'popular',
    p_limit: params.limit ?? 24,
    p_offset: params.offset ?? 0,
  })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as CommunitySummary[]
}

/** null when the community does not exist / is hidden from this viewer.
 *  `club_detail` is a table-returning RPC, so PostgREST hands us an ARRAY of
 *  rows — unwrap it; an empty array means "no row visible to this viewer". */
export async function communityDetail(clubId: string): Promise<CommunityDetail | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('club_detail', { p_club: clubId })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (Array.isArray(data) ? data : [data]) as CommunityDetail[]
  return rows[0] ?? null
}

/** Share links use #c/<slug>: resolve the slug to a community id.
 *  Hidden communities stay invisible to whoever does not belong. */
export async function communityIdFromSlug(slug: string): Promise<string | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('club_id_by_slug', { p_slug: slug })
  if (error) {
    if (/does not exist/i.test(String((error as { message?: string }).message ?? ''))) return null
    throw new Error(friendlyMessage(error))
  }
  return (data as string | null) ?? null
}

export interface CreateCommunityInput {
  name: string
  slug?: string
  description?: string
  category: string
  scope: CommunityScope
  collegeId: string | null
  privacy: CommunityPrivacy
  rules?: string
  logoUrl?: string | null
  coverUrl?: string | null
}

export async function createCommunity(input: CreateCommunityInput): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('create_club', {
    p_name: input.name,
    p_slug: input.slug ?? '',
    p_description: input.description ?? '',
    p_category: input.category,
    p_college_id: input.scope === 'college' ? input.collegeId : null,
    p_privacy: input.privacy,
    p_rules: input.rules ?? '',
    p_logo_url: input.logoUrl ?? null,
    p_cover_url: input.coverUrl ?? null,
  })
  if (error) throw new Error(friendlyMessage(error))
  return data as string
}

/** 'joined' for open communities, 'requested' when a moderator must approve. */
export async function joinCommunity(clubId: string): Promise<'joined' | 'requested'> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('join_club', { p_club: clubId })
  if (error) throw new Error(friendlyMessage(error))
  return (data as string) === 'requested' ? 'requested' : 'joined'
}

export async function leaveCommunity(clubId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('leave_club', { p_club: clubId })
  if (error) throw new Error(friendlyMessage(error))
}

export async function cancelJoinRequest(clubId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('cancel_join_request', { p_club: clubId })
  if (error) throw new Error(friendlyMessage(error))
}

export async function respondJoinRequest(clubId: string, userId: string, accept: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('respond_join_request', {
    p_club: clubId,
    p_user: userId,
    p_action: accept ? 'accept' : 'reject',
  })
  if (error) throw new Error(friendlyMessage(error))
}

export async function inviteToCommunity(clubId: string, userId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('invite_member', { p_club: clubId, p_user: userId })
  if (error) throw new Error(friendlyMessage(error))
}

/** The invitations waiting for me — the only sanctioned read of
 *  community_invitations (the table itself carries no SELECT policy by
 *  design; everything flows through these definer RPCs). */
export async function fetchMyInvites(): Promise<InviteSummary[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('list_my_club_invites')
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as InviteSummary[]
}

export async function respondInvite(inviteId: string, accept: boolean): Promise<'accepted' | 'declined'> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('respond_invite', { p_invite: inviteId, p_accept: accept })
  if (error) throw new Error(friendlyMessage(error))
  return (data as string) === 'accepted' ? 'accepted' : 'declined'
}

export async function setMemberRole(clubId: string, userId: string, role: 'member' | 'moderator'): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('set_member_role', { p_club: clubId, p_user: userId, p_role: role })
  if (error) throw new Error(friendlyMessage(error))
}

/** Ban keeps a row so the person cannot re-request membership themselves. */
export async function removeMember(clubId: string, userId: string, ban: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('remove_member', { p_club: clubId, p_user: userId, p_ban: ban })
  if (error) throw new Error(friendlyMessage(error))
}

export async function transferOwnership(clubId: string, userId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('transfer_ownership', { p_club: clubId, p_user: userId })
  if (error) throw new Error(friendlyMessage(error))
}

export async function archiveCommunity(clubId: string, archive: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('archive_club', { p_club: clubId, p_archive: archive })
  if (error) throw new Error(friendlyMessage(error))
}

export async function setPostPin(clubId: string, postId: string, pinned: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('set_club_post_pin', { p_club: clubId, p_post: postId, p_pinned: pinned })
  if (error) throw new Error(friendlyMessage(error))
}

export interface CommunityFeedParams {
  clubId: string
  limit?: number
  offset?: number
}

export async function fetchCommunityFeed(params: CommunityFeedParams): Promise<CommunityFeedRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_club_posts', {
    p_club: params.clubId,
    p_limit: params.limit ?? 20,
    p_offset: params.offset ?? 0,
  })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as CommunityFeedRow[]
}

export async function fetchCommunityMembers(
  clubId: string,
  query = '',
  limit = 60,
  offset = 0,
): Promise<CommunityMemberRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_club_members', {
    p_club: clubId,
    p_query: query,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as CommunityMemberRow[]
}

export async function fetchJoinRequests(clubId: string): Promise<JoinRequestRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_join_requests', { p_club: clubId })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as JoinRequestRow[]
}

/** Existing chats infrastructure: kind = 'club' conversations never surface
 *  in the personal Chats list; they open through the community detail page. */
export async function openCommunityChat(clubId: string): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('open_club_chat', { p_club: clubId })
  if (error) throw new Error(friendlyMessage(error))
  return data as string
}

/* -------------------------------------------------------------------------- */
/* Resources                                                                   */
/* -------------------------------------------------------------------------- */

export function resourceExtension(file: File): string {
  const name = file.name.toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1)
}

/** Client-side pre-check of the same rules the storage RLS + table checks
 *  enforce — a nicer error before bytes ever leave the browser. */
export function resourceUploadProblem(file: File): string | null {
  if (file.size <= 0) return 'That file looks empty.'
  if (file.size > MAX_RESOURCE_BYTES) return 'Files can be at most 25 MB.'
  const ext = resourceExtension(file)
  if (!ALLOWED_RESOURCE_EXTENSIONS.includes(ext)) {
    return `.${ext || '(none)'} files are not supported here.`
  }
  return null
}

/** Uploads the bytes into the member-gated resources bucket, under
 *  <club>/<uploader>/ so storage RLS carries the authority. Returns the path
 *  that addCommunityResource() then registers as metadata. */
export async function uploadResourceFile(clubId: string, uploaderId: string, file: File): Promise<{ path: string; name: string; size: number; mime: string }> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const problem = resourceUploadProblem(file)
  if (problem) throw new Error(problem)
  const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120) || 'file'
  const path = `${clubId}/${uploaderId}/${Date.now()}-${safeName}`
  const { error } = await supabase.storage
    .from('resources')
    .upload(path, file, { cacheControl: '3600', upsert: false })
  if (error) throw new Error(friendlyMessage(error))
  return { path, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }
}

export interface AddResourceInput {
  clubId: string
  title: string
  description?: string
  linkUrl?: string
  upload?: { path: string; name: string; size: number; mime: string } | null
}

export async function addCommunityResource(input: AddResourceInput): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('add_club_resource', {
    p_club: input.clubId,
    p_title: input.title,
    p_description: input.description ?? '',
    p_link_url: input.linkUrl ?? '',
    p_storage_path: input.upload?.path ?? null,
    p_file_name: input.upload?.name ?? null,
    p_mime_type: input.upload?.mime ?? null,
    p_file_size: input.upload?.size ?? null,
  })
  if (error) throw new Error(friendlyMessage(error))
  return data as string
}

/** Short-lived signed URL for a private resource file (one hour). */
export async function resourceDownloadUrl(path: string): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.storage.from('resources').createSignedUrl(path, 3600)
  if (error) throw new Error(friendlyMessage(error))
  if (!data?.signedUrl) throw new Error('Could not open the file — try again.')
  return data.signedUrl
}

export async function deleteCommunityResource(row: ResourceRow): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  if (row.storage_path) {
    const { error: storageError } = await supabase.storage.from('resources').remove([row.storage_path])
    if (storageError) throw new Error(friendlyMessage(storageError))
  }
  const { error } = await supabase.from('community_resources').delete().eq('id', row.id)
  if (error) throw new Error(friendlyMessage(error))
}

export async function fetchCommunityResources(clubId: string): Promise<ResourceRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_club_resources', { p_club: clubId })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as ResourceRow[]
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export interface SaveEventInput {
  clubId: string
  eventId?: string | null
  title: string
  description?: string
  venue?: string
  startAt: string
  endAt?: string | null
  coverUrl?: string | null
  registrationUrl?: string
  capacity?: number | null
}

export async function saveCommunityEvent(input: SaveEventInput): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('save_club_event', {
    p_club: input.clubId,
    p_event: input.eventId ?? null,
    p_title: input.title,
    p_description: input.description ?? '',
    p_venue: input.venue ?? '',
    p_start_at: input.startAt,
    p_end_at: input.endAt ?? null,
    p_cover_url: input.coverUrl ?? null,
    p_registration_url: input.registrationUrl ?? '',
    p_capacity: input.capacity ?? null,
  })
  if (error) throw new Error(friendlyMessage(error))
  return data as string
}

export async function deleteCommunityEvent(eventId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('delete_club_event', { p_event: eventId })
  if (error) throw new Error(friendlyMessage(error))
}

export async function fetchCommunityEvents(clubId: string): Promise<CommunityEventRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_club_events', { p_club: clubId })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as CommunityEventRow[]
}

/** 'going' | 'interested' | 'not_going' — the RPC answers with the stored state. */
export async function rsvpEvent(eventId: string, status: 'going' | 'interested' | 'not_going'): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('rsvp_event', { p_event: eventId, p_status: status })
  if (error) throw new Error(friendlyMessage(error))
  return data as string
}

/* -------------------------------------------------------------------------- */
/* Reports + live activity                                                     */
/* -------------------------------------------------------------------------- */

export async function reportCommunity(clubId: string, reason: string, details = ''): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('report_club', { p_club: clubId, p_reason: reason, p_details: details })
  if (error) throw new Error(friendlyMessage(error))
}

export interface CommunityReportRow {
  id: string
  reason: string
  details: string | null
  status: string
  created_at: string
  reporter_name: string | null
}

export async function fetchCommunityReports(clubId: string): Promise<CommunityReportRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_club_reports', { p_club: clubId })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as CommunityReportRow[]
}

/**
 * Community-level live feed: any post INSERT/UPDATE/DELETE inside this
 * community pings the callback so the feed refreshes without navigation.
 * Realtime is already gated by RLS — only rows you may read arrive.
 */
export function subscribeCommunityPosts(
  clubId: string,
  onChange: () => void,
): () => void {
  if (!supabase) return () => {}
  const client = supabase
  const channel = client
    .channel(`community:${clubId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'posts', filter: `community_id=eq.${clubId}` },
      () => onChange(),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'posts', filter: `community_id=eq.${clubId}` },
      () => onChange(),
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'posts', filter: `community_id=eq.${clubId}` },
      () => onChange(),
    )
    .subscribe()
  return () => {
    void client.removeChannel(channel)
  }
}
