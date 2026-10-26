import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDollarSign,
  Dices,
  Hourglass,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import * as db from '../lib/db'
import * as ev from '../lib/events'
import * as cm from '../lib/communities'
import * as mk from '../lib/marketplace'
import type { CampusPost, PollState } from '../types'
import type { AccountStatus } from '../lib/auth'
import PostCard from './PostCard'
import { registrationState } from './Events'

/**
 * My College — the personalized hub for the signed-in student's college.
 *
 * Architecture rules this page keeps:
 *  · ZERO new persistence paths. Every write reuses the App-owned handler or
 *    the same lib service the dedicated pages use (feed, confessions, polls,
 *    events, communities, marketplace, follows, saves, leaderboard). Nothing
 *    here is a parallel backend or a fake button.
 *  · College scope rests on the CANONICAL colleges.id. The feed filters on
 *    CampusPost.collegeId (mapped from the feed RPC's college_id); the short
 *    name is only a fallback for payloads sent before migration 0045.
 *    Events, communities and marketplace listings are scoped server-side by
 *    their own RPC parameters (p_mode 'mycollege' / p_scope 'college').
 *  · Honesty first: real counts only, no fabricated sections, and no
 *    pretending a missing backend exists (announcements are documented as an
 *    integration point in the report — no table, no UI here).
 */

const SEARCH_DEBOUNCE_MS = 350
/** offset page size for the shared feed pipeline (matches Home's page-0 cap) */
const FEED_PAGE_LIMIT = 20
/** Trending ranks the last N days by real engagement with recency decay; posts
 *  older than the window never reach the list (no permanently-hot posts). */
const TRENDING_WINDOW_HOURS = 72

type TabKey =
  | 'foryou' | 'following' | 'trending' | 'latest' | 'confessions'
  | 'polls' | 'events' | 'communities' | 'students' | 'market' | 'search'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'foryou', label: 'For You' },
  { key: 'following', label: 'Following' },
  { key: 'trending', label: 'Trending' },
  { key: 'latest', label: 'Latest' },
  { key: 'confessions', label: 'Confessions' },
  { key: 'polls', label: 'Polls' },
  { key: 'events', label: 'Events' },
  { key: 'communities', label: 'Communities' },
  { key: 'students', label: 'Students' },
  { key: 'market', label: 'Marketplace' },
  { key: 'search', label: 'Search' },
]

/** tabs served by the shared post pipeline (their refresh = the feed refresh) */
const FEED_TABS: TabKey[] = ['foryou', 'following', 'trending', 'latest', 'polls']

const TRENDING_NOTE =
  `Ranks the last ${TRENDING_WINDOW_HOURS}h by real engagement — likes, comments and reposts — ` +
  `weighted toward fresh posts. Older posts fall out naturally instead of staying hot forever.`

type IdentityShell = {
  id: string; name: string; username: string; initials: string; college: string
} | null

/** College-membership decision for one post. Canonical id when the record
 *  carries it (post-migration payloads); short name otherwise (pre-0045
 *  payloads) so nothing silently drops — and it equals the Home feed's rule. */
function mineCollegeP(post: CampusPost, myCollegeId: string | null, short: string): boolean {
  if (!myCollegeId) return false
  if (post.collegeId) return post.collegeId === myCollegeId
  return Boolean(short) && post.college === short
}

