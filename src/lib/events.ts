import { supabase } from './supabase'
import { friendlyMessage } from './db'

/**
 * Typed data access for Events (migration 0018).
 *
 * Events reuse the legacy `events` / `event_rsvps` tables — one registration
 * system for community RSVPs, global registrations, capacity + waitlist.
 * Every mutation with authority behind it goes through a security-definer RPC
 * and every error surfaces raw here — the UI never pretends a write succeeded.
 */

export const EVENT_CATEGORIES = [
  'College Festivals',
  'Hackathons',
  'Workshops',
  'Technical Events',
  'Seminars and Webinars',
  'Placements and Career Fairs',
  'Cultural Events',
  'Sports',
  'Clubs and Societies',
  'Competitions',
  'Networking',
  'Other',
] as const

export type EventAudience = 'public' | 'college' | 'community'
export type EventEligibility = 'everyone' | 'college' | 'community'
export type EventRegType = 'rsvp' | 'registration'
export type EventFormat = 'offline' | 'online' | 'hybrid'
export type EventMode =
  | 'discover' | 'foryou' | 'mycollege' | 'following'
  | 'upcoming' | 'past' | 'registered' | 'saved' | 'organized'
export type EventSort = 'recommended' | 'soonest' | 'new'

export interface EventSummary {
  id: string
  slug: string
  title: string
  summary: string | null
  category: string
  tags: string[] | null
  cover_url: string | null
  format: EventFormat
  venue: string | null
  venue_address: string | null
  city: string | null
  map_url: string | null
  starts_at: string
  ends_at: string | null
  timezone_name: string
  audience: EventAudience
  reg_eligibility: EventEligibility
  reg_type: EventRegType
  reg_opens_at: string | null
  reg_deadline: string | null
  registration_url: string | null
  capacity: number | null
  seats_taken: number | string | null
  going_count: number | string | null
  interested_count: number | string | null
  featured: boolean
  published: boolean
  cancelled_at: string | null
  created_at: string
  updated_at: string | null
  college_id: string | null
  college_name: string | null
  college_short_name: string | null
  club_id: string | null
  club_name: string | null
  club_slug: string | null
  organizer_id: string | null
  organizer_name: string | null
  organizer_username: string | null
  my_status: string | null
  saved: boolean
  can_manage: boolean
}

/** Detail additionally carries the full description and — for authorized
 *  viewers only — the online meeting link and instructions. */
export interface EventDetailRow extends EventSummary {
  description: string | null
  online_url: string | null
  access_notes: string | null
  waitlist_enabled: boolean
  links_revealed: boolean
}

export interface AttendeeRow {
  user_id: string
  display_name: string | null
  username: string | null
  status: string
  attendance_status: string | null
  registered_at: string
}

export interface EventReportRow {
  id: string
  reason: string
  details: string | null
  status: string
  created_at: string
  reporter_name: string | null
}

export interface ListEventsParams {
  mode?: EventMode
  query?: string
  category?: string
  format?: 'any' | EventFormat
  scope?: 'any' | 'global' | 'college' | 'community'
  month?: string
  sort?: EventSort
  limit?: number
  offset?: number
}

export async function listEvents(params: ListEventsParams = {}): Promise<EventSummary[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_events', {
    p_mode: params.mode ?? 'discover',
    p_query: params.query ?? '',
    p_category: params.category ?? '',
    p_format: params.format ?? 'any',
    p_scope: params.scope ?? 'any',
    p_month: params.month ?? '',
    p_sort: params.sort ?? 'recommended',
    p_limit: params.limit ?? 24,
    p_offset: params.offset ?? 0,
  })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as EventSummary[]
}

/** null when the event does not exist / is hidden from this viewer —
 *  `event_detail` is a table-returning RPC, so PostgREST hands us an array. */
export async function eventDetail(slug: string): Promise<EventDetailRow | null> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('event_detail', { p_slug: slug })
  if (error) throw new Error(friendlyMessage(error))
  const rows = (Array.isArray(data) ? data : [data]) as EventDetailRow[]
  return rows[0] ?? null
}

