import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft, BadgeCheck, Building2, CalendarDays, Check, ChevronRight, Clock3, FileText,
  Globe2, GraduationCap, Hash, Loader2, Lock, MapPin, Search, TrendingUp, Users,
} from 'lucide-react'
import * as cm from '../lib/communities'
import * as db from '../lib/db'
import * as ev from '../lib/events'
import * as bk from '../lib/bookmarks'
import { useSignedMediaUrl } from '../lib/signedMedia'
import { MIN_QUERY, useCampusSearch } from '../lib/useCampusSearch'
import type { CampusPost, PollState } from '../types'
import DiscoveryPostCard, {
  DiscoveryLoadMore, DiscoveryPostGrid, DiscoveryPostsSkeleton,
  postFilterOf, type PostFilter,
} from './DiscoveryPost'

/* ============================================================================
   Search & Discovery

   Two states, one page:
     • no query  → the discovery landing (categories, trends, people, posts,
                   communities, colleges, events — every section from real rows)
     • a query   → the results view (All / People / Posts / Colleges /
                   Communities / Events, with counts, skeletons, empty + error
                   states, and the query preserved across tab switches)

   The search itself is NOT re-implemented here: `useCampusSearch` is the same
   hook the global header dropdown uses, so both surfaces share one debounce,
   one set of RPCs and one degradation path. This page owns no search input —
   the global header (desktop) and the in-flow panel (phone) own the only field,
   and `onOpenSearch` focuses it.
   ========================================================================= */

type Identity = { id: string; name: string; username: string; initials: string; college: string } | null

type Suggestion = {
  id: string
  username: string
  name: string
  college: string | null
  course: string | null
  avatarUrl: string | null
  verified: boolean
}

type CollegeCard = {
  id: string
  name: string
  shortName: string
  place: string | null
  type: string | null
  group: string | null
  verified: boolean
}

type TabKey = 'all' | 'people' | 'posts' | 'colleges' | 'communities' | 'events'
type LandingSection = Exclude<TabKey, 'all' | 'events'>

export type DiscoveryProps = {
  identity: Identity
  isMember: boolean
  configured: boolean
  caps: db.Caps
  colleges: db.College[]
  /** the shell's legacy club rows — offline fallback for community search */
  clubs: db.Club[]
  following: string[]
  trends: [string, number][]
  trendsPending: boolean
  blockedHandles: string[]
  mutedHandles: string[]
  /** the active query; '' = discovery landing */
  query: string
  myCollegeId: string | null
  requireAuth: (action: string) => boolean
  notify: (message: string) => void
  /** replaces the active query (results view) */
  onQuery: (query: string) => void
  /** clears the query → back to the landing */
  onClearQuery: () => void
  /** focuses the ONE global search field (header on desktop, in-flow on phone) */
  onOpenSearch: () => void
  onOpenProfile: (profileId: string) => void
  onToggleFollow: (targetId: string, current: boolean, handle?: string) => Promise<boolean>
  onOpenPost: (post: CampusPost) => void
  onOpenCommunity: (clubId: string) => void
  onOpenEvent: (slug: string) => void
  onNavigate: (label: string) => void
  /* ---- post interactions -------------------------------------------------
     These are the shell's own handlers (App.tsx): one like implementation,
     one save implementation, one vote implementation, one comment sheet, one
     share sheet. Discovery never writes to a post itself — it flips its own
     copy optimistically and hands the real write to the shell, which also
     reports failures. Post rows are hydrated with the shell's poll cache so a
     vote cast here and in the feed agree on the same authoritative state. */
  pollStateMap: Record<string, PollState | null>
  onPollStates: (map: Record<string, PollState | null>) => void
  onVote: (post: CampusPost, optionIds: string[]) => Promise<boolean>
  onLike: (id: string, item?: CampusPost) => Promise<boolean>
  onSave: (id: string, item?: CampusPost) => void
  onRepost: (id: string, item?: CampusPost) => boolean | void
  onComment: (post: CampusPost) => void
  onShare: (post: CampusPost) => void
  /** institution the header search dropdown asked for (Search owns the panel) */
  collegeToOpen?: db.InstitutionHit | null
  /** called once the requested institution has been picked up */
  onCollegeConsumed?: () => void
}

/* -------------------------------------------------------------------------- */
/* small building blocks                                                      */
/* -------------------------------------------------------------------------- */

/** Signed-media image with an explicit fallback (0051 private buckets). */
function SignedImg({ source, alt, className, fallback }: {
  source: string | null | undefined
  alt: string
  className?: string
  fallback: ReactNode
}) {
  const media = useSignedMediaUrl(source)
  if (!media.ready || !media.url) return <>{fallback}</>
  return <img className={className} src={media.url} alt={alt} loading="lazy"/>
}

function SectionHead({ icon, title, hint, action }: {
  icon: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="disc-section-head">
      <h2><span className="disc-section-icon">{icon}</span>{title}</h2>
      {action && <div className="disc-section-action">{action}</div>}
      {hint && <p>{hint}</p>}
    </div>
  )
}

function EmptyBlock({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="disc-empty">
      <span className="disc-empty-icon">{icon}</span>
      <b>{title}</b>
      <small>{body}</small>
    </div>
  )
}

function RowSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="disc-skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="disc-skeleton-row" key={index}>
          <span className="skeleton-block disc-sk-avatar"/>
          <span className="disc-sk-lines">
            <span className="skeleton-block w60"/>
            <span className="skeleton-block w90"/>
          </span>
        </div>
      ))}
    </div>
  )
}