export default function MyCollege({
  identity,
  configured,
  status,
  isStaff,
  colleges,
  caps,
  myCollegeId,
  following,
  posts,
  feedLoading,
  feedSource,
  feedError,
  reloadFeed,
  pollStateMap,
  confessionPatch,
  requireAuth,
  notify,
  onVote,
  onLike,
  onSave,
  onComment,
  onShare,
  onReport,
  onRepost,
  onEdit,
  onDelete,
  onMessage,
  onRelation,
  onOpenProfile,
  onOpenTag,
  onToggleFollow,
  openConfessionsPage,
  onOpenComposer,
  onNavigate,
  onOpenEvent,
  onOpenCommunity,
  onOpenListing,
  onContactSeller,
  onProfilePatched,
}: {
  identity: IdentityShell
  configured: boolean
  status: AccountStatus
  isStaff: boolean
  colleges: db.College[]
  caps: db.Caps
  myCollegeId: string | null
  /** handles the member follows (App-owned store, "@username") */
  following: string[]
  /** page-0 buffer — the SAME store the Home feed renders from */
  posts: CampusPost[]
  pollStateMap: Record<string, PollState | null>
  /** App's confession like/comment replay — keeps like and comment counts
   *  consistent with the dedicated Confessions page (same store, same rules) */
  confessionPatch: { id: string; likes?: number; liked?: boolean; comments?: number } | null
  /** App's auth gate: false (plus its own gate UI) when not signed in */
  requireAuth: (action: string) => boolean
  /** App's toast channel (same one every other page notifies through) */
  notify: (message: string) => void
  feedLoading: boolean
  feedSource: 'db' | 'local'
  feedError: string | null
  reloadFeed: () => void
  onVote: (post: CampusPost, optionIds: string[]) => Promise<boolean>
  onLike: (id: string, item?: CampusPost) => Promise<boolean>
  onSave: (id: string, item?: CampusPost) => void
  onComment: (post: CampusPost) => void
  onShare: (post: CampusPost) => void
  onReport: (post: CampusPost) => void
  onRepost: (id: string, item?: CampusPost) => void
  onEdit: (post: CampusPost) => void
  onDelete: (post: CampusPost) => void
  onMessage: (post: CampusPost) => void
  onRelation: (table: 'user_blocks' | 'user_mutes', post: CampusPost) => void
  onOpenProfile: (profileId: string) => void
  onOpenTag: (query: string) => void
  /** real follow write (App-owned); `handle` mirrors the outcome into the
   *  feed's follow store so row state survives re-renders */
  onToggleFollow: (targetId: string, current: boolean, handle?: string) => Promise<boolean>
  openConfessionsPage: () => void
  onOpenComposer: (kind: 'post') => boolean
  onNavigate: (label: string) => void
  onOpenEvent: (slug: string) => void
  onOpenCommunity: (clubId: string) => void
  onOpenListing: (slug: string) => void
  onContactSeller: (sellerId: string, listingTitle: string) => void
  onProfilePatched: () => void
}) {
  void onContactSeller // listings page owns seller contact; keep the channel available to the parent
  const member = status === 'member'
  const collegeRow = useMemo(
    () => colleges.find(c => c.id === myCollegeId) ?? null,
    [colleges, myCollegeId],
  )
  const myShort = collegeRow?.short_name ?? identity?.college ?? ''

  /* ---- tab state (first — several effects below read it) ------------------ */

  const [tab, setTab] = useState<TabKey>('foryou')

  /* ---- feed tabs: one shared pipeline, different windows ----------------- */

  /** server pages fetched beyond the shared page-0 store; switching tabs never
   *  refetches — every window is a memoized view of the same lists */
  const [extra, setExtra] = useState<CampusPost[]>([])
  const [extraLoading, setExtraLoading] = useState(false)
  const [extraError, setExtraError] = useState<string | null>(null)
  const [localPolls, setLocalPolls] = useState<Record<string, PollState | null>>({})

  // a refresh of the shared store invalidates the offset pages (they were
  // relative to the previous snapshot)
  useEffect(() => { setExtra([]); setExtraError(null) }, [posts])

  const collegePosts = useMemo(
    () => [...posts, ...extra].filter(p => mineCollegeP(p, myCollegeId, myShort)),
    [posts, extra, myCollegeId, myShort],
  )

  const followSet = useMemo(() => new Set(following), [following])

  const forYou = useMemo(() => {
    const scored = collegePosts.map(post => ({
      post,
      score: db.forYouScore(post, followSet.has(post.handle), false),
    }))
    scored.sort((a, b) => b.score - a.score)
    return scored.map(entry => entry.post)
  }, [collegePosts, followSet])

  /** This page's list is already college-scoped, so the college-affinity term
   *  is uniform; recency + follows + engagement decide the order. */
  void forYou

  const followingFeed = useMemo(
    () => collegePosts.filter(p => p.handle && followSet.has(p.handle)),
    [collegePosts, followSet],
  )

  const trending = useMemo(() => {
    const now = Date.now()
    const scored = collegePosts
      .map(post => {
        const created = post.createdAt ? new Date(post.createdAt).getTime() : NaN
        if (Number.isNaN(created)) return { post, score: -1 }
        const ageH = (now - created) / 36e5
        if (ageH > TRENDING_WINDOW_HOURS) return { post, score: -1 } // outside the window
        const engagement = Math.log2(1 + post.likes * 2 + post.comments * 3 + post.reposts * 2)
        return { post, score: engagement * Math.exp(-ageH / (TRENDING_WINDOW_HOURS / 2)) }
      })
      .filter(entry => entry.score >= 0)
    scored.sort((a, b) =>
      b.score - a.score
      || (b.post.createdAt ?? '').localeCompare(a.post.createdAt ?? '')
      || b.post.id.localeCompare(a.post.id))
    return scored.map(entry => entry.post)
  }, [collegePosts])

  const latest = useMemo(() => {
    const withStamp = collegePosts.slice()
    withStamp.sort((a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? '') // newest first
      || b.id.localeCompare(a.id))                          // unique tie-break
    return withStamp
  }, [collegePosts])

  const pollsFeed = useMemo(
    () => collegePosts.filter(p => p.kind === 'poll'),
    [collegePosts],
  )

  const pollFor = useCallback(
    (post: CampusPost): PollState | null | undefined =>
      pollStateMap[post.id] ?? localPolls[post.id],
    [pollStateMap, localPolls],
  )

  const loadMorePosts = useCallback(async () => {
    if (!member || extraLoading || feedSource !== 'db') return
    setExtraLoading(true)
    setExtraError(null)
    try {
      const offset = posts.length + extra.length
      const rows = await db.fetchFeedPage(offset, FEED_PAGE_LIMIT)
      setExtra(prev => {
        const seen = new Set([...posts.map(p => p.id), ...prev.map(p => p.id)])
        return [...prev, ...rows.filter(r => !seen.has(r.id))]
      })
      // hydrate any freshly fetched poll posts in ONE batch call (same ritual
      // the Home feed uses; no per-card request)
      const pollIds = rows.filter(r => r.kind === 'poll').map(r => r.id)
      if (pollIds.length) {
        const states = await db.pollStatesFor(rows.filter(r => pollIds.includes(r.id)))
        setLocalPolls(current => ({ ...current, ...states }))
      }
    } catch (error) {
      setExtraError(db.friendlyMessage(error))
    } finally {
      setExtraLoading(false)
    }
  }, [member, extraLoading, feedSource, posts, extra.length])

  /* ---- confessions tab: the dedicated RPC (anonymity enforced server-side) */

  type ConfessionState = { rows: CampusPost[]; total: number } | null
  const [confState, setConfState] = useState<ConfessionState>(null)
  const [confLoading, setConfLoading] = useState(false)
  const [confError, setConfError] = useState<string | null>(null)
  const confLoadedRef = useRef(false)

  const loadConfessions = useCallback(async (append = false) => {
    if (!configured) return
    setConfLoading(true)
    setConfError(null)
    try {
      const offset = append ? (confState?.rows.length ?? 0) : 0
      const { posts: rows, total } = await db.fetchConfessions({
        sort: 'latest',
        collegeId: myCollegeId,
        limit: 12,
        offset,
      })
      setConfState(current => ({
        rows: append ? [...(current?.rows ?? []), ...rows] : rows,
        total,
      }))
    } catch (error) {
      setConfError(db.friendlyMessage(error))
    } finally {
      setConfLoading(false)
      confLoadedRef.current = true
    }
  }, [configured, myCollegeId, confState?.rows.length])

  useEffect(() => {
    if (tab === 'confessions' && !confLoadedRef.current) void loadConfessions(false)
  }, [tab, loadConfessions])

  /** local mirrors for lists this page owns (offset feed pages, confession
   *  pages); the shared posts list is owned by App and patched there */
  const patchLocal = useCallback(
    (id: string, patch: Partial<Pick<CampusPost, 'likes' | 'liked' | 'comments'>>) => {
      setExtra(current => current.map(p => (p.id === id ? { ...p, ...patch } : p)))
      setConfState(current => current
        ? { ...current, rows: current.rows.map(p => (p.id === id ? { ...p, ...patch } : p)) }
        : current)
    },
    [],
  )

  // like/comment outcomes replay into the local pages (same store rules the
  // dedicated Confessions page lives by)
  useEffect(() => {
    if (!confessionPatch) return
    const patch: Partial<Pick<CampusPost, 'likes' | 'liked' | 'comments'>> = {}
    if (confessionPatch.likes !== undefined) patch.likes = confessionPatch.likes
    if (confessionPatch.liked !== undefined) patch.liked = confessionPatch.liked
    if (confessionPatch.comments !== undefined) patch.comments = confessionPatch.comments
    patchLocal(confessionPatch.id, patch)
  }, [confessionPatch, patchLocal])

  const likePost = useCallback(async (post: CampusPost) => {
    if (!requireAuth('like a post')) return
    if (post.kind === 'confession') {
      // confessions: optimistic flip with honest rollback — App rewrites the
      // canonical store and replays the outcome through confessionPatch
      const nextLiked = !post.liked
      const nextLikes = post.likes + (post.liked ? -1 : 1)
      patchLocal(post.id, { liked: nextLiked, likes: nextLikes })
      const ok = await onLike(post.id, post)
      if (!ok) patchLocal(post.id, { liked: post.liked, likes: post.likes })
      return
    }
    void likeBackstop(post)
    await onLike(post.id, post)
  }, [patchLocal, onLike, requireAuth])

  /** partagé backstop: rows this page owns but App's store does not (offset
   *  pages) — flip locally; a failure leaves the local copy correct because
   *  App's swap only rewinds its store and replays nothing for these rows. */
  const likeBackstop = useCallback((post: CampusPost) => {
    const inShared = posts.some(p => p.id === post.id)
    if (inShared) return
    const nextLiked = !post.liked
    const nextLikes = post.likes + (post.liked ? -1 : 1)
    patchLocal(post.id, { liked: nextLiked, likes: nextLikes })
  }, [posts, patchLocal])

  /* ---- events tab --------------------------------------------------------- */

  type EventState = { rows: ev.EventSummary[] } | null
  const [eventState, setEventState] = useState<EventState>(null)
  const [eventLoading, setEventLoading] = useState(false)
  const [eventError, setEventError] = useState<string | null>(null)
  const eventLoadedRef = useRef(false)
  const [eventBusy, setEventBusy] = useState<string | null>(null)

  const loadEvents = useCallback(async () => {
    if (!configured) return
    setEventLoading(true)
    setEventError(null)
    try {
      // server-scoped: list_events mycollege mode (migration 0018)
      const rows = await ev.listEvents({ mode: 'mycollege', sort: 'soonest', limit: 24, offset: 0 })
      setEventState({ rows })
    } catch (error) {
      setEventError(db.friendlyMessage(error))
    } finally {
      setEventLoading(false)
      eventLoadedRef.current = true
    }
  }, [configured])

  useEffect(() => {
    if (tab === 'events' && !eventLoadedRef.current && member) void loadEvents()
  }, [tab, member, loadEvents])

  const rsvpEvent = useCallback(async (row: ev.EventSummary) => {
    if (!requireAuth('RSVP to events')) return
    if (eventBusy) return
    const regState = registrationState(row)
    if (regState.key === 'closed') { notify('Registration for this event is closed.'); return }
    setEventBusy(row.id)
    try {
      if (row.my_status) {
        const result = await ev.cancelRegistration(row.id)
        notify(result === 'left_waitlist' ? 'You left the waitlist.' : 'RSVP cancelled.')
      } else {
        await ev.registerEvent(row.id, 'going')
        notify(`You're going to ${row.title}.`)
      }
      // authoritative re-read: seats and counts come from the server, never
      // from a local guess
      await loadEvents()
    } catch (error) {
      notify(db.friendlyMessage(error))
    } finally {
      setEventBusy(null)
    }
  }, [eventBusy, loadEvents, notify, requireAuth])

  const saveEvent = useCallback(async (row: ev.EventSummary) => {
    if (!requireAuth('save events')) return
    if (eventBusy) return
    setEventBusy(row.id)
    try {
      const saved = await ev.toggleSavedEvent(row.id, !row.saved)
      setEventState(current => current
        ? { rows: current.rows.map(r => (r.id === row.id ? { ...r, saved } : r)) }
        : current)
    } catch (error) {
      notify(db.friendlyMessage(error))
    } finally {
      setEventBusy(null)
    }
  }, [eventBusy, notify, requireAuth])

  /* ---- communities tab ------------------------------------------------------ */

  type CommunityState = { rows: cm.CommunitySummary[] } | null
  const [communityState, setCommunityState] = useState<CommunityState>(null)
  const [communityLoading, setCommunityLoading] = useState(false)
  const [communityError, setCommunityError] = useState<string | null>(null)
  const communityLoadedRef = useRef(false)
  const [communityAction, setCommunityAction] = useState<string | null>(null)

  const loadCommunities = useCallback(async () => {
    if (!configured || !myCollegeId) return
    setCommunityLoading(true)
    setCommunityError(null)
    try {
      // server-scoped: list_clubs with p_scope 'college' (migration 0016)
      const rows = await cm.listCommunities({
        scope: 'college',
        collegeId: myCollegeId,
        sort: 'popular',
        limit: 24,
        offset: 0,
      })
      setCommunityState({ rows })
    } catch (error) {
      setCommunityError(db.friendlyMessage(error))
    } finally {
      setCommunityLoading(false)
      communityLoadedRef.current = true
    }
  }, [configured, myCollegeId])

  useEffect(() => {
    if (tab === 'communities' && !communityLoadedRef.current && member) void loadCommunities()
  }, [tab, member, loadCommunities])

  const membershipAction = useCallback(async (row: cm.CommunitySummary) => {
    if (!requireAuth('manage community membership')) return
    if (communityAction) return
    setCommunityAction(row.id)
    try {
      if (row.my_status === 'pending') {
        await cm.cancelJoinRequest(row.id)
        notify('Join request cancelled.')
      } else if (row.my_status) {
        await cm.leaveCommunity(row.id)
        notify(`Left ${row.name}.`)
      } else {
        // private communities become join REQUESTS — surfaced as pending, the
        // request decision is made by community moderators in Communities.
        const outcome = await cm.joinCommunity(row.id)
        notify(outcome === 'requested'
          ? `Join request sent to ${row.name}.`
          : `Joined ${row.name}.`)
      }
      // authoritative re-read (my_status changes on the server)
      await loadCommunities()
    } catch (error) {
      notify(db.friendlyMessage(error))
    } finally {
      setCommunityAction(null)
    }
  }, [communityAction, loadCommunities, notify, requireAuth])

  /* ---- marketplace tab ------------------------------------------------------ */

  type MarketState = { rows: mk.ListingSummary[] } | null
  const [marketState, setMarketState] = useState<MarketState>(null)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketError, setMarketError] = useState<string | null>(null)
  const marketLoadedRef = useRef(false)
  const [marketBusy, setMarketBusy] = useState<string | null>(null)

  const loadListings = useCallback(async () => {
    if (!configured || !myCollegeId) return
    setMarketLoading(true)
    setMarketError(null)
    try {
      // server-scoped: list_listings mycollege mode (migration 0019) — the RPC
      // decides what is visible (sold/withdrawn listings follow marketplace
      // rules) exactly like the Marketplace page's own My College tab
      const rows = await mk.listListings({ mode: 'mycollege', sort: 'new', limit: 24, offset: 0 })
      setMarketState({ rows })
    } catch (error) {
      setMarketError(db.friendlyMessage(error))
    } finally {
      setMarketLoading(false)
      marketLoadedRef.current = true
    }
  }, [configured, myCollegeId])

  useEffect(() => {
    if (tab === 'market' && !marketLoadedRef.current && member) void loadListings()
  }, [tab, member, loadListings])

  const saveListing = useCallback(async (row: mk.ListingSummary) => {
    if (!requireAuth('save listings')) return
    if (marketBusy) return
    setMarketBusy(row.id)
    try {
      /** authoritative result — the service returns the new saved flag */
      const saved = await mk.toggleSavedListing(row.id)
      setMarketState(current => current
        ? { rows: current.rows.map(r => (r.id === row.id ? { ...r, savedByMe: saved } : r)) }
        : current)
    } catch (error) {
      notify(db.friendlyMessage(error))
    } finally {
      setMarketBusy(null)
    }
  }, [marketBusy, notify, requireAuth])

  /* ---- students tab ----------------------------------------------------------- */

  type StudentState = { rows: db.CollegeStudent[]; hasMore: boolean } | null
  const [studentState, setStudentState] = useState<StudentState>(null)
  const [studentLoading, setStudentLoading] = useState(false)
  const [studentError, setStudentError] = useState<string | null>(null)
  const studentLoadedRef = useRef(false)
  const [followBusy, setFollowBusy] = useState<string | null>(null)

  const loadStudents = useCallback(async (append = false) => {
    if (!configured || !myCollegeId) return
    setStudentLoading(true)
    setStudentError(null)
    try {
      const offset = append ? (studentState?.rows.length ?? 0) : 0
      const rows = await db.fetchCollegeStudents(myCollegeId, identity?.id ?? null, 24, offset)
      setStudentState(current => {
        const rows2 = append && current
          ? [...current.rows, ...rows.filter(r => !current.rows.some(x => x.id === r.id))]
          : rows
        return { rows: rows2, hasMore: rows.length >= 24 }
      })
    } catch (error) {
      setStudentError(db.friendlyMessage(error))
    } finally {
      setStudentLoading(false)
      studentLoadedRef.current = true
    }
  }, [configured, myCollegeId, identity?.id, studentState?.rows])

  useEffect(() => {
    if (tab === 'students' && !studentLoadedRef.current && member) void loadStudents(false)
  }, [tab, member, loadStudents])

  const toggleStudentFollow = useCallback(async (student: db.CollegeStudent) => {
    if (!requireAuth('follow classmates')) return
    if (followBusy) return
    setFollowBusy(student.id)
    const handle = `@${student.username}`
    const current = following.includes(handle)
    const ok = await onToggleFollow(student.id, current, handle)
    setFollowBusy(null)
    if (!ok) return // App flashed the failure; state stays exactly as it was
    void member // follows live in App's store — the prop re-renders the row
  }, [followBusy, following, onToggleFollow, requireAuth])

  /* ---- search tab (server-side search, scoped to the college) ---------------- */

  const [searchQuery, setSearchQuery] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchRun, setSearchRun] = useState('')
  const [postHits, setPostHits] = useState<CampusPost[]>([])
  const [peopleHits, setPeopleHits] = useState<db.PersonResult[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchDone, setSearchDone] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const searchRunRef = useRef(0)

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim()
    if (q.length < 2) { setSearchRun(''); setSearchDone(false); setPostHits([]); setPeopleHits([]); return }
    const run = ++searchRunRef.current
    setSearchBusy(true)
    setSearchError(null)
    setSearchRun(q)
    try {
      // server functions (migration 0007) + strict on-client college lock —
      // search_posts keeps anonymous authors hidden exactly like the feed RPC
      const [members, postRows] = await Promise.all([
        db.searchMembers(q, 15),
        db.searchPosts(q, 20),
      ])
      if (run !== searchRunRef.current) return // obsolete keystroke — drop it
      const inCollege = (shortName: string | null, id?: string | null) =>
        myCollegeId ? (id ? id === myCollegeId : Boolean(shortName) && shortName === myShort) : false
      setPeopleHits(members.filter(m => !m.isPrivate && inCollege(m.collegeShort, m.collegeId)))
      setPostHits(postRows.filter(p => mineCollegeP(p, myCollegeId, myShort)))
      setSearchDone(true)
    } catch (error) {
      if (run === searchRunRef.current) setSearchError(db.friendlyMessage(error))
    } finally {
      if (run === searchRunRef.current) setSearchBusy(false)
    }
  }, [myCollegeId, myShort])

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => { void runSearch(searchQuery) }, SEARCH_DEBOUNCE_MS)
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  /* ---- leaderboard strip (real RPC, honest degradation) ------------------------ */

  const [leaders, setLeaders] = useState<db.LeaderboardEntry[] | null>(null)
  useEffect(() => {
    if (!member || !configured || !identity) return
    let alive = true
    db.fetchLeaderboard('college', 'week', 0, 5)
      .then(rows => { if (alive) setLeaders(rows.slice(0, 5)) })
      .catch(() => { if (alive) setLeaders([]) }) // an empty strip, never fake points
    return () => { alive = false }
  }, [member, configured, identity])

  /* ---- college chooser (members without a college — canonical ID saved) -------- */

  const [choosing, setChoosing] = useState(false)
  const [collegeQuery, setCollegeQuery] = useState('')
  const [savingCollege, setSavingCollege] = useState(false)

  const collegeOptions = useMemo(() => {
    const q = collegeQuery.trim().toLowerCase()
    const base = q
      ? colleges.filter(c => c.name.toLowerCase().includes(q) || c.short_name.toLowerCase().includes(q) || (c.city ?? '').toLowerCase().includes(q))
      : colleges
    return base.slice(0, 12)
  }, [colleges, collegeQuery])

  const pickCollege = useCallback(async (row: db.College) => {
    if (!identity?.id || savingCollege) return
    setSavingCollege(true)
    try {
      // the canonical save path the onboarding wizard already uses — same
      // service, same columns; nothing new is invented
      await db.saveProfile(identity.id, {
        college_id: row.id,
        college_declared_at: caps.profileExtras ? new Date().toISOString() : undefined,
      }, caps)
      onProfilePatched()
      setChoosing(false)
      notify(`Your college is now ${row.short_name}.`)
    } catch (error) {
      notify(db.friendlyMessage(error))
    } finally {
      setSavingCollege(false)
    }
  }, [identity?.id, savingCollege, caps, onProfilePatched, notify])

  /* ---- render -------------------------------------------------------------------- */

  if (status === 'onboarding') {
    return (
      <div className="mcl-page">
        <div className="mcl-empty">
          <BuildingIcon/>
          <b>Finishing your profile</b>
          <span>Complete the onboarding steps — My College opens once your account is ready.</span>
        </div>
      </div>
    )
  }

  if (status !== 'member') {
    return (
      <div className="mcl-page">
        <div className="mcl-empty">
          <BuildingIcon/>
          <b>My College is for CAMPUS members</b>
          <span>Sign in to see what's happening at your college.</span>
          <button className="primary-button mcl-cta" onClick={() => { if (!requireAuth('see your college hub')) return }}>
            Sign in to continue
          </button>
        </div>
      </div>
    )
  }

  if (isStaff) {
    // 0042/0043: platform staff carry no college and must not self-join one.
    return (
      <div className="mcl-page">
        <div className="mcl-empty">
          <ShieldCheck size={26} className="mcl-empty-icon"/>
          <b>Platform staff have no college</b>
          <span>Your account works across every college. Announcements posted as @campus reach the main feed — My College scopes to one institution, which wouldn't reflect your platform role.</span>
          <button className="primary-button mcl-cta" onClick={() => onNavigate('Staff Console')}>
            Open Staff Console <ChevronRight size={15}/>
          </button>
        </div>
      </div>
    )
  }

  if (!myCollegeId) {
    return (
      <div className="mcl-page">
        <div className="mcl-empty">
          <BuildingIcon/>
          <b>Choose your college first</b>
          <span>Picking your college personalizes My College — your feed, confessions, events and classmates all scope to it. Nothing is guessed; you choose the exact institution.</span>
          <button className="primary-button mcl-cta" onClick={() => setChoosing(true)}>
            Choose your college
          </button>
        </div>
        <CollegeChooser
          show={choosing}
          saving={savingCollege}
          query={collegeQuery}
          setQuery={setCollegeQuery}
          options={collegeOptions}
          onClose={() => setChoosing(false)}
          onPick={row => void pickCollege(row)}
        />
      </div>
    )
  }

  /* ---- panes ----------------------------------------------------------------------- */

  const feedPane = (rows: CampusPost[], note: string | null, keyPrefix: string, emptyBody?: string) => (
    <section className="mcl-feed">
      {note && <p className="mcl-hint">{note}</p>}
      {rows.length
        ? rows.map(post => (
            <PostCard
              key={`${keyPrefix}-${post.id}`}
              post={post}
              isOwn={Boolean(identity?.id && post.authorId && post.authorId === identity.id && !post.anonymous)}
              poll={pollFor(post)}
              onVote={ids => onVote(post, ids)}
              onLike={() => void likePost(post)}
              onSave={() => onSave(post.id, post)}
              onComment={() => onComment(post)}
              onShare={() => onShare(post)}
              onReport={() => onReport(post)}
              onRepost={() => onRepost(post.id, post)}
              onBlock={() => onRelation('user_blocks', post)}
              onMute={() => onRelation('user_mutes', post)}
              onEdit={() => onEdit(post)}
              onDelete={() => onDelete(post)}
              onMessage={() => onMessage(post)}
              onOpenMention={onOpenProfile}
              onOpenTag={onOpenTag}
            />
          ))
        : !feedLoading && (
          <div className="mcl-empty mcl-empty-inner">
            <Sparkles size={24} className="mcl-empty-icon"/>
            <b>Nothing here yet</b>
            {/* honest per-tab copy — Following is about who you follow, not
                campus-wide activity, so its empty state never says
                "be the first to post" */}
            <span>
              {emptyBody ?? `Be the first from ${myShort || 'your college'} to post.`}
            </span>
            <button className="primary-button mcl-cta" onClick={() => onOpenComposer('post')}>
              Write a post
            </button>
          </div>
        )}
      {FEED_TABS.includes(tab) && (
        <>
          {extraError && (
            <div className="mcl-error" role="status">
              <p>{extraError}</p>
              <button className="secondary-button" onClick={() => void loadMorePosts()}>Try again</button>
            </div>
          )}
          {feedSource === 'db' && collegePosts.length >= FEED_PAGE_LIMIT && (
            <button
              className="secondary-button mcl-more"
              disabled={extraLoading}
              onClick={() => void loadMorePosts()}
            >
              {extraLoading ? <Loader2 size={15} className="mcl-spin"/> : null}
              {extraLoading ? ' Loading…' : ' Show more posts'}
            </button>
          )}
        </>
      )}
    </section>
  )

  const pollsPane = (
    <section className="mcl-feed">
      <p className="mcl-hint">
        Polls from your college — votes are validated by the poll engine (one vote per student unless
        the poll explicitly allows multiple choices; closed polls reject new votes server-side).
      </p>
      {pollsFeed.length
        ? pollsFeed.map(post => (
            <PostCard
              key={`polls-${post.id}`}
              post={post}
              isOwn={Boolean(identity?.id && post.authorId === identity.id && !post.anonymous)}
              poll={pollFor(post)}
              onVote={ids => onVote(post, ids)}
              onLike={() => void likePost(post)}
              onSave={() => onSave(post.id, post)}
              onComment={() => onComment(post)}
              onShare={() => onShare(post)}
              onReport={() => onReport(post)}
              onRepost={() => onRepost(post.id, post)}
              onBlock={() => onRelation('user_blocks', post)}
              onMute={() => onRelation('user_mutes', post)}
              onEdit={() => onEdit(post)}
              onDelete={() => onDelete(post)}
              onMessage={() => onMessage(post)}
              onOpenMention={onOpenProfile}
              onOpenTag={onOpenTag}
            />
          ))
        : <div className="mcl-empty mcl-empty-inner"><Dices size={24} className="mcl-empty-icon"/><b>No polls yet</b><span>Create one from the Home composer's poll tool.</span></div>}
    </section>
  )

  const confessionsPane = (
    <section className="mcl-feed">
      <div className="mcl-rowhead">
        <p className="mcl-hint flex-1">
          Confessions from your college — the author identity is hidden by the server (anonymity is
          enforced in the database, not only in this UI). Reporting is always available.
        </p>
        <button className="primary-button mcl-cta" onClick={openConfessionsPage}>
          <BookOpen size={15}/> Create confession
        </button>
      </div>
      {confError && (
        <div className="mcl-error" role="status">
          <p>{confError}</p>
          <button className="secondary-button" onClick={() => void loadConfessions(false)}>Try again</button>
        </div>
      )}
      {confLoading && !confState && <div className="mcl-loading"><Loader2 size={16} className="mcl-spin"/> Loading confessions…</div>}
      {confState?.rows.length
        ? confState.rows.map(post => (
            <PostCard
              key={`conf-${post.id}`}
              post={post}
              isOwn={false}
              poll={pollFor(post)}
              onVote={ids => onVote(post, ids)}
              onLike={() => void likePost(post)}
              onSave={() => onSave(post.id, post)}
              onComment={() => onComment(post)}
              onShare={() => onShare(post)}
              onReport={() => onReport(post)}
              onRepost={() => onRepost(post.id, post)}
              onBlock={() => onRelation('user_blocks', post)}
              onMute={() => onRelation('user_mutes', post)}
              onEdit={() => undefined}
              onDelete={() => undefined}
              onMessage={() => undefined}
              onOpenMention={onOpenProfile}
              onOpenTag={onOpenTag}
            />
          ))
        : !confLoading && confState && (
          <div className="mcl-empty mcl-empty-inner">
            <BookOpen size={24} className="mcl-empty-icon"/>
            <b>No confessions from your college yet</b>
            <span>The anonymous wall fills up when students post with their college.</span>
          </div>
        )}
      {confState && confState.rows.length < confState.total && (
        <button
          className="secondary-button mcl-more"
          disabled={confLoading}
          onClick={() => void loadConfessions(true)}
        >
          {confLoading ? <Loader2 size={15} className="mcl-spin"/> : null}
          {confLoading ? ' Loading…' : ` Show more (${confState.total - confState.rows.length} older)`}
        </button>
      )}
    </section>
  )

  const eventsPane = (
    <section className="mcl-feed" aria-label="College events">
      <div className="mcl-rowhead">
        <p className="mcl-hint flex-1">Upcoming events for your college — RSVP through the events engine; seat counts are read live from the server.</p>
        <button
          className="secondary-button"
          aria-label="Refresh college events"
          disabled={eventLoading}
          onClick={() => void loadEvents()}
        >
          <RefreshCw size={14}/> Refresh
        </button>
      </div>
      {eventError && (
        <div className="mcl-error" role="status">
          <p>{eventError}</p>
          <button className="secondary-button" onClick={() => void loadEvents()}>Try again</button>
        </div>
      )}
      {eventLoading && !eventState && <div className="mcl-loading"><Loader2 size={16} className="mcl-spin"/> Loading events…</div>}
      {eventState?.rows.length
        ? eventState.rows.map(row => <EventRow key={row.id} row={row} busy={eventBusy === row.id} onOpen={() => onOpenEvent(row.slug)} onRsvp={() => void rsvpEvent(row)} />)
        : !eventLoading && !eventError && eventState && (
          <div className="mcl-empty mcl-empty-inner">
            <CalendarDays size={24} className="mcl-empty-icon"/>
            <b>No upcoming events for your college</b>
            <span>Fests, workshops and meetups your college adds will appear here.</span>
            <button className="primary-button mcl-cta" onClick={() => onNavigate('Events')}>Discover events</button>
          </div>
        )}
    </section>
  )

  const communitiesPane = (
    <section className="mcl-feed" aria-label="College communities">
      <div className="mcl-rowhead">
        <p className="mcl-hint flex-1">Communities that explicitly belong to your college (server-checked college scope — never inferred from who created them).</p>
        <button className="secondary-button" onClick={() => onNavigate('Communities')}>
          All communities <ChevronRight size={14}/>
        </button>
      </div>
      {communityError && (
        <div className="mcl-error" role="status">
          <p>{communityError}</p>
          <button className="secondary-button" onClick={() => void loadCommunities()}>Try again</button>
        </div>
      )}
      {communityLoading && !communityState && <div className="mcl-loading"><Loader2 size={16} className="mcl-spin"/> Loading communities…</div>}
      {communityState?.rows.length
        ? communityState.rows.map(row => (
            <div className="mcl-community" key={row.id}>
              <button className="mcl-community-main" onClick={() => onOpenCommunity(row.id)} aria-label={`Open ${row.name}`}>
                <span className="mcl-community-logo" aria-hidden="true">
                  {row.logo_url ? <img src={row.logo_url} alt="" loading="lazy"/> : <Users size={18}/>}
                </span>
                <span className="mcl-community-copy">
                  <b>{row.name}</b>
                  <small>{row.category} · {row.member_count} member{row.member_count === 1 ? '' : 's'}{row.privacy === 'private' ? ' · Private' : ''}</small>
                  <span className="mcl-community-desc">{row.description}</span>
                </span>
              </button>
              <button
                className={row.my_status ? 'secondary-button' : 'primary-button'}
                disabled={communityAction === row.id}
                onClick={() => void membershipAction(row)}
                aria-label={row.my_status === 'pending' ? `Cancel join request to ${row.name}` : row.my_status ? `Leave ${row.name}` : `Join ${row.name}`}
              >
                {communityAction === row.id
                  ? <Loader2 size={14} className="mcl-spin"/>
                  : row.my_status === 'pending'
                    ? <><Hourglass size={13}/> Requested</>
                    : row.my_status
                      ? <>Joined <Check size={13}/></>
                      : <>Join</>}
              </button>
            </div>
          ))
        : !communityLoading && !communityError && communityState && (
          <div className="mcl-empty mcl-empty-inner">
            <Users size={24} className="mcl-empty-icon"/>
            <b>No college communities yet</b>
            <span>Start one from the Communities page — you pick its college scope there.</span>
            <button className="primary-button mcl-cta" onClick={() => onNavigate('Communities')}>Open Communities</button>
          </div>
        )}
    </section>
  )

  const studentsPane = (
    <section className="mcl-feed" aria-label="Classmates">
      <div className="mcl-rowhead">
        <p className="mcl-hint flex-1">Public student profiles from your college. Being findable is not being browsable — private profiles stay out.</p>
        <button className="secondary-button" onClick={() => onNavigate('Discover')}>
          Discover <ChevronRight size={14}/>
        </button>
      </div>
      {studentError && (
        <div className="mcl-error" role="status">
          <p>{studentError}</p>
          <button className="secondary-button" onClick={() => void loadStudents(false)}>Try again</button>
        </div>
      )}
      {studentLoading && !studentState && <div className="mcl-loading"><Loader2 size={16} className="mcl-spin"/> Finding classmates…</div>}
      {studentState?.rows.length
        ? studentState.rows.map(s => (
            <div className="mcl-student" key={s.id}>
              <button className="mcl-student-main" onClick={() => onOpenProfile(s.id)} aria-label={`Open ${s.name}'s profile`}>
                <span className="mcl-student-avatar" aria-hidden="true">
                  {s.avatarUrl
                    ? <img src={s.avatarUrl} alt="" loading="lazy"/>
                    : s.name.trim().slice(0, 1).toUpperCase()}
                </span>
                <span className="mcl-student-copy">
                  <b>{s.name}{s.isVerified ? <ShieldCheck size={13} className="mcl-verified" aria-label="Verified account"/> : null}</b>
                  <small>@{s.username}{s.course ? ` · ${s.course}` : ''}{s.year ? ` · Year ${s.year}` : ''}</small>
                </span>
              </button>
              <button
                className={following.includes(`@${s.username}`) ? 'secondary-button' : 'primary-button'}
                disabled={followBusy === s.id}
                onClick={() => void toggleStudentFollow(s)}
                aria-label={following.includes(`@${s.username}`) ? `Unfollow @${s.username}` : `Follow @${s.username}`}
              >
                {followBusy === s.id
                  ? <Loader2 size={14} className="mcl-spin"/>
                  : following.includes(`@${s.username}`)
                    ? <>Following <Check size={13}/></>
                    : <><UserRound size={13}/> Follow</>}
              </button>
            </div>
          ))
        : !studentLoading && !studentError && studentState && (
          <div className="mcl-empty mcl-empty-inner">
            <UserRound size={24} className="mcl-empty-icon"/>
            <b>No public classmates yet</b>
            <span>Classmates with public profiles appear here — nothing is assumed or inferred.</span>
            <button className="primary-button mcl-cta" onClick={() => onNavigate('Discover')}>Discover people</button>
          </div>
        )}
      {studentState?.hasMore && (
        <button className="secondary-button mcl-more" disabled={studentLoading} onClick={() => void loadStudents(true)}>
          {studentLoading ? <Loader2 size={15} className="mcl-spin"/> : null}
          {studentLoading ? ' Loading…' : ' Show more classmates'}
        </button>
      )}
    </section>
  )

  const marketPane = (
    <section className="mcl-feed" aria-label="Student marketplace">
      <div className="mcl-rowhead">
        <p className="mcl-hint flex-1">Listings scoped to your college by the marketplace engine — seller contact uses existing CAMPUS chat.</p>
        <button className="secondary-button" onClick={() => onNavigate('Marketplace')}>
          Full marketplace <ChevronRight size={14}/>
        </button>
      </div>
      {marketError && (
        <div className="mcl-error" role="status">
          <p>{marketError}</p>
          <button className="secondary-button" onClick={() => void loadListings()}>Try again</button>
        </div>
      )}
      {marketLoading && !marketState && <div className="mcl-loading"><Loader2 size={16} className="mcl-spin"/> Loading listings…</div>}
      {marketState?.rows.length
        ? marketState.rows.map(row => (
            <button className="mcl-listing" key={row.id} onClick={() => onOpenListing(row.slug)}>
              {row.images[0]
                ? <img className="mcl-listing-img" src={row.images[0]} alt="" loading="lazy"/>
                : <span className="mcl-listing-img mcl-listing-blank" aria-hidden="true"><CircleDollarSign size={20}/></span>}
              <span className="mcl-listing-copy">
                <b>{row.title}</b>
                <small>
                  {mk.priceLine(row) ?? mk.TX_LABELS[row.transactionType]}
                  {row.status !== 'active' ? ` · ${mk.STATUS_LABELS[row.status]}` : ''}
                </small>
                <span className="mcl-listing-meta">{mk.HANDOVER_LABELS[row.handover]}</span>
              </span>
              <span
                role="button"
                tabIndex={0}
                className={row.savedByMe ? 'mcl-chip active' : 'mcl-chip'}
                aria-label={row.savedByMe ? `Remove ${row.title} from saved` : `Save ${row.title}`}
                onClick={e => { e.stopPropagation(); void saveListing(row) }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); void saveListing(row) } }}
              >
                {marketBusy === row.id
                  ? <Loader2 size={14} className="mcl-spin"/>
                  : row.savedByMe ? <>Saved <Check size={12}/></> : <>Save</>}
              </span>
            </button>
          ))
        : !marketLoading && !marketError && marketState && (
          <div className="mcl-empty mcl-empty-inner">
            <CircleDollarSign size={24} className="mcl-empty-icon"/>
            <b>No listings from your college yet</b>
            <span>List the first item and it shows up here instantly.</span>
            <button className="primary-button mcl-cta" onClick={() => onNavigate('Marketplace')}>Open Marketplace</button>
          </div>
        )}
    </section>
  )

  const searchPane = (
    <section className="mcl-feed" aria-label="College search">
      <div className="mcl-searchbar">
        <Search size={16}/>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search within your college — posts and people"
          aria-label="Search within your college"
          maxLength={60}
        />
        {searchQuery && (
          <button className="icon-button" aria-label="Clear search" onClick={() => setSearchQuery('')}>
            <X size={15}/>
          </button>
        )}
      </div>
      {searchBusy && <div className="mcl-loading"><Loader2 size={16} className="mcl-spin"/> Searching…</div>}
      {!searchBusy && searchError && <div className="mcl-error" role="status"><p>{searchError}</p></div>}
      {!searchBusy && !searchError && searchRun && searchDone && (
        <>
          <h3 className="mcl-nav-h3">Students</h3>
          {peopleHits.length
            ? peopleHits.map(m => (
                <button className="mcl-student" key={m.id} onClick={() => onOpenProfile(m.id)}>
                  <span className="mcl-student-copy flex-1">
                    <b>{m.displayName}</b>
                    <small>{m.username ? `@${m.username}` : ''}{m.collegeShort && m.collegeShort !== myShort ? ` · ${m.collegeShort}` : ''}</small>
                  </span>
                  <ChevronRight size={15}/>
                </button>
              ))
            : <p className="mcl-hint">No classmates match “{searchRun}”.</p>}
          <h3 className="mcl-nav-h3">Posts</h3>
          {postHits.length
            ? postHits.map(post => (
                <PostCard
                  key={`sr-${post.id}`}
                  post={post}
                  isOwn={Boolean(identity?.id && post.authorId === identity.id && !post.anonymous)}
                  poll={pollFor(post)}
                  onVote={ids => onVote(post, ids)}
                  onLike={() => void likePost(post)}
                  onSave={() => onSave(post.id, post)}
                  onComment={() => onComment(post)}
                  onShare={() => onShare(post)}
                  onReport={() => onReport(post)}
                  onRepost={() => onRepost(post.id, post)}
                  onBlock={() => onRelation('user_blocks', post)}
                  onMute={() => onRelation('user_mutes', post)}
                  onEdit={() => onEdit(post)}
                  onDelete={() => onDelete(post)}
                  onMessage={() => onMessage(post)}
                  onOpenMention={onOpenProfile}
                  onOpenTag={onOpenTag}
                />
              ))
            : <p className="mcl-hint">No posts in your college match “{searchRun}”.</p>}
        </>
      )}
      {!searchBusy && !searchRun && (
        <p className="mcl-hint">
          Type to search inside your college. For campus-wide people, posts, colleges and clubs use the{' '}
          <button className="mcl-linklike" onClick={() => onNavigate('Search')}>full search</button>.
        </p>
      )}
    </section>
  )

  const leaderStrip = leaders === null
    ? null
    : leaders.length
      ? (
        <section className="mcl-leaders" aria-label="College leaderboard this week">
          <span className="mcl-leaders-title"><Trophy size={15}/> Top students this week</span>
          <div className="mcl-leaders-row">
            {leaders.slice(0, 3).map((entry, i) => (
              <button key={entry.userId} className="mcl-leader" onClick={() => onOpenProfile(entry.userId)}>
                <small>#{i + 1}</small>
                <b>{entry.displayName.split(' ')[0]}</b>
                <span>{entry.points} pts</span>
              </button>
            ))}
          </div>
          <button className="mcl-linklike mcl-leaders-more" onClick={() => onNavigate('Leaderboard')}>
            See the full board <ChevronRight size={12}/>
          </button>
        </section>
      )
      : null

  const pane = (() => {
    switch (tab) {
      case 'foryou': return feedPane(forYou, null, 'fy')
      case 'following': return feedPane(
        followingFeed,
        followingFeed.length === 0
          ? 'College posts from classmates you follow land here. Open the Students tab to find people.'
          : 'College posts from accounts you follow.',
        'fl',
        followingFeed.length === 0
          ? `No posts yet from people you follow — they may not have posted recently. The Students tab has everyone from ${myShort || 'your college'}.`
          : undefined,
      )
      case 'trending': return feedPane(trending, TRENDING_NOTE, 'tr')
      case 'latest': return feedPane(latest, 'Newest posts from your college, newest first.', 'lt')
      case 'confessions': return confessionsPane
      case 'polls': return pollsPane
      case 'events': return eventsPane
      case 'communities': return communitiesPane
      case 'students': return studentsPane
      case 'market': return marketPane
      case 'search': return searchPane
    }
  })()

  return (
    <div className="mcl-page">
      {/* compact college header — one band; identity from the canonical row */}
      <header className="mcl-hero">
        <span className="mcl-seal" aria-hidden="true">{myShort.slice(0, 8) || <BuildingMark/>}</span>
        <span className="mcl-hero-copy">
          <b>
            {collegeRow?.name ?? myShort}
            {collegeRow?.verified ? <ShieldCheck size={14} className="mcl-verified" aria-label="Verified college"/> : null}
          </b>
          <small>{collegeRow?.city ? `${collegeRow.city} · ` : ''}Your campus community on CAMPUS</small>
        </span>
        <button className="icon-button" aria-label="Open notifications" onClick={() => onNavigate('Notifications')}>
          <Bell size={18}/>
        </button>
        <button className="secondary-button mcl-switch" onClick={() => setChoosing(true)}>
          Change
        </button>
      </header>

      {leaderStrip}

      <nav className="mcl-tabs" role="tablist" aria-label="My College sections">
        {TABS.map(t =>
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'selected' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>)}
      </nav>

      <div className="mcl-refreshrow">
        <button
          className="secondary-button"
          disabled={feedLoading}
          aria-label="Refresh this section"
          onClick={() => {
            if (FEED_TABS.includes(tab)) reloadFeed()
            else if (tab === 'confessions') void loadConfessions(false)
            else if (tab === 'events') void loadEvents()
            else if (tab === 'communities') void loadCommunities()
            else if (tab === 'students') void loadStudents(false)
            else if (tab === 'market') void loadListings()
          }}
        >
          <RefreshCw size={14}/> Refresh
        </button>
        {feedSource === 'local' && FEED_TABS.includes(tab) && (
          <span className="mcl-flag">Sample posts — database not connected</span>
        )}
      </div>

      {pane}

      <CollegeChooser
        show={choosing}
        saving={savingCollege}
        query={collegeQuery}
        setQuery={setCollegeQuery}
        options={collegeOptions}
        onClose={() => setChoosing(false)}
        onPick={row => void pickCollege(row)}
      />
    </div>
  )
}