/** The RPC answers the event's slug — the Events page routes by #e/<slug>. */
export async function createEvent(input: SaveEventInput): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('create_event', {
    p_title: input.title,
    p_summary: input.summary ?? '',
    p_description: input.description ?? '',
    p_category: input.category,
    p_tags: input.tags ?? [],
    p_cover_url: input.coverUrl ?? null,
    p_college: input.collegeId ?? null,
    p_club: input.clubId ?? null,
    p_audience: input.audience,
    p_reg_eligibility: input.regEligibility,
    p_reg_type: input.regType,
    p_format: input.format,
    p_venue: input.venue ?? '',
    p_venue_address: input.venueAddress ?? '',
    p_city: input.city ?? '',
    p_map_url: input.mapUrl ?? '',
    p_online_url: input.onlineUrl ?? '',
    p_access_notes: input.accessNotes ?? '',
    p_timezone: input.timezone ?? '',
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt ?? null,
    p_capacity: input.capacity ?? null,
    p_reg_opens_at: input.regOpensAt ?? null,
    p_reg_deadline: input.regDeadline ?? null,
    p_registration_url: input.registrationUrl ?? '',
    p_featured: input.featured ?? false,
    p_publish: input.publish ?? true,
  })
  if (error) throw new Error(friendlyMessage(error))
  return data as string
}

export interface SaveEventInput {
  title: string
  summary?: string
  description?: string
  category: string
  tags?: string[]
  coverUrl?: string | null
  collegeId?: string | null
  clubId?: string | null
  audience: EventAudience
  regEligibility: EventEligibility
  regType: EventRegType
  format: EventFormat
  venue?: string
  venueAddress?: string
  city?: string
  mapUrl?: string
  onlineUrl?: string
  accessNotes?: string
  timezone?: string
  startsAt: string
  endsAt?: string | null
  capacity?: number | null
  regOpensAt?: string | null
  regDeadline?: string | null
  registrationUrl?: string
  featured?: boolean
  publish?: boolean
}

export async function updateEvent(
  eventId: string,
  input: SaveEventInput,
): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('update_event', {
    p_event: eventId,
    p_title: input.title,
    p_summary: input.summary ?? '',
    p_description: input.description ?? '',
    p_category: input.category,
    p_tags: input.tags ?? [],
    p_cover_url: input.coverUrl ?? null,
    p_college: input.collegeId ?? null,
    p_club: input.clubId ?? null,
    p_audience: input.audience,
    p_reg_eligibility: input.regEligibility,
    p_reg_type: input.regType,
    p_format: input.format,
    p_venue: input.venue ?? '',
    p_venue_address: input.venueAddress ?? '',
    p_city: input.city ?? '',
    p_map_url: input.mapUrl ?? '',
    p_online_url: input.onlineUrl ?? '',
    p_access_notes: input.accessNotes ?? '',
    p_timezone: input.timezone ?? '',
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt ?? null,
    p_capacity: input.capacity ?? null,
    p_reg_opens_at: input.regOpensAt ?? null,
    p_reg_deadline: input.regDeadline ?? null,
    p_registration_url: input.registrationUrl ?? '',
    p_featured: input.featured ?? false,
  })
  if (error) throw new Error(friendlyMessage(error))
}

export async function publishEvent(eventId: string, publish: boolean): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('publish_event', { p_event: eventId, p_publish: publish })
  if (error) throw new Error(friendlyMessage(error))
}

export async function cancelEvent(eventId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('cancel_event', { p_event: eventId })
  if (error) throw new Error(friendlyMessage(error))
}

export async function deleteEvent(eventId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('delete_event', { p_event: eventId })
  if (error) throw new Error(friendlyMessage(error))
}

/** RPC answers the actual stored state:
 *  'registered' | 'waitlisted' — registration events
 *  'going' | 'interested'      — RSVP events */
export async function registerEvent(
  eventId: string,
  status: 'registered' | 'going' | 'interested',
): Promise<string> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('register_event', { p_event: eventId, p_status: status })
  if (error) throw new Error(friendlyMessage(error))
  return data as string
}

/** 'not_going' for RSVP events; registration events must cancel_registration. */
export async function unrespondEvent(eventId: string): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('register_event', { p_event: eventId, p_status: 'not_going' })
  if (error) throw new Error(friendlyMessage(error))
}

export type CancelRegistrationResult = 'cancelled' | 'promoted' | 'left_waitlist'

export async function cancelRegistration(eventId: string): Promise<CancelRegistrationResult> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('cancel_registration', { p_event: eventId })
  if (error) throw new Error(friendlyMessage(error))
  return data as CancelRegistrationResult
}

export async function toggleSavedEvent(eventId: string, saved: boolean): Promise<boolean> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('toggle_saved_event', { p_event: eventId, p_saved: saved })
  if (error) throw new Error(friendlyMessage(error))
  return Boolean(data)
}

export async function fetchAttendees(eventId: string): Promise<AttendeeRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_event_attendees', { p_event: eventId })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as AttendeeRow[]
}

export async function markAttendance(
  eventId: string,
  userId: string,
  present: boolean,
): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('mark_attendance', {
    p_event: eventId,
    p_user: userId,
    p_present: present,
  })
  if (error) throw new Error(friendlyMessage(error))
}