function FollowButton({ following, busy, onClick }: { following: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      className={`disc-follow${following ? ' is-following' : ''}`}
      onClick={onClick}
      disabled={busy}
      aria-pressed={following}
      aria-label={following ? 'Following' : 'Follow'}
    >
      {busy ? <Loader2 size={13} className="disc-spin"/> : following ? <Check size={13}/> : null}
      {following ? 'Following' : 'Follow'}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* rows                                                                       */
/* -------------------------------------------------------------------------- */

function PersonRow({ person, following, busy, onOpen, onFollow, meta }: {
  person: Suggestion
  following: boolean
  busy: boolean
  onOpen: () => void
  onFollow: () => void
  /** extra line under the name (search hits carry the college; suggestions do) */
  meta?: string | null
}) {
  return (
    <div className="disc-person">
      <button className="disc-person-open" onClick={onOpen}>
        <span className="avatar disc-avatar">
          <SignedImg
            source={person.avatarUrl}
            alt=""
            className="disc-avatar-img"
            fallback={db.initialsFor(person.name, person.username)}
          />
        </span>
        <span className="disc-person-copy">
          <b>{person.name}{person.verified && <BadgeCheck size={13} className="verified-tick" aria-label="Verified"/>}</b>
          <small>@{person.username}</small>
          {meta && <em>{meta}</em>}
        </span>
      </button>
      <FollowButton following={following} busy={busy} onClick={onFollow}/>
    </div>
  )
}

function CollegeRow({ college, onExplore }: { college: CollegeCard; onExplore: () => void }) {
  const initials = (college.shortName || college.name).slice(0, 2).toUpperCase()
  return (
    <div className="disc-college">
      <span className="disc-college-mark">{initials}</span>
      <span className="disc-college-copy">
        <b>{college.name}{college.verified && <BadgeCheck size={13} className="verified-tick" aria-label="Verified"/>}</b>
        <small>{[college.shortName && college.shortName !== college.name ? college.shortName : null, college.place].filter(Boolean).join(' · ') || 'Location not listed'}</small>
        {college.group && <em>{college.group}</em>}
      </span>
      <button className="secondary-button small" onClick={onExplore}>Explore</button>
    </div>
  )
}

function CommunityRow({ row, member, pending, busy, showCount, onOpen, onJoin }: {
  row: cm.CommunitySummary
  member: boolean
  pending: boolean
  busy: boolean
  showCount: boolean
  onOpen: () => void
  onJoin: () => void
}) {
  const locked = row.privacy !== 'public'
  return (
    <div className="disc-community">
      <button className="disc-community-open" onClick={onOpen} aria-label={`Open ${row.name}`}>
        <span className="avatar disc-avatar disc-community-mark">
          <SignedImg
            source={row.logo_url}
            alt=""
            className="disc-avatar-img"
            fallback={db.initialsFor(row.name, row.slug)}
          />
        </span>
        <span className="disc-community-copy">
          <b>{row.name}{locked && <Lock size={12} className="disc-lock" aria-label="Private community"/>}</b>
          <small>{row.description || 'No description yet.'}</small>
          <em>
            {showCount
              ? `${row.member_count} member${row.member_count === 1 ? '' : 's'}`
              : row.privacy === 'public' ? 'Public community' : 'Private community'}
            {row.college_short_name ? ` · ${row.college_short_name}` : ''}
          </em>
        </span>
      </button>
      {member
        ? <button className="secondary-button small" onClick={onOpen}>Open</button>
        : <button className="disc-join" onClick={onJoin} disabled={busy || pending}>
            {busy ? <Loader2 size={13} className="disc-spin"/> : pending ? <Clock3 size={13}/> : null}
            {pending ? 'Requested' : 'Join'}
          </button>}
    </div>
  )
}

function EventRow({ row, onOpen }: { row: ev.EventSummary; onOpen: () => void }) {
  return (
    <button className="disc-event" onClick={onOpen}>
      <span className="disc-event-date">
        <b>{new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(row.starts_at))}</b>
        <i>{new Date(row.starts_at).getDate()}</i>
      </span>
      <span className="disc-event-copy">
        <b>{row.title}</b>
        <small>{row.summary || `${row.category} · ${row.format === 'online' ? 'Online' : row.format === 'hybrid' ? 'Hybrid' : 'In person'}`}</small>
        <em>{[row.club_name || row.college_short_name || 'Global', row.venue].filter(Boolean).join(' · ')}</em>
      </span>
      <span className="disc-event-when">{ev.fmtDay(row.starts_at)} · {ev.fmtTime(row.starts_at)}</span>
      <ChevronRight size={16} className="disc-row-chevron"/>
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* page                                                                       */
/* -------------------------------------------------------------------------- */

const CATEGORY_CARDS: { key: LandingSection; title: string; body: string; icon: typeof Users; tone: string }[] = [
  { key: 'people', title: 'People', body: 'Classmates, seniors and members across your campus.', icon: Users, tone: 'violet' },
  { key: 'posts', title: 'Posts', body: 'Conversations, confessions, polls and reels.', icon: FileText, tone: 'pink' },
  { key: 'colleges', title: 'Colleges', body: 'Institutions on CAMPUS, with departments and campuses.', icon: Building2, tone: 'blue' },
  { key: 'communities', title: 'Communities', body: 'Groups for your branch, hostel, fest or hobby.', icon: Globe2, tone: 'amber' },
]

/** One page of the discovery feed (the RPC caps a page at 50). */
const FEED_PAGE = 12

const FEED_FILTERS: { key: PostFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'photo', label: 'Photos' },
  { key: 'video', label: 'Videos' },
  { key: 'text', label: 'Text' },
  { key: 'poll', label: 'Polls' },
]

/**
 * Engagement rank for a loaded page: likes plus replies, weighted 2:1, both
 * taken from the RPC's own columns. Per-page only — this is not a global
 * popularity claim, so nothing is inferred for posts never loaded.
 */
function rankByEngagement(rows: CampusPost[]): CampusPost[] {
  return [...rows].sort((a, b) => (b.likes + b.comments * 2) - (a.likes + a.comments * 2))
}

export default function Discovery(props: DiscoveryProps) {
  const {
    identity, isMember, configured, caps, colleges, clubs, following, trends, trendsPending,
    blockedHandles, mutedHandles, query, myCollegeId, requireAuth, notify,
    onQuery, onClearQuery, onOpenSearch, onOpenProfile, onToggleFollow,
    onOpenPost, onOpenCommunity, onOpenEvent, onNavigate, collegeToOpen, onCollegeConsumed,
    pollStateMap, onPollStates, onVote, onLike, onSave, onRepost, onComment, onShare,
  } = props

  const myId = identity?.id ?? null
  const member = isMember && Boolean(myId)
  const term = query.trim()
  const searching = term.length >= MIN_QUERY

  const [tab, setTab] = useState<TabKey>('all')
  const [focus, setFocus] = useState<LandingSection | null>(null)
  const [busyHandle, setBusyHandle] = useState<string | null>(null)
  const [joiningId, setJoiningId] = useState<string | null>(null)
  const [collegePanel, setCollegePanel] = useState<CollegeCard | null>(null)

  /* ---- results (the shared search engine) -------------------------------- */
  const search = useCampusSearch({
    query: term,
    caps,
    colleges,
    clubs,
    blockedHandles,
    mutedHandles,
    limit: 12,
  })

  /* ---- results: events (their own RPC, same debounce discipline) --------- */
  const [eventHits, setEventHits] = useState<ev.EventSummary[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [eventsSupported, setEventsSupported] = useState(true)

  useEffect(() => {
    if (!searching) { setEventHits([]); setEventsError(null); setEventsLoading(false); return }
    let cancelled = false
    setEventsLoading(true)
    setEventsError(null)
    const timer = window.setTimeout(() => {
      ev.listEvents({ mode: 'discover', query: term, sort: 'soonest', limit: 12 })
        .then(rows => { if (!cancelled) setEventHits(rows) })
        .catch(error => {
          if (cancelled) return
          const raw = String((error as { message?: string } | null)?.message ?? '')
          // the Events schema is migration-gated: an absent list_events is a
          // missing backend, not a broken page — the tab is hidden, not faked
          if (/list_events|PGRST202|Could not find the function/i.test(raw)) {
            setEventsSupported(false)
            setEventHits([])
          } else {
            setEventsError(db.friendlyMessage(error))
          }
        })
        .finally(() => { if (!cancelled) setEventsLoading(false) })
    }, 280)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [term, searching])

  /* ---- landing data (real rows only; every source fails soft) ------------ */
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [popularPosts, setPopularPosts] = useState<CampusPost[]>([])
  const [popularCommunities, setPopularCommunities] = useState<cm.CommunitySummary[]>([])
  const [directory, setDirectory] = useState<CollegeCard[]>([])
  const [upcoming, setUpcoming] = useState<ev.EventSummary[]>([])
  const [landingLoading, setLandingLoading] = useState(true)
  const [landingError, setLandingError] = useState<string | null>(null)
  const [upcomingSupported, setUpcomingSupported] = useState(true)
  const [refreshSeq, setRefreshSeq] = useState(0)
  const [feedOffset, setFeedOffset] = useState(0)
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedDone, setFeedDone] = useState(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [feedFilter, setFeedFilter] = useState<PostFilter>('all')

  useEffect(() => {
    if (!configured) return
    let cancelled = false
    setLandingLoading(true)
    setLandingError(null)

    const people: Promise<Suggestion[]> = (async () => {
      if (myId && myCollegeId) {
        const rows = await db.fetchCollegeStudents(myCollegeId, myId, 6)
        if (rows.length > 0) {
          return rows.map(row => ({
            id: row.id,
            username: row.username,
            name: row.name,
            college: null,
            course: row.course,
            avatarUrl: row.avatarUrl,
            verified: row.isVerified,
          }))
        }
      }
      // profiles are not readable by anon (RLS): visitors get the honest
      // "join to see students" state, exactly like the right rail
      if (!myId) return []
      const rows = await db.fetchFollowSuggestions(myId, myCollegeId, 6)
      return rows.map(row => ({
        id: row.id,
        username: row.username,
        name: row.name,
        college: null,
        course: null,
        avatarUrl: row.avatarUrl,
        verified: false,
      }))
    })().catch(() => [])

    // the discovery feed: one page of the SAME public feed RPC the Home feed
    // uses (list_public_posts), ordered by its own consistent recency. This
    // page ranks each loaded page by engagement (likes + 2·replies, both
    // server columns) so the visual feed leads with the conversations that
    // are actually moving; `loadMore` appends the next page the same way, and
    // nothing here is estimated, duplicated or invented.
    const posts = db.fetchFeedPage(0, FEED_PAGE)
      .then(rows => rankByEngagement(rows))
      .catch(() => [] as CampusPost[])

    const communities = cm.listCommunities({ sort: 'popular', limit: 5 }).catch(() => [])

    const collegeList: Promise<CollegeCard[]> = db.searchInstitutions('', caps, 8)
      .then(hits => hits.map(hit => ({
        id: hit.id,
        name: hit.name,
        shortName: hit.short_name,
        place: hit.campus_locality ?? hit.locality ?? null,
        type: hit.institution_type ?? null,
        group: hit.group_name ?? null,
        verified: hit.verified,
      })))
      .catch(() => [] as CollegeCard[])
      .then(mapped => mapped.length > 0
        ? mapped
        : colleges.slice(0, 8).map(college => ({
          id: college.id,
          name: college.name,
          shortName: college.short_name,
          place: college.city || college.locality || null,
          type: college.institution_type ?? null,
          group: college.group_name ?? null,
          verified: college.verified,
        })))

    const events = ev.listEvents({ mode: 'upcoming', sort: 'soonest', limit: 4 })
      .catch((error: unknown) => {
        const raw = String((error as { message?: string } | null)?.message ?? '')
        if (/list_events|PGRST202|Could not find the function/i.test(raw)) setUpcomingSupported(false)
        return [] as ev.EventSummary[]
      })

    void Promise.all([people, posts, communities, collegeList, events])
      .then(([peopleRows, postRows, communityRows, collegeRows, eventRows]) => {
        if (cancelled) return
        setSuggestions(peopleRows)
        setPopularPosts(postRows)
        setFeedOffset(postRows.length)
        setFeedDone(postRows.length < FEED_PAGE)
        setPopularCommunities(communityRows)
        setDirectory(collegeRows)
        setUpcoming(eventRows)
      })
      .catch(error => { if (!cancelled) setLandingError(db.friendlyMessage(error)) })
      .finally(() => { if (!cancelled) setLandingLoading(false) })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, myId, myCollegeId, caps.institutionSearch, refreshSeq])

  /* ---- feed: paging, poll hydration, interaction mirrors ----------------- */

  /** Append the next page of the public feed, ranked the same way as page 0. */
  const loadMoreFeed = useCallback(() => {
    if (feedLoading || feedDone) return
    setFeedLoading(true)
    setFeedError(null)
    db.fetchFeedPage(feedOffset, FEED_PAGE)
      .then(rows => {
        const next = rankByEngagement(rows)
        setPopularPosts(current => {
          const seen = new Set(current.map(post => post.id))
          return [...current, ...next.filter(post => !seen.has(post.id))]
        })
        setFeedOffset(offset => offset + rows.length)
        setFeedDone(rows.length < FEED_PAGE)
      })
      .catch(error => setFeedError(db.friendlyMessage(error)))
      .finally(() => setFeedLoading(false))
  }, [feedDone, feedLoading, feedOffset])

  /**
   * Poll cards hydrate through the shell's cache: one poll read per post id,
   * shared with the Home feed, so a vote cast in one surface is authoritative
   * in the other. A read that fails leaves the card on its honest
   * "results unavailable" line instead of inventing counts.
   */
  useEffect(() => {
    const pending = popularPosts.filter(post => post.kind === 'poll' && pollStateMap[post.id] === undefined)
    if (pending.length === 0) return
    let cancelled = false
    void db.pollStatesFor(pending)
      .then(map => { if (!cancelled && Object.keys(map).length > 0) onPollStates(map) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [popularPosts, pollStateMap, onPollStates])

  /**
   * Saved flags live in the shared bookmark store (one mirror per account), so
   * the card's bookmark reads the same truth as the Home feed's. Hydrate the
   * rows this page owns; a cosmetic failure leaves flags unsaved, never wrong.
   */
  useEffect(() => {
    if (popularPosts.length === 0 || !myId) return
    void bk.syncPostSaves(popularPosts).catch(() => undefined)
  }, [popularPosts, myId])

  /**
   * Local mirror of a post row: the shell owns the write (and the rollback), the
   * card owns what it draws, so the optimistic flip happens here immediately and
   * is reverted if the shell reports failure. Counts still come from the RPC.
   */
  const patchPost = useCallback((id: string, patch: Partial<CampusPost>) => {
    setPopularPosts(current => current.map(post => post.id === id ? { ...post, ...patch } : post))
  }, [])

  const likePost = (post: CampusPost) => {
    patchPost(post.id, { liked: !post.liked, likes: post.likes + (post.liked ? -1 : 1) })
    void Promise.resolve(onLike(post.id, post)).then(ok => {
      if (ok === false) patchPost(post.id, { liked: Boolean(post.liked), likes: post.likes })
    })
  }

  const repostPost = (post: CampusPost) => {
    patchPost(post.id, { reposted: !post.reposted, reposts: post.reposts + (post.reposted ? -1 : 1) })
    // the shell answers synchronously with false when the action was refused
    // (visitor), and may resolve later with a real outcome
    const outcome: boolean | void = onRepost(post.id, post)
    if (outcome === false) patchPost(post.id, { reposted: Boolean(post.reposted), reposts: post.reposts })
  }

  /* ---- college detail (existing 0057/0060 directory reads) --------------- */
  const [collegeDetail, setCollegeDetail] = useState<{
    departments: db.InstitutionDept[]
    programs: db.InstitutionProgram[]
    campuses: db.InstitutionCampus[]
    students: Suggestion[]
    loading: boolean
    failed: boolean
  } | null>(null)

  const openCollege = useCallback((college: CollegeCard) => {
    setCollegePanel(college)
    setCollegeDetail({ departments: [], programs: [], campuses: [], students: [], loading: true, failed: false })
    // no caps gate: a project without the 0057/0060 reads simply rejects, and
    // the panel then says so instead of pretending the college has no data
    void Promise.allSettled([
      db.listDepartments(college.id),
      db.listPrograms(college.id),
      db.listInstitutionCampuses(college.id),
      myId ? db.fetchCollegeStudents(college.id, myId, 8) : Promise.resolve([] as db.CollegeStudent[]),
    ]).then(([departments, programs, campuses, students]) => {
      setCollegeDetail({
        departments: departments.status === 'fulfilled' ? departments.value : [],
        programs: programs.status === 'fulfilled' ? programs.value : [],
        campuses: campuses.status === 'fulfilled' ? campuses.value : [],
        students: students.status === 'fulfilled'
          ? students.value.map(row => ({
            id: row.id,
            username: row.username,
            name: row.name,
            college: null,
            course: row.course,
            avatarUrl: row.avatarUrl,
            verified: row.isVerified,
          }))
          : [],
        loading: false,
        failed: [departments, programs, campuses].every(result => result.status === 'rejected'),
      })
    })
  }, [myId])

  /* an institution chosen in the header dropdown opens its detail here */
  const handledCollegeRef = useRef<string | null>(null)
  useEffect(() => {
    if (!collegeToOpen || handledCollegeRef.current === collegeToOpen.id) return
    handledCollegeRef.current = collegeToOpen.id
    openCollege({
      id: collegeToOpen.id,
      name: collegeToOpen.name,
      shortName: collegeToOpen.short_name,
      place: collegeToOpen.campus_locality ?? collegeToOpen.locality ?? null,
      type: collegeToOpen.institution_type ?? null,
      group: collegeToOpen.group_name ?? null,
      verified: collegeToOpen.verified,
    })
    onCollegeConsumed?.()
  }, [collegeToOpen, openCollege, onCollegeConsumed])

  /* ---- follow / join ---------------------------------------------------- */
  const follow = (person: Suggestion) => {
    if (!requireAuth('follow students')) return
    const handle = person.username
    const current = following.includes(handle)
    setBusyHandle(handle)
    void onToggleFollow(person.id, current, handle).finally(() => setBusyHandle(null))
  }

  const join = (row: cm.CommunitySummary) => {
    if (!requireAuth('join communities')) return
    setJoiningId(row.id)
    void cm.joinCommunity(row.id)
      .then(result => {
        notify(result === 'requested'
          ? `Request sent to ${row.name} — a moderator will review it.`
          : `Welcome to ${row.name}!`)
        // re-read the landing rows so the membership chip comes from the DB
        setRefreshSeq(value => value + 1)
      })
      .catch(error => notify(db.friendlyMessage(error)))
      .finally(() => setJoiningId(null))
  }

  /* ---- derived result sets --------------------------------------------- */
  const results = useMemo(() => {
    const people: Suggestion[] = search.people.map(person => ({
      id: person.id,
      username: person.username ?? '',
      name: person.displayName,
      college: person.collegeShort,
      course: null,
      avatarUrl: person.avatarUrl,
      verified: person.isVerified,
    }))
    const collegeCards: CollegeCard[] = search.collegeHits.map(hit => ({
      id: hit.id,
      name: hit.name,
      shortName: hit.short_name,
      place: hit.campus_locality ?? hit.locality ?? null,
      type: hit.institution_type ?? null,
      group: hit.group_name ?? null,
      verified: hit.verified,
    }))
    return { people, posts: search.posts, colleges: collegeCards, clubs: search.clubs }
  }, [search])

  const counts: Record<LandingSection | 'events', number | null> = {
    people: results.people.length,
    posts: results.posts.length,
    colleges: results.colleges.length,
    communities: results.clubs.length,
    events: eventsSupported ? eventHits.length : null,
  }

  const tabs = useMemo(() => {
    const list: { key: TabKey; label: string }[] = [
      { key: 'all', label: 'All' },
      { key: 'people', label: 'People' },
      { key: 'posts', label: 'Posts' },
      { key: 'colleges', label: 'Colleges' },
      { key: 'communities', label: 'Communities' },
    ]
    if (eventsSupported) list.push({ key: 'events', label: 'Events' })
    return list
  }, [eventsSupported])

  // a filter that disappears (events on a project without 0061) must not stay selected
  useEffect(() => {
    if (tab === 'events' && !eventsSupported) setTab('all')
  }, [tab, eventsSupported])

  const totalHits = results.people.length + results.posts.length + results.colleges.length
    + results.clubs.length + (eventsSupported ? eventHits.length : 0)
  const waiting = search.loading || (eventsSupported && eventsLoading)
  const errored = search.error
  const none = !waiting && !errored && search.searched && totalHits === 0

  /* ---------------------------------------------------------------- */
  /* college detail sub-view                                           */
  /* ---------------------------------------------------------------- */
  if (collegePanel) {
    const detail = collegeDetail
    return (
      <section className="disc-page disc-college-page">
        <button className="disc-back" onClick={() => { setCollegePanel(null); setCollegeDetail(null) }}>
          <ArrowLeft size={16}/> Back to {term ? 'results' : 'discovery'}
        </button>

        <header className="disc-college-head">
          <span className="disc-college-mark large">{(collegePanel.shortName || collegePanel.name).slice(0, 2).toUpperCase()}</span>
          <div>
            <h2>{collegePanel.name}{collegePanel.verified && <BadgeCheck size={16} className="verified-tick" aria-label="Verified"/>}</h2>
            <p>{[collegePanel.shortName && collegePanel.shortName !== collegePanel.name ? collegePanel.shortName : null, collegePanel.place].filter(Boolean).join(' · ') || 'Location not listed'}</p>
            {collegePanel.type && <span className="disc-chip">{collegePanel.type}</span>}
            {collegePanel.group && <span className="disc-chip">{collegePanel.group}</span>}
          </div>
        </header>

        {!detail || detail.loading ? (
          <RowSkeleton rows={4}/>
        ) : detail.failed ? (
          <EmptyBlock
            icon={<Building2 size={18}/>}
            title="No directory detail yet"
            body="This institution has no departments, campuses or programs published in the CAMPUS directory."
          />
        ) : (
          <>
            {detail.campuses.length > 0 && (
              <div className="disc-section">
                <SectionHead icon={<MapPin size={16}/>} title="Campuses"/>
                <ul className="disc-facts">
                  {detail.campuses.map(campus => (
                    <li key={campus.id}>
                      <b>{campus.name}{campus.is_primary && <span className="disc-chip">Primary</span>}</b>
                      <small>{campus.address || [campus.locality, campus.city].filter(Boolean).join(', ')}</small>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.departments.length > 0 && (
              <div className="disc-section">
                <SectionHead icon={<GraduationCap size={16}/>} title="Departments"/>
                <div className="disc-chip-row">
                  {detail.departments.map(department => (
                    <span className="disc-chip" key={department.id}>{department.abbreviation || department.name}</span>
                  ))}
                </div>
              </div>
            )}

            {detail.programs.length > 0 && (
              <div className="disc-section">
                <SectionHead icon={<FileText size={16}/>} title="Programs"/>
                <ul className="disc-facts">
                  {detail.programs.map(program => (
                    <li key={program.id}><b>{program.name}</b><small>{program.level}</small></li>
                  ))}
                </ul>
              </div>
            )}

            {detail.students.length > 0 && (
              <div className="disc-section">
                <SectionHead icon={<Users size={16}/>} title="Students here" hint="Public profiles from this college."/>
                {detail.students.map(person => (
                  <PersonRow
                    key={person.id}
                    person={person}
                    following={following.includes(person.username)}
                    busy={busyHandle === person.username}
                    onOpen={() => onOpenProfile(person.id)}
                    onFollow={() => follow(person)}
                    meta={[person.college, person.course].filter(Boolean).join(' · ') || null}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    )
  }

  /* ---- post feed view models (shared by the landing and the results) ------ */

  const feed = useMemo(() => {
    if (feedFilter === 'all') return popularPosts
    return popularPosts.filter(post => postFilterOf(post) === feedFilter)
  }, [feedFilter, popularPosts])

  /** type counts over the rows actually loaded — no estimate for the rest */
  const feedCounts = useMemo(() => {
    const counts: Record<PostFilter, number> = { all: popularPosts.length, photo: 0, video: 0, text: 0, poll: 0 }
    for (const post of popularPosts) counts[postFilterOf(post)] += 1
    return counts
  }, [popularPosts])

  const postCard = (post: CampusPost, eager = false) => (
    <DiscoveryPostCard
      key={post.id}
      post={post}
      eager={eager}
      poll={pollStateMap[post.id]}
      onOpen={() => onOpenPost(post)}
      onOpenProfile={onOpenProfile}
      onOpenTag={onQuery}
      onLike={() => likePost(post)}
      onSave={() => onSave(post.id, post)}
      onComment={() => onComment(post)}
      onShare={() => onShare(post)}
      onRepost={() => repostPost(post)}
      onVote={optionIds => onVote(post, optionIds)}
    />
  )

  const posts = (
    <div className="disc-section">
      <SectionHead
        icon={<FileText size={16}/>}
        title="Popular on CAMPUS"
        hint="Real posts from public feeds — photos, videos, conversations, confessions and polls. Ranked by likes and replies."
      />

      <div className="disc-feed-filter" role="group" aria-label="Filter posts by type">
        {FEED_FILTERS.map(item => (
          <button
            key={item.key}
            className={feedFilter === item.key ? 'active' : ''}
            onClick={() => setFeedFilter(item.key)}
            aria-pressed={feedFilter === item.key}
          >
            {item.label}
            {feedCounts[item.key] > 0 && <i>{feedCounts[item.key]}</i>}
          </button>
        ))}
      </div>

      {feedError && <div className="disc-error" role="alert"><small>{feedError}</small></div>}

      {landingLoading && popularPosts.length === 0 ? (
        <DiscoveryPostsSkeleton count={4}/>
      ) : feed.length === 0 ? (
        <EmptyBlock
          icon={<FileText size={18}/>}
          title={feedFilter === 'all' ? 'No posts to show yet' : `No ${feedFilter} posts loaded`}
          body={feedFilter === 'all'
            ? 'Public posts from your campus feeds appear here as soon as they are published.'
            : 'Try another type — more posts load as you scroll.'}
        />
      ) : (
        <>
          <DiscoveryPostGrid label="Popular posts on CAMPUS">
            {feed.map((post, index) => postCard(post, index === 0))}
          </DiscoveryPostGrid>
          <DiscoveryLoadMore loading={feedLoading} done={feedDone} onClick={loadMoreFeed}/>
        </>
      )}
    </div>
  )

  /* ---------------------------------------------------------------- */
  /* results view                                                      */
  /* ---------------------------------------------------------------- */
  if (searching) {
    const show = (key: TabKey) => tab === 'all' || tab === key

    return (
      <section className="disc-page disc-results">
        <header className="disc-results-head">
          <h2>Search results for “{term}”</h2>
          <div className="disc-results-actions">
            <span className="disc-count">{waiting ? 'Searching…' : `${totalHits} result${totalHits === 1 ? '' : 's'}`}</span>
            <button className="disc-clear" onClick={onClearQuery}>Clear search</button>
          </div>
        </header>

        <div className="disc-tabs" role="tablist" aria-label="Result categories">
          {tabs.map(item => {
            const count = item.key === 'all' ? null : counts[item.key]
            const active = tab === item.key
            return (
              <button
                key={item.key}
                role="tab"
                aria-selected={active}
                className={active ? 'active' : ''}
                onClick={() => setTab(item.key)}
              >
                {item.label}
                {typeof count === 'number' && count > 0 && <i>{count}</i>}
              </button>
            )
          })}
        </div>

        {errored && (
          <div className="disc-error" role="alert">
            <b>Search could not finish</b>
            <small>{errored}</small>
          </div>
        )}

        {none && (
          <div className="disc-results-empty">
            <EmptyBlock
              icon={<Search size={18}/>}
              title={`No matches for “${term}”`}
              body="Try a different spelling, a #hashtag, a college short name or a @username — search covers people, posts, colleges, communities and events."
            />
            <button className="disc-search-cta" onClick={onOpenSearch}>
              <Search size={15}/> Search something else
            </button>
          </div>
        )}

        {show('people') && (
          <div className="disc-section">
            <SectionHead icon={<Users size={16}/>} title="People"/>
            {search.loading && results.people.length === 0
              ? <RowSkeleton/>
              : results.people.length === 0
                ? <p className="disc-none">No people matched this search.</p>
                : results.people.map(person => (
                  <PersonRow
                    key={person.id}
                    person={person}
                    following={following.includes(person.username)}
                    busy={busyHandle === person.username}
                    onOpen={() => onOpenProfile(person.id)}
                    onFollow={() => follow(person)}
                    meta={[person.college, person.course].filter(Boolean).join(' · ') || null}
                  />
                ))}
          </div>
        )}

        {show('posts') && (
          <div className="disc-section">
            <SectionHead icon={<FileText size={16}/>} title="Posts" hint="Matched posts, presented as their own type: photo, video, text, poll or confession."/>
            {search.loading && results.posts.length === 0
              ? <DiscoveryPostsSkeleton count={3}/>
              : results.posts.length === 0
                ? <p className="disc-none">No posts matched this search.</p>
                : (
                  <DiscoveryPostGrid label={`Posts matching ${term}`}>
                    {results.posts.map(post => postCard(post))}
                  </DiscoveryPostGrid>
                )}
          </div>
        )}

        {show('colleges') && (
          <div className="disc-section">
            <SectionHead icon={<Building2 size={16}/>} title="Colleges"/>
            {search.loading && results.colleges.length === 0
              ? <RowSkeleton rows={2}/>
              : results.colleges.length === 0
                ? <p className="disc-none">No colleges matched this search.</p>
                : results.colleges.map(college => (
                  <CollegeRow key={college.id} college={college} onExplore={() => openCollege(college)}/>
                ))}
          </div>
        )}

        {show('communities') && (
          <div className="disc-section">
            <SectionHead icon={<Globe2 size={16}/>} title="Communities"/>
            {search.loading && results.clubs.length === 0
              ? <RowSkeleton rows={2}/>
              : results.clubs.length === 0
                ? <p className="disc-none">No communities matched this search.</p>
                : results.clubs.map(row => (
                  <CommunityRow
                    key={row.id}
                    row={row}
                    member={row.my_status === 'active'}
                    pending={row.my_status === 'pending'}
                    busy={joiningId === row.id}
                    showCount={search.clubsFromRpc}
                    onOpen={() => { if (row.my_status === 'active' || row.privacy !== 'hidden') onOpenCommunity(row.id) }}
                    onJoin={() => join(row)}
                  />
                ))}
          </div>
        )}

        {show('events') && eventsSupported && (
          <div className="disc-section">
            <SectionHead icon={<CalendarDays size={16}/>} title="Events"/>
            {eventsError
              ? <div className="disc-error"><small>{eventsError}</small></div>
              : eventsLoading && eventHits.length === 0
                ? <RowSkeleton rows={2}/>
                : eventHits.length === 0
                  ? <p className="disc-none">No events matched this search.</p>
                  : eventHits.map(row => <EventRow key={row.id} row={row} onOpen={() => onOpenEvent(row.slug)}/>)}
          </div>
        )}
      </section>
    )
  }

  /* ---------------------------------------------------------------- */
  /* discovery landing                                                 */
  /* ---------------------------------------------------------------- */
  const people = (
    <div className="disc-section">
      <SectionHead
        icon={<Users size={16}/>}
        title="Suggested people"
        hint={member ? 'Public profiles from your campus.' : 'Join CAMPUS to follow classmates.'}
        action={!member ? <button className="disc-link" onClick={() => onNavigate('My College')}>Find your college</button> : undefined}
      />
      {landingLoading && suggestions.length === 0 ? (
        <RowSkeleton/>
      ) : suggestions.length === 0 ? (
        <EmptyBlock
          icon={<Users size={18}/>}
          title={member ? 'No classmates to suggest yet' : 'Suggestions need an account'}
          body={member
            ? 'As more students from your campus join, they appear here.'
            : 'Sign in and pick your college to see students you may know.'}
        />
      ) : (
        suggestions.slice(0, 5).map(person => (
          <PersonRow
            key={person.id}
            person={person}
            following={following.includes(person.username)}
            busy={busyHandle === person.username}
            onOpen={() => onOpenProfile(person.id)}
            onFollow={() => follow(person)}
            meta={[person.college, person.course].filter(Boolean).join(' · ') || null}
          />
        ))
      )}
    </div>
  )

  const communities = (
    <div className="disc-section">
      <SectionHead
        icon={<Globe2 size={16}/>}
        title="Popular communities"
        hint="Spaces with the most members on CAMPUS."
        action={<button className="disc-link" onClick={() => onNavigate('Communities')}>All communities</button>}
      />
      {landingLoading && popularCommunities.length === 0 ? (
        <RowSkeleton rows={2}/>
      ) : popularCommunities.length === 0 ? (
        <EmptyBlock icon={<Globe2 size={18}/>} title="No communities yet" body="Communities created on your campus list here."/>
      ) : (
        popularCommunities.slice(0, 4).map(row => (
          <CommunityRow
            key={row.id}
            row={row}
            member={row.my_status === 'active'}
            pending={row.my_status === 'pending'}
            busy={joiningId === row.id}
            showCount
            onOpen={() => { if (row.my_status === 'active' || row.privacy !== 'hidden') onOpenCommunity(row.id) }}
            onJoin={() => join(row)}
          />
        ))
      )}
    </div>
  )

  const collegeSection = (
    <div className="disc-section">
      <SectionHead
        icon={<Building2 size={16}/>}
        title="Discover colleges"
        hint="Registered institutions on CAMPUS."
        action={<button className="disc-link" onClick={() => onNavigate('My College')}>My college</button>}
      />
      {landingLoading && directory.length === 0 ? (
        <RowSkeleton rows={2}/>
      ) : directory.length === 0 ? (
        <EmptyBlock icon={<Building2 size={18}/>} title="No colleges listed" body="The CAMPUS college directory is empty for now."/>
      ) : (
        <div className="disc-colleges">
          {directory.slice(0, 6).map(college => (
            <CollegeRow key={college.id} college={college} onExplore={() => openCollege(college)}/>
          ))}
        </div>
      )}
    </div>
  )

  const focusCard = focus ? CATEGORY_CARDS.find(card => card.key === focus) ?? null : null

  return (
    <section className="disc-page disc-landing">
      {term.length === 1 && (
        <div className="disc-focus-bar">
          <span>Type at least {MIN_QUERY} characters to search for “{term}”.</span>
          <button onClick={onClearQuery}>Clear</button>
        </div>
      )}

      <header className="disc-hero">
        <div className="disc-hero-copy">
          <h2>Explore CAMPUS</h2>
          <p>Find your people, discover conversations and explore campus life.</p>
        </div>
        <button className="disc-search-cta" onClick={onOpenSearch}>
          <Search size={16}/>
          <span>Search people, posts, colleges and communities…</span>
        </button>
      </header>

      {landingError && (
        <div className="disc-error" role="alert">
          <b>Discovery could not load</b>
          <small>{landingError}</small>
        </div>
      )}

      <div className="disc-section">
        <SectionHead icon={<Search size={16}/>} title="Browse CAMPUS" hint="Pick a starting point — each opens its own discovery view."/>
        <div className="disc-categories">
          {CATEGORY_CARDS.map(card => {
            const Icon = card.icon
            const active = focus === card.key
            return (
              <button
                key={card.key}
                className={`disc-category tone-${card.tone}${active ? ' active' : ''}`}
                onClick={() => setFocus(current => current === card.key ? null : card.key)}
                aria-pressed={active}
              >
                <span className="disc-category-icon"><Icon size={19}/></span>
                <b>{card.title}</b>
                <small>{card.body}</small>
                <span className="disc-category-cta">{active ? 'Showing now' : `Browse ${card.title.toLowerCase()}`} <ChevronRight size={14}/></span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="disc-section">
        <SectionHead
          icon={<TrendingUp size={16}/>}
          title="Trending searches"
          hint={trendsPending ? 'Reading the latest posts…' : 'Hashtags students are using in real posts right now.'}
        />
        {trendsPending ? (
          <RowSkeleton rows={2}/>
        ) : trends.length === 0 ? (
          <EmptyBlock
            icon={<Hash size={18}/>}
            title="No trends yet"
            body="Hashtags used in public posts chart here as your campus posts."
          />
        ) : (
          <div className="disc-trend-row">
            {trends.slice(0, 10).map(([tag, count]) => (
              <button key={tag} className="disc-trend" onClick={() => onQuery(tag)}>
                <Hash size={13}/>{tag}
                <i>{count >= 1000 ? `${(count / 1000).toFixed(1)}K` : count}</i>
              </button>
            ))}
          </div>
        )}
      </div>

      {focus && focusCard && (
        <div className="disc-focus-bar">
          <span>Showing <b>{focusCard.title}</b></span>
          <button onClick={() => setFocus(null)}>Show everything</button>
        </div>
      )}

      {!focus || focus === 'people' ? people : null}
      {!focus || focus === 'posts' ? posts : null}
      {!focus || focus === 'communities' ? communities : null}
      {!focus || focus === 'colleges' ? collegeSection : null}

      {upcomingSupported && (
        <div className="disc-section">
          <SectionHead
            icon={<CalendarDays size={16}/>}
            title="Upcoming events"
            hint="Happening soon on campuses near you."
            action={<button className="disc-link" onClick={() => onNavigate('Events')}>All events</button>}
          />
          {landingLoading && upcoming.length === 0 ? (
            <RowSkeleton rows={2}/>
          ) : upcoming.length === 0 ? (
            <EmptyBlock icon={<CalendarDays size={18}/>} title="No upcoming events" body="Published campus events appear here as they are scheduled."/>
          ) : (
            upcoming.map(row => <EventRow key={row.id} row={row} onOpen={() => onOpenEvent(row.slug)}/>)
          )}
        </div>
      )}
    </section>
  )
}