/* ---------- small internal pieces ---------------------------------------- */

function BuildingMark() {
  return <span className="mcl-seal-default" aria-hidden="true">Campus</span>
}
function BuildingIcon() {
  return <span className="mcl-seal big" aria-hidden="true">My College</span>
}

function CollegeChooser({
  show, saving, query, setQuery, options, onClose, onPick,
}: {
  show: boolean
  saving: boolean
  query: string
  setQuery: (value: string) => void
  options: db.College[]
  onClose: () => void
  onPick: (row: db.College) => void
}) {
  if (!show) return null
  return (
    <div className="mcl-chooser" role="dialog" aria-label="Choose your college">
      <div className="mcl-chooser-head">
        <b>Choose your college</b>
        <button className="icon-button" aria-label="Close college chooser" onClick={onClose}>
          <X size={17}/>
        </button>
      </div>
      <input
        className="mcl-chooser-input"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search colleges by name or city"
        aria-label="Search colleges"
        maxLength={60}
      />
      <div className="mcl-chooser-list">
        {options.map(row => (
          <button key={row.id} className="mcl-chooser-row" disabled={saving} onClick={() => onPick(row)}>
            <span className="mcl-seal small" aria-hidden="true">{row.short_name.slice(0, 6)}</span>
            <span className="mcl-chooser-copy">
              <b>{row.name}</b>
              <small>{row.city}</small>
            </span>
            {row.verified ? <ShieldCheck size={14} className="mcl-verified" aria-label="Verified college"/> : null}
          </button>
        ))}
        {options.length === 0 && (
          <p className="mcl-hint">No match here. New colleges are suggested via onboarding — ask your classmates to add yours from the profile flow.</p>
        )}
        {saving && <div className="mcl-loading"><Loader2 size={14} className="mcl-spin"/> Saving…</div>}
      </div>
    </div>
  )
}