export async function reportEvent(eventId: string, reason: string, details = ''): Promise<void> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { error } = await supabase.rpc('report_event', {
    p_event: eventId,
    p_reason: reason,
    p_details: details,
  })
  if (error) throw new Error(friendlyMessage(error))
}

export async function fetchEventReports(eventId: string): Promise<EventReportRow[]> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_event_reports', { p_event: eventId })
  if (error) throw new Error(friendlyMessage(error))
  return (data ?? []) as EventReportRow[]
}

/* -------------------------------------------------------------------------- */
/* Time-zone helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Curated fallback list for browsers that lack Intl.supportedValuesOf. */
const FALLBACK_TIMEZONES = [
  'Asia/Kolkata', 'Asia/Karachi', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Singapore',
  'Asia/Dubai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Hong_Kong', 'Europe/London',
  'Europe/Berlin', 'Europe/Paris', 'Europe/Zurich', 'America/New_York',
  'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'UTC',
]

export function supportedTimezones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf?.('timeZone')
    if (list?.length) return list
  } catch { /* older engine */ }
  return FALLBACK_TIMEZONES
}

/** Minute offset of `timeZone` at `instant` (UTC epoch ms). */
function tzOffsetMinutes(timeZone: string, instant: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = dtf.formatToParts(new Date(instant))
  const pick = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0')
  const asUTC = Date.UTC(
    pick('year'), pick('month') - 1, pick('day'),
    pick('hour'), pick('minute'), pick('second'),
  )
  return Math.round((asUTC - instant) / 60000)
}

/** The UTC instant for a wall-clock time (YYYY-MM-DD + HH:MM) inside an
 *  IANA time zone. Two-pass so DST-edge choices pick a real instant. */
export function localInstant(dateISO: string, timeHHMM: string, timeZone: string): string {
  const tidy = (timeHHMM.length === 5 ? `${timeHHMM}:00` : timeHHMM) || '00:00:00'
  const wallAsUTC = Date.parse(`${dateISO}T${tidy}Z`)
  if (Number.isNaN(wallAsUTC)) throw new Error('Enter a valid date and time.')
  const zone = timeZone || 'Asia/Kolkata'
  let instant = wallAsUTC
  for (let pass = 0; pass < 2; pass++) {
    const offset = tzOffsetMinutes(zone, instant)
    instant = wallAsUTC - offset * 60000
  }
  return new Date(instant).toISOString()
}

/** Viewer-local presentation of an absolute instant. */
const VIEWER_LABEL_CACHE = new Map<string, Intl.DateTimeFormat>()
function viewerFormatter(pattern: string): Intl.DateTimeFormat {
  let fmt = VIEWER_LABEL_CACHE.get(pattern)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(undefined, {
      dateStyle: undefined,
      ...eventFormatToOptions(pattern),
    })
    VIEWER_LABEL_CACHE.set(pattern, fmt)
  }
  return fmt
}
function eventFormatToOptions(pattern: string): Record<string, unknown> {
  switch (pattern) {
    case 'day': return { weekday: 'short', month: 'short', day: 'numeric' }
    case 'time': return { hour: 'numeric', minute: '2-digit' }
    case 'long': return { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    case 'dayfull': return { weekday: 'long', month: 'long', day: 'numeric' }
    case 'month': return { month: 'long', year: 'numeric' }
    case 'dateonly': return { month: 'short', day: 'numeric' }
    case 'years': return { month: 'short', day: 'numeric', year: 'numeric' }
    default: return { hour: 'numeric' }
  }
}

export function fmtDay(iso: string): string {
  return viewerFormatter('day').format(new Date(iso))
}
export function fmtTime(iso: string): string {
  return viewerFormatter('time').format(new Date(iso))
}
export function fmtLong(iso: string): string {
  return viewerFormatter('long').format(new Date(iso))
}
export function fmtDayFull(iso: string): string {
  return viewerFormatter('dayfull').format(new Date(iso))
}
export function fmtDateOnly(iso: string): string {
  return viewerFormatter('dateonly').format(new Date(iso))
}
export function fmtWithYear(iso: string): string {
  return viewerFormatter('years').format(new Date(iso))
}

/** "In your time (IST)" style suffix for detail pages when the event's own
 *  time zone differs from the viewer's. */
export function tzBadge(timeZone: string | null | undefined): string {
  const zone = timeZone || 'Asia/Kolkata'
  try {
    const abbrev = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find(p => p.type === 'timeZoneName')?.value ?? zone
    return abbrev
  } catch {
    return zone
  }
}