/** compact event row — reuses the shared registrationState helper + event
 *  service functions (no second RSVP backend lives here) */
function EventRow({
  row,
  busy,
  onOpen,
  onRsvp,
}: {
  row: ev.EventSummary
  busy: boolean
  onOpen: () => void
  onRsvp: () => void
}) {
  const state = registrationState(row)
  const upcoming = !row.cancelled_at && new Date(row.starts_at).getTime() > Date.now()
  return (
    <div className="mcl-event">
      <button className="mcl-event-main" onClick={onOpen} aria-label={`Open ${row.title}`}>
        {row.cover_url
          ? <img className="mcl-listing-img" src={row.cover_url} alt="" loading="lazy"/>
          : <span className="mcl-listing-img mcl-listing-blank" aria-hidden="true"><CalendarDays size={20}/></span>}
        <span className="mcl-listing-copy">
          <b>{row.title}</b>
          <small>
            {ev.fmtLong(row.starts_at)}
            {row.venue ? ` · ${row.venue}` : ''}
            {row.club_name ? ` · by ${row.club_name}` : ''}
          </small>
          <span className="mcl-event-chips">
            <i className={row.cancelled_at ? 'bad' : upcoming ? 'live' : 'off'}>
              {row.cancelled_at ? 'Cancelled' : state.label}
            </i>
            {row.capacity != null && row.seats_taken != null
              ? <i>{Number(row.seats_taken)}/{row.capacity} seats</i>
              : row.going_count != null ? <i>{Number(row.going_count)} going</i> : null}
          </span>
        </span>
      </button>
      {!row.cancelled_at && upcoming && (
        <button
          className={row.my_status ? 'secondary-button' : 'primary-button'}
          disabled={busy}
          onClick={onRsvp}
          aria-label={row.my_status ? `Cancel RSVP to ${row.title}` : `RSVP to ${row.title}`}
        >
          {busy
            ? <Loader2 size={14} className="mcl-spin"/>
            : row.my_status
              ? <>RSVP'd <Check size={13}/></>
              : <>RSVP</>}
        </button>
      )}
    </div>
  )
}
