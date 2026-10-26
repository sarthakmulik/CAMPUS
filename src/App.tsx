import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useOverlayBackGuard } from './lib/navHistory'
import {
  Home, Compass, Sparkles, Users, CalendarDays, Trophy, BriefcaseBusiness,
  CircleDollarSign, BookOpen, MessageCircle, Bell, Bookmark, Search, Building2,
  Shield, Plus, Image, ChartNoAxesColumn, Clapperboard, Heart, MessageSquare,
  Repeat2, Share2, Flag, MoreHorizontal, X, Send, ChevronDown, TrendingUp,
  Settings, LogOut, UserRound, Check, Hash, Menu, ArrowLeft, CircleHelp,
  GraduationCap, Megaphone, SlidersHorizontal, EyeOff, VolumeX, AlertCircle,
  Pencil, Trash2, BadgeCheck, ShieldCheck, Loader2
} from 'lucide-react'
import { AuthProvider, hasSeenWelcome, markWelcomeSeen, useAuth } from './lib/auth'
import { saveComposerDraft, loadComposerDraft, clearComposerDraft, type ComposerDraftMeta } from './lib/drafts'
import { StaffConsole } from './components/StaffConsole'
import { reconcilePush } from './lib/webPush'
import * as navHistory from './lib/navHistory'
import * as db from './lib/db'
import WelcomeScreen from './components/WelcomeScreen'
import AuthModal, { type AuthMode } from './components/AuthModal'
import SignUpPrompt from './components/SignUpPrompt'
import OnboardingWizard from './components/OnboardingWizard'
import SafetyCentre from './components/SafetyCentre'
import ReelTrim from './components/ReelTrim'
import RichText from './components/RichText'
import PostCard from './components/PostCard'
import AdsAdmin from './components/AdsAdmin'
import SponsoredCard from './components/SponsoredCard'
import * as ads from './lib/ads'
import type { SponsoredAd } from './lib/ads'
import Communities from './components/Communities'
import Events from './components/Events'
import Marketplace from './components/Marketplace'
import BootScreen from './components/BootScreen'
import * as cm from './lib/communities'
import ReelPlayer from './components/ReelPlayer'
import ReelsFeed from './components/ReelsFeed'
import CommentsSheet from './components/CommentsSheet'
import Chats from './components/Chats'
import Bookmarks from './components/Bookmarks'
import NotificationCenter from './components/NotificationCenter'
import Confessions from './components/Confessions'
import Leaderboard from './components/Leaderboard'
import MyCollege from './components/MyCollege'
import * as bk from './lib/bookmarks'
import SearchPanel from './components/SearchPanel'
import Profile from './components/Profile'
import ReportDialog, { type ReportTarget } from './components/ReportDialog'
import ShareContentSheet, { type ShareTarget } from './components/chat/ShareContentSheet'
import type { CampusPost, PollState, PostKind } from './types'
import * as media from './lib/media'
import { REEL_WINDOW_SECONDS } from './lib/media'
import { attachSheetDismiss } from './lib/sheetDismiss'

const seedPosts: CampusPost[] = [
  { id:'p1', author:'Campus Bot', handle:'@campus', initials:'CB', college:'SPPU', time:'a month ago', body:'Exam week survival kit: coffee, notes you barely understand, and pure panic. We got this. 💪 #Exams', likes:412, comments:29, reposts:7, kind:'post', trending:true, tag:'#Exams' },
  { id:'p2', author:'Anonymous', handle:'', initials:'', college:'Your college', time:'a month ago', body:'Who mf said Rohan loves Raksha', likes:2, comments:1, reposts:0, kind:'confession', anonymous:true, tag:'Your college' },
  { id:'p3', author:'Anonymous', handle:'', initials:'', college:'Your college', time:'a month ago', body:'Some people make college feel like a movie. Some people make attendance feel like a full-time job 😭', likes:18, comments:6, reposts:2, kind:'confession', anonymous:true, tag:'Your college' },
  { id:'p4', author:'Aarav Kulkarni', handle:'@aaravk', initials:'AK', college:'SPPU', time:'2 hours ago', body:'Our robotics club is looking for people who love building things. Beginners are welcome — details coming tomorrow!', likes:56, comments:12, reposts:4, kind:'post', tag:'SPPU' },
]
const navItems = [
  { label:'Home', icon:Home }, { label:'Discover', icon:Compass }, { label:'Campus Pulse', icon:Sparkles },
  { label:'Communities', icon:Users }, { label:'Events', icon:CalendarDays }, { label:'Leaderboard', icon:Trophy },
  { label:'Opportunities', icon:BriefcaseBusiness }, { label:'Marketplace', icon:CircleDollarSign },
  { label:'Clubs', icon:BookOpen }, { label:'Chats', icon:MessageCircle }, { label:'Notifications', icon:Bell },
  { label:'Bookmarks', icon:Bookmark }, { label:'Search', icon:Search }, { label:'My College', icon:Building2 },
  { label:'Safety Centre', icon:Shield },
]
/** Pages that only make sense for a signed-in member (visitor gate applies). */
const restrictedNav = ['Chats', 'Notifications', 'Bookmarks']
const allNav = [...navItems.map(item => item.label), 'Profile']

/* R3 motion: the nav's ONE gliding hover highlight — a single pill travels to the
   item nearest the cursor (fluid-functionalism discipline: one highlight per list,
   transform-only so it rides the compositor and dies under the UI-1 reduced-motion
   kill-switch). Attached only for fine pointers without reduced motion; everyone
   else keeps the plain per-item :hover rules (which now have a dark-mode value). */
const glideNavRef = (navEl: HTMLElement | null) => {
  if (!navEl) return
  navEl.querySelector('.nav-glide')?.remove()
  if (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    !window.matchMedia('(hover: hover) and (pointer: fine)').matches
  ) return
  navEl.classList.add('glide-on')
  const pill = document.createElement('div')
  pill.className = 'nav-glide'
  pill.setAttribute('aria-hidden', 'true')
  navEl.prepend(pill)
  let shown = false
  const pick = (e: PointerEvent) => {
    const rect = navEl.getBoundingClientRect()
    let best: HTMLElement | null = null
    let bestD = Infinity
    for (const it of navEl.querySelectorAll<HTMLElement>('.nav-item')) {
      const r = it.getBoundingClientRect()
      if (r.width === 0) continue
      const px = Math.max(r.left, Math.min(e.clientX, r.right))
      const py = Math.max(r.top, Math.min(e.clientY, r.bottom))
      const d = (px - e.clientX) ** 2 + (py - e.clientY) ** 2
      if (d < bestD) { bestD = d; best = it }
    }
    if (!best) return
    const r = best.getBoundingClientRect()
    const y = r.top - rect.top
    if (!shown) {
      shown = true
      pill.style.transition = 'none'          // arrive, don't fly across the list
      pill.style.transform = `translateY(${y}px)`
      pill.style.height = `${r.height}px`
      void pill.offsetHeight
      pill.style.transition = ''              // hand back to the stylesheet
      pill.style.opacity = '1'
    } else {
      pill.style.transform = `translateY(${y}px)`
      pill.style.height = `${r.height}px`
    }
  }
  const hide = () => { shown = false; pill.style.opacity = '0' }
  navEl.addEventListener('pointermove', pick)
  navEl.addEventListener('pointerenter', pick)
  navEl.addEventListener('pointerleave', hide)
}


/** System info pages, reachable from the footer. */
const infoNav = ['About', 'Guidelines', 'Privacy', 'Help']

/** The four primary pages reachable by horizontal swipe on mobile. */
const swipePageOrder = ['Home', 'Discover', 'Chats', 'Profile']
const scaffoldNav = allNav.filter(label => !['Home', 'Discover', 'Search', 'Safety Centre', 'Communities', 'Events', 'Marketplace'].includes(label))

/* Regions where a horizontal touch gesture belongs to a local component and
 * must never page-flip the shell. Two kinds live here:
 *   1. always-owned regions (inputs, overlays, sheets…) that must never be
 *      seen by the global pager, and
 *   2. genuine horizontal scroll/tab containers, registered by adding
 *      data-no-page-swipe="true" in the JSX (community tabs, category rows,
 *      the events featured carousel, feed carousels…).
 * The exclusion is resolved ONCE at touchstart from `closest()` — i.e. from
 * the DOM node under the finger when the gesture BEGINS — so pulling the
 * finger out of (or into) a marked region mid-swipe never changes the
 * decision, and a scrollable region at its end boundary keeps the gesture
 * local instead of handing it to the pager. `scrollWidth` checks are not
 * required: registration is explicit and low-frequency (tabs may swap
 * panels without physically scrolling). Nested marked containers resolve
 * to the nearest ancestor, which is always the right owner. */
const swipeOwnedSelector =
  'input, textarea, select, .overlay, .bottom-sheet, .post-menu, .reel-more-pop, ' +
  '.carousel-track, .carousel-dots, .picker-thumb, .mobile-bottom-nav, ' +
  '[data-no-page-swipe]'

const localSwipeOwner = (target: EventTarget | null): Element | null => {
  const element = target as Element | null
  return element?.closest?.(swipeOwnedSelector) ?? null
}

/**
 * CAMPUS root. Routing between the four account states lives here:
 * boot splash → welcome (first-time visitor) → onboarding wizard → app shell.
 * Every restricted action goes through `requireAuth`, which opens the sign-up
 * prompt for visitors instead of failing silently.
 */
export default function App() {
  return (
    <AuthProvider>
      <CAMPUSApp />
    </AuthProvider>
  )
}

/** The shared deep link this session already handled (survives StrictMode's
 *  dev remount so the same id is never fetched twice). */
let handledDeepLinkId: string | null = null
/** module guard: a community #c/<slug> link is resolved once per session */
let handledCommunitySlug: string | null = null
let handledEventSlug: string | null = null
let handledListingSlug: string | null = null
let handledChatId: string | null = null
let handledUsername: string | null = null

/** Pages already reachable from the persistent mobile chrome (bottom nav +
 * header icons), so they are dropped from the mobile drawer to avoid duplicates. */
const navOnMainUi = ['Home', 'Discover', 'Chats', 'Notifications', 'Search']

function CAMPUSApp() {
  const auth = useAuth()
  const { user, profile, status, configured, colleges, requireAuth, notify, gateInfo, closeGate, profileError, reloadProfile, caps, patchProfile } = auth

  const [activeNav, setActiveNav] = useState('Home')

  /* ---- history-aware view (see src/lib/navHistory.ts) --------------------- */
  /** a direct/group conversation occupies the mobile thread screen */
  const [dmThread, setDmThread] = useState<{ id: string; seq: number } | null>(null)
  /** stable reporter: a fresh identity for it would re-trigger the Chats
      reporting effect every render (Maximum-update-depth loop) */
  const handleMobileThreadChange = useCallback((threadId: string | null) => {
    setDmThread(prev => {
      // bail when unchanged — new objects here would restart the reporting
      // effect in Chats (which depends on this callback's identity) and loop
      const prevId = prev?.id ?? null
      if (prevId === threadId) return prev
      return threadId ? { id: threadId, seq: Date.now() } : null
    })
  }, [])
  /** current community detail tab, tracked so device Back walks tab history */
  const [communityTab, setCommunityTab] = useState<string | null>(null)
  const dmThreadRef = useRef<{ id: string; seq: number } | null>(null)
  dmThreadRef.current = dmThread
  /** bumped when a popped history entry says the inbox has no thread open */
  const [threadCloseSeq, setThreadCloseSeq] = useState(0)
  const communityTabRef = useRef<string | null>(null)
  communityTabRef.current = communityTab

  const isMobileViewport = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 650px)').matches

  /* ---- boot experience --------------------------------------------------- */
  // The loader lives only on the real boot path (session + profile restore).
  // When the app becomes ready, a fixed veil keeps the loader on screen for a
  // moment while it fades out — the destination is already rendered beneath
  // it, so no blank frame ever appears.
  const [bootVeilOn, setBootVeilOn] = useState(false)
  const [bootSlow, setBootSlow] = useState(false)
  useEffect(() => {
    if (auth.booting) return
    setBootVeilOn(true)
    const timer = window.setTimeout(() => setBootVeilOn(false), 600)
    return () => window.clearTimeout(timer)
  }, [auth.booting])
  // Watchdog: if initialization is still pending after 14s, say so honestly
  // instead of letting the mark breathe silently forever (errors surface
  // through the dedicated profile-error surface).
  useEffect(() => {
    if (!auth.booting) return
    const timer = window.setTimeout(() => setBootSlow(true), 14000)
    return () => window.clearTimeout(timer)
  }, [auth.booting])
  const bootVeil = bootVeilOn
    ? <div className="boot-veil" aria-hidden="true"><BootScreen quiescent /></div>
    : null

  const [feedTab, setFeedTab] = useState('For You')
  const [posts, setPosts] = useState(seedPosts)
  /** 'db' = the displayed feed is the live database feed; 'local' = sample fallback */
  const [feedSource, setFeedSource] = useState<'db' | 'local'>('local')
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [composer, setComposer] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishProgress, setPublishProgress] = useState<string | null>(null)
  const [draftImages, setDraftImages] = useState<File[]>([])
  const [draftVideo, setDraftVideo] = useState<File | null>(null)
  const [reelDuration, setReelDuration] = useState(0)
  const [videoTrim, setVideoTrim] = useState<{ start: number; end: number } | null>(null)
  const [trimOpen, setTrimOpen] = useState(false)
  const [editingPost, setEditingPost] = useState<CampusPost | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CampusPost | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [commentTarget, setCommentTarget] = useState<CampusPost | null>(null)
  const [inlineOpen, setInlineOpen] = useState(false)
  const [inlineDraft, setInlineDraft] = useState('')
  const [inlineBusy, setInlineBusy] = useState(false)

  /* ---- publish reliability (offline, stalls, retries — exactly-once) ------ */
  /* honest network signal: Post buttons respect it, transitions announce it */
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false)
  /* one publish at a time across the inline composer, the sheet and polls */
  const publishActiveRef = useRef(false)
  /* per-draft pending post id (exactly-once key) + uploaded media reuse */
  const composerPendingIdRef = useRef<string | null>(null)
  const inlinePendingIdRef = useRef<string | null>(null)
  /* in-flight markers: true from Publish press until the attempt is known to
     have finished; drives the "finish posting after the app was killed" boot
     resume. Never set on the poll path (no client key there). */
  const composerFlightRef = useRef(false)
  const inlineFlightRef = useRef(false)
  const [resumeTarget, setResumeTarget] = useState<'composer' | 'inline' | null>(null)
  const [draftMediaUrls, setDraftMediaUrls] = useState<string[] | null>(null)
  const DRAFT_STORE_KEY = 'campus.composer.draft.v1'
  const INLINE_STORE_KEY = 'campus.inline.draft.v1'
  /* watchdogs: local processing is never raced (it is CPU-bound), only the
     network legs are — if they stall past the limit the user regains the
     button while the attempt keeps running and stays exactly-once */
  const UPLOAD_STALL_MS = 90_000
  const PUBLISH_STALL_MS = 45_000

  // Stable, revoked-on-change object URLs for the carousel previews.
  const imageThumbs = useMemo(
    () => draftImages.map(file => ({ file, url: URL.createObjectURL(file) })),
    [draftImages],
  )
  useEffect(() => () => { imageThumbs.forEach(thumb => URL.revokeObjectURL(thumb.url)) }, [imageThumbs])
  const [composerKind, setComposerKind] = useState<PostKind>('post')
  const [draft, setDraft] = useState('')
  /* poll composer fields (migration 0028) — sane defaults: single choice,
     7-day duration, two option inputs ready to fill */
  const [pollOptions, setPollOptions] = useState<string[]>(['', ''])
  const [pollMultiple, setPollMultiple] = useState(false)
  const [pollDays, setPollDays] = useState(7)
  const [pollErrors, setPollErrors] = useState<string[]>([])
  /* authoritative poll state per post id — only entries fetched from
     poll_states()/cast_poll_vote() live here, nothing is faked client-side
     (null = authoritative lookup failed; undefined = not yet fetched) */
  const [pollStateMap, setPollStateMap] = useState<Record<string, PollState | null>>({})
  /* dedicated Confessions page (opened from the pink Home card) */
  const [confessionsOpen, setConfessionsOpen] = useState(() =>
    typeof window === 'undefined' ? false : window.location.hash === '#confessions')
  const [confRefreshSeq, setConfRefreshSeq] = useState(0)
  /** where the composer was opened from: publish-to-Home or publish-to-Confessions */
  const [composerSource, setComposerSource] = useState<'home' | 'confessions'>('home')
  /** live like/comment patches app-wide, replayed inside the Confessions page */
  const [confessPatch, setConfessPatch] = useState<{ id: string; likes?: number; liked?: boolean; comments?: number } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchSeed, setSearchSeed] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [openChatId, setOpenChatId] = useState<string | null>(null)
  const [chatAutoSeq, setChatAutoSeq] = useState(0)
  /** auto-open request for the Chats page ({ seq } so Back/Forward re-fire);
      memoised — a fresh object every render would re-trigger the Chats opener */
  const chatAutoOpen = useMemo(
    () => (openChatId ? { id: openChatId, seq: chatAutoSeq } : null),
    [openChatId, chatAutoSeq],
  )
  const [openCommunityId, setOpenCommunityId] = useState<string | null>(null)
  const [openEventSlug, setOpenEventSlug] = useState<string | null>(null)
  const [openListingSlug, setOpenListingSlug] = useState<string | null>(null)
  const [chatDraft, setChatDraft] = useState<string | null>(null)
  const [clubs, setClubs] = useState<db.Club[]>([])
  const openCommunityIdRef = useRef<string | null>(null)
  openCommunityIdRef.current = openCommunityId
  const [viewingProfileId, setViewingProfileId] = useState<string | null>(null)
  const [following, setFollowing] = useState<string[]>([])
  const [blockedHandles, setBlockedHandles] = useState<string[]>([])
  const [mutedHandles, setMutedHandles] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [authMode, setAuthMode] = useState<AuthMode | null>(null)
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null)
  const [pendingNav, setPendingNav] = useState<string | null>(null)
  const imagesInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const [explored, setExplored] = useState(() => hasSeenWelcome())
  const [requestedView, setRequestedView] = useState<string | null>(() => {
    const view = new URLSearchParams(window.location.search).get('view')
    return view && allNav.includes(view) ? view : null
  })
  const noticeTimer = useRef<number | null>(null)

  /* ---- history-integrated view (see src/lib/navHistory.ts) ---------------- */
  const currentView = useMemo<navHistory.CampusView>(() => {
    const view: navHistory.CampusView = { nav: activeNav }
    if (openCommunityId) view.community = openCommunityId
    if (communityTab) view.ctab = communityTab
    if (openEventSlug) view.event = openEventSlug
    if (openListingSlug) view.listing = openListingSlug
    if (confessionsOpen && activeNav === 'Home') view.conf = true
    if (dmThread && isMobileViewport()) view.dm = { id: dmThread.id }
    return view
  }, [activeNav, openCommunityId, communityTab, openEventSlug, openListingSlug, dmThread, confessionsOpen])
  const currentViewJson = JSON.stringify(currentView)

  /** skip the pusher exactly once after a popstate restore applied a view */
  const skipNextPush = useRef(false)
  /** keep the last pushed/restored JSON so duplicate snapshots never re-push */
  const lastPushedJson = useRef<string | null>(null)
  /** first-shell-mount stamp of the boot entry (Deep-link handlers need it) */
  const historyReady = useRef(false)

  /** restore a popped history snapshot into shell state (no pushing here) */
  const applyPoppedView = (view: navHistory.CampusView) => {
    skipNextPush.current = true
    const json = JSON.stringify(view)
    lastPushedJson.current = json
    if (view.nav !== activeNavRef.current) {
      setSearchOpen(false)
      setSearchSeed('')
      setActiveNav(view.nav)
      if (view.nav !== 'Communities') setOpenCommunityId(null)
      if (view.nav !== 'Events') setOpenEventSlug(null)
      if (view.nav !== 'Marketplace') setOpenListingSlug(null)
    }
    setOpenCommunityId(view.community ?? null)
    setCommunityTab(view.ctab ?? null)
    setOpenEventSlug(view.event ?? null)
    setOpenListingSlug(view.listing ?? null)
    // the Confessions page is a Home subview: leaving Home closes it, and a
    // snapshot taken while it was open restores it (device Back-friendly)
    if (view.nav !== 'Home') setConfessionsOpen(false)
    else setConfessionsOpen(Boolean(view.conf))
    const wantDmId = view.dm?.id ?? null
    const hadOpen = activeNavRef.current === 'Chats' && !!dmThreadRef.current
    if (view.nav === 'Chats' && wantDmId && dmThreadRef.current?.id !== wantDmId) {
      // Forward restore (or jump): reopen the conversation
      setOpenChatId(wantDmId)
      setChatAutoSeq(n => n + 1)
    } else if (!wantDmId && hadOpen) {
      // Back into the inbox: close the thread + Chats overlays
      setOpenChatId(null)
      setThreadCloseSeq(n => n + 1)
    }
  }

  /* Install the single popstate handler once the signed-in/visitor shell renders.
     The boot entry is stamped on the FIRST activation and is left untouched on
     re-activation (the shell only mounts once per page load). */
  useEffect(() => {
    if (historyReady.current || status !== 'member' || auth.booting) return
    historyReady.current = true
    navHistory.initNavHistory(currentView, {
      onView: applyPoppedView,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, auth.booting])

  /* Push one history entry whenever the shell's view snapshot changes for a
     reason OTHER than landing here through Back/Forward. A change that only
     touches the community tab (same screen otherwise) is REPLACED in place —
     tabs are one screen, and Back must never ping-pong between them. */
  useEffect(() => {
    if (!historyReady.current) return
    if (skipNextPush.current) {
      skipNextPush.current = false
      lastPushedJson.current = currentViewJson
      navHistory.tracePushedView(currentView)
      return
    }
    if (lastPushedJson.current === currentViewJson) return
    lastPushedJson.current = currentViewJson
    const previousView = navHistory.currentPushedView()
    if (previousView && navHistory.viewCoreKey(previousView) === navHistory.viewCoreKey(currentView)) {
      navHistory.replaceView(currentView)
    } else {
      navHistory.pushView(currentView)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentViewJson])

  /* Overlay (modal/sheet/drawer) entries: opening pushes one history step so
     device Back closes the overlay first, whatever page it belongs to. */
  useOverlayBackGuard(composer, () => setComposer(false))
  useOverlayBackGuard(!!editingPost, () => setEditingPost(null))
  useOverlayBackGuard(!!deleteTarget, () => setDeleteTarget(null))
  useOverlayBackGuard(!!commentTarget, () => setCommentTarget(null))
  useOverlayBackGuard(!!reportTarget, () => setReportTarget(null))
  useOverlayBackGuard(trimOpen, () => setTrimOpen(false))
  useOverlayBackGuard(searchOpen, () => { setSearchOpen(false); setSearchSeed('') })
  useOverlayBackGuard(!!authMode, () => setAuthMode(null))
  useOverlayBackGuard(mobileMenu, () => setMobileMenu(false))

  const flash = (message: string) => {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3200)
  }

  /* ---- publish reliability: connectivity, drafts, exactly-once keys ------- */

  /* Announce real connectivity flips; the flag also drives the fast-fail on
     the compose buttons below (no blind request into a dead radio). */
  useEffect(() => {
    const onOnline = () => { setIsOnline(true); flash('Back online — you can post again.') }
    const onOffline = () => { setIsOnline(false); flash('You are offline — composing still works; sending waits until you reconnect.') }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* Restore persisted drafts once at boot — this effect MUST be declared
     before the persistence writers below so the first (empty-state) pass of
     those writers cannot wipe the store before it is read. The IndexedDB
     copy is authoritative (it carries the media File objects); localStorage
     is the fallback mirror when IDB is unavailable. An inFlight entry means
     a publish attempt was running (or mid-stall) when the app last closed —
     resuming it is exactly-once safe thanks to the client-generated PK. */
  const draftsRestoredRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    const apply = (saved: Partial<ComposerDraftMeta>, files: File[] | null, video: File | null) => {
      if (!( (saved.body?.trim() ?? false) || (saved.media?.length ?? 0) > 0 || (files?.length ?? 0) > 0 )) return false
      setDraft(saved.body ?? '')
      if (saved.kind) setComposerKind(saved.kind)
      if (saved.source) setComposerSource(saved.source)
      composerPendingIdRef.current = saved.pendingId ?? null
      setDraftMediaUrls(saved.media ?? null)
      if (saved.videoTrim && typeof saved.videoTrim.start === 'number' && typeof saved.videoTrim.end === 'number') {
        setVideoTrim(saved.videoTrim)
      }
      if (typeof saved.reelDuration === 'number' && saved.reelDuration > 0) setReelDuration(saved.reelDuration)
      setDraftImages(files?.length ? files : [])
      setDraftVideo(video ?? null)
      if (saved.inFlight) setResumeTarget('composer')
      return true
    }
    void (async () => {
      try {
        let applied = false
        const savedIdb = await loadComposerDraft()
        if (!cancelled && savedIdb) {
          applied = apply(savedIdb, savedIdb.files ?? [], savedIdb.video ?? null)
        }
        if (!applied && !cancelled) {
          const raw = window.localStorage.getItem(DRAFT_STORE_KEY)
          if (raw) {
            const saved = JSON.parse(raw) as Partial<ComposerDraftMeta>
            applied = apply(saved, null, null)
          }
        }
        // inline drafts are text-only — localStorage remains their store
        if (!cancelled) {
          const rawInline = window.localStorage.getItem(INLINE_STORE_KEY)
          if (rawInline) {
            const savedInline = JSON.parse(rawInline) as { body?: string; pendingId?: string | null; inFlight?: boolean }
            if (typeof savedInline.body === 'string' && savedInline.body.trim()) {
              setInlineDraft(savedInline.body)
              inlinePendingIdRef.current = savedInline.pendingId ?? null
              if (savedInline.inFlight) setResumeTarget(current => current ?? 'inline')
            }
          }
        }
      } catch { /* malformed store — ignore, memory drafts already loaded */ }
      if (!cancelled) draftsRestoredRef.current = true
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* The draft (body, target kind/feed, media FILES, uploaded URLs, trim
     state, exactly-once key) survives reloads, crashes and kills: an outage
     mid-upload resumes instead of restarting from zero, and attached media
     re-attach themselves. The in-flight marker rides along — the publishing
     flag in the deps is what commits those transitions to disk. */
  useEffect(() => {
    if (!draftsRestoredRef.current) return // boot pass — restore effect reads first
    try {
      const hasContent = Boolean(draft.trim()) || draftImages.length > 0 || draftVideo !== null || (draftMediaUrls?.length ?? 0) > 0
      if (!hasContent) {
        composerPendingIdRef.current = null
        composerFlightRef.current = false
        window.localStorage.removeItem(DRAFT_STORE_KEY)
        void clearComposerDraft()
        return
      }
      const meta: ComposerDraftMeta = {
        body: draft,
        kind: composerKind,
        source: composerSource,
        media: draftMediaUrls,
        videoTrim,
        reelDuration,
        pendingId: composerPendingIdRef.current,
        inFlight: composerFlightRef.current,
      }
      window.localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify(meta))
      void saveComposerDraft(meta, draftImages, draftVideo)
    } catch { /* private mode / full storage — drafts stay memory-only */ }
  }, [draft, draftImages, draftVideo, videoTrim, reelDuration, draftMediaUrls, composerKind, composerSource, publishing])

  useEffect(() => {
    if (!draftsRestoredRef.current) return
    try {
      if (!inlineDraft.trim()) {
        inlinePendingIdRef.current = null
        inlineFlightRef.current = false
        window.localStorage.removeItem(INLINE_STORE_KEY)
        return
      }
      const meta = { body: inlineDraft, pendingId: inlinePendingIdRef.current, inFlight: inlineFlightRef.current }
      window.localStorage.setItem(INLINE_STORE_KEY, JSON.stringify(meta))
    } catch { /* same as above */ }
    // inlineBusy is a dep: the in-flight marker is written when publishes
    // start/stop even though no draft state changed
  }, [inlineDraft, inlineBusy])

  /* Resolve a network promise against a stall watchdog. `done:false` means
     "still running" — never a failed request, so the user can also just
     close the app: the exactly-once key makes any later retry safe. */
  const raceStall = <T,>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> =>
    Promise.race([
      promise.then(value => ({ done: true as const, value })),
      new Promise<{ done: false }>(resolve => { window.setTimeout(() => resolve({ done: false }), ms) }),
    ])

  /* one gate used by all three publishers: refuses to fire a request into a
     dead connection and serialises publishes instead of racing them */
  const assertCanPublish = (): boolean => {
    if (!isOnline) {
      flash('You are offline — your draft is kept. Reconnect and press Post again.')
      return false
    }
    if (publishActiveRef.current) {
      flash('Hang on — your previous post is still sending.')
      return false
    }
    publishActiveRef.current = true
    return true
  }
  const releasePublish = () => { publishActiveRef.current = false }

  /* ---- signed-in member context ---------------------------------------- */

  const identity = useMemo(() => {
    const name = profile?.display_name?.trim() || user?.email?.split('@')[0] || 'CAMPUS member'
    const username = profile?.username || (user?.email ? user.email.split('@')[0] : '')
    const initials = name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase() || 'CM'
    // Staff (admin / super_admin) are platform-level: no college fallback,
    // no fake affiliation chip anywhere they appear.
    const staff = profile?.role === 'admin' || profile?.role === 'super_admin'
    const college = colleges.find(item => item.id === profile?.college_id)?.short_name
      ?? (staff ? '' : (colleges[0]?.short_name ?? 'SPPU'))
    return { name, username, initials, college, handle: username ? `@${username}` : '@campus' }
  }, [profile, user, colleges])

  const activeCollege = useMemo(
    () => {
      const staff = profile?.role === 'admin' || profile?.role === 'super_admin'
      return colleges.find(item => item.id === profile?.college_id)
        ?? (staff ? null : (colleges[0] ?? null))
    },
    [colleges, profile?.college_id, profile?.role],
  )

  /** 0043: staff = admin or super_admin — the platform identity tiers. */
  const isStaff = profile?.role === 'admin' || profile?.role === 'super_admin'

  /* Apply saved blocks/mutes to the local feed for a signed-in member. */
  useEffect(() => {
    if (status !== 'member' || !user) return
    let cancelled = false
    void Promise.all([
      db.loadUserRelation('user_blocks', user.id),
      db.loadUserRelation('user_mutes', user.id),
    ]).then(([blocks, mutes]) => {
      if (cancelled) return
      setBlockedHandles(blocks.map(row => row.username).filter((value): value is string => Boolean(value)))
      setMutedHandles(mutes.map(row => row.username).filter((value): value is string => Boolean(value)))
    })
    return () => { cancelled = true }
  }, [status, user])

  // Clubs for search results (and later the Clubs page).
  useEffect(() => {
    let cancelled = false
    void db.loadClubs()
      .then(rows => { if (!cancelled && rows.length) setClubs(rows) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Deep link protection: a signed-out visitor opening ?view=Chats sees the
  // sign-up prompt and lands on that page after authenticating.
  useEffect(() => {
    if (auth.status === 'loading' || !requestedView) return
    setActiveNav(requestedView)
    if (restrictedNav.includes(requestedView)) {
      setPendingNav(requestedView)
      requireAuth(`open ${requestedView === 'Chats' ? 'chats' : requestedView === 'Notifications' ? 'your notifications' : 'your bookmarks'}`, requestedView)
    }
    setRequestedView(null)
  }, [auth.status, requestedView, requireAuth])

  useEffect(() => {
    if (status === 'member' && pendingNav) {
      setActiveNav(pendingNav)
      setPendingNav(null)
    }
  }, [status, pendingNav])

  // 0043: platform staff land in their back-office, not the social feed. The
  // feed stays one tap away for @campus announcements. Fires once at boot.
  const didStaffLandingRef = useRef(false)
  useEffect(() => {
    if (didStaffLandingRef.current) return
    if (status !== 'member' || pendingNav) return
    if (profile?.role !== 'admin' && profile?.role !== 'super_admin') return
    didStaffLandingRef.current = true
    setActiveNav('Staff Console')
  }, [status, pendingNav, profile?.role])

  /* ---- feed ------------------------------------------------------------ */

  // Load the live feed through list_public_posts (migration 0002). Visitors and
  // members both get the real feed; when the RPC is missing the sample posts
  // stay on screen behind an honest notice.
  const loadFeed = useCallback(async () => {
    if (!configured) return
    setFeedLoading(true)
    try {
      const rows = await db.fetchFeed(50)
      setFeedSource('db')
      setFeedError(null)
      // The database is the truth — an empty feed shows the empty state, not
      // the sample posts, so a live-but-empty campus is never misrepresented.
      setPosts(rows)
      // refresh the authoritative poll snapshots for this page in one call;
      // ids the RPC does not answer for (e.g. un-created poll meta) resolve
      // to `null` so a card degrades honestly instead of spinning forever
      const map = await db.pollStatesFor(rows)
      const pollIds = rows.filter(p => p.kind === 'poll').map(p => p.id)
      const hydrate: Record<string, PollState | null> = {}
      for (const id of pollIds) hydrate[id] = map[id] ?? null
      if (Object.keys(hydrate).length) {
        setPollStateMap(current => ({ ...current, ...hydrate }))
      }
    } catch (error) {
      setFeedSource('local')
      setFeedError(db.friendlyMessage(error))
    } finally {
      setFeedLoading(false)
    }
  }, [configured])

  useEffect(() => {
    if (status === 'member' || status === 'visitor') void loadFeed()
  }, [status, user?.id, loadFeed])

  /* real notification badge: the bell only lights when unread rows exist.
     Live updates ride a TARGETED Supabase realtime channel on my own rows:
     inserts settle the count via a server re-read (the DB is the source of
     truth — realtime events never mint anything), and the same ritual
     re-syncs other tabs and recovery from reconnects. */
  const [unreadNotifs, setUnreadNotifs] = useState(0)
  const [notifTick, setNotifTick] = useState(0)
  const [bellRefetch, setBellRefetch] = useState(0)
  useEffect(() => {
    if (status !== 'member' || !user?.id || !configured) { setUnreadNotifs(0); return }
    let alive = true
    const load = () => db.fetchUnreadNotificationCount()
      .then(n => { if (alive) setUnreadNotifs(n) })
      .catch(() => { /* badge stays at its last honest value */ })
    load()
    const timer = window.setInterval(load, 30000)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    const unsubscribe = db.subscribeNotifications(user.id, () => {
      setNotifTick(tick => tick + 1)
      // small settle delay keeps the re-read consistent with the write
      window.setTimeout(load, 400)
    })
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      unsubscribe()
    }
  }, [status, user?.id, configured])
  // explicit re-reads from the notification center (mark read / mark all)
  useEffect(() => {
    if (bellRefetch === 0) return
    if (status !== 'member' || !user?.id || !configured) return
    void db.fetchUnreadNotificationCount()
      .then(n => setUnreadNotifs(n))
      .catch(() => { /* keep the last honest value */ })
  }, [bellRefetch, status, user?.id, configured])

  /* web-push plumbing: register the service worker once (secure contexts
     only); permission is NEVER requested here — the center offers it. */
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in window.navigator)) return
    const secure = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    if (!secure) return
    void window.navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
  }, [])

  /* self-healing push: browsers rotate/drop web-push subscriptions while
     the app is closed, which silently orphans the server-side device row.
     Repair it on every signed-in start (no prompt, idempotent, and only
     for devices the user explicitly enabled). */
  useEffect(() => {
    if (status !== 'member' || !user?.id) return
    void reconcilePush().catch(() => { /* best-effort only */ })
  }, [status, user?.id])

  /* push clicks navigate the app: the SW posts the deep link, we route it
     through the same hash handler every other entry point uses */
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in window.navigator)) return
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null
      // SW noticed a subscription rotation — re-sync the server side
      if (data?.type === 'CAMPUS_RESUBSCRIBE') {
        void reconcilePush().catch(() => {})
        return
      }
      if (data?.type !== 'CAMPUS_NAVIGATE' || typeof data.url !== 'string') return
      const hashIndex = data.url.indexOf('#')
      if (hashIndex < 0) return
      window.location.hash = data.url.slice(hashIndex)
    }
    window.navigator.serviceWorker.addEventListener('message', handler)
    return () => window.navigator.serviceWorker.removeEventListener('message', handler)
  }, [])


  /* ---- real right-panel data -------------------------------------------- */

  const [trends, setTrends] = useState<[string, number][]>([])
  const [trendsPending, setTrendsPending] = useState(true)
  const [followPicks, setFollowPicks] = useState<db.FollowSuggestion[]>([])
  const [followPicksPending, setFollowPicksPending] = useState(true)
  const [showAllTrends, setShowAllTrends] = useState(false)

  useEffect(() => {
    if (!configured) return
    let cancelled = false
    setTrendsPending(true)
    db.fetchTrendingTags(8)
      .then(rows => { if (!cancelled) setTrends(rows) })
      .catch(() => { /* honest empty panel — no fake trends ever rendered */ })
      .finally(() => { if (!cancelled) setTrendsPending(false) })
    return () => { cancelled = true }
  }, [configured])

  useEffect(() => {
    if (!configured || status !== 'member' || !user) return
    let cancelled = false
    setFollowPicksPending(true)
    db.fetchFollowSuggestions(user.id, profile?.college_id ?? null, 3)
      .then(rows => { if (!cancelled) setFollowPicks(rows) })
      .catch(() => { /* honest empty panel */ })
      .finally(() => { if (!cancelled) setFollowPicksPending(false) })
    return () => { cancelled = true }
  }, [configured, status, user?.id, profile?.college_id])

  // The follow-mirror boots from the REAL follows table (one batched read) so
  // Home's Following tab and My College's students start in the true state —
  // session-only flips then ride on top through toggleFollow/toggleFollowFor.
  useEffect(() => {
    if (!configured || status !== 'member' || !user) return
    let cancelled = false
    db.fetchFollowingHandles(user.id)
      .then(handles => {
        if (!cancelled) {
          setFollowing(current => {
            const merged = new Set(current)
            for (const handle of handles) merged.add(handle)
            return [...merged]
          })
        }
      })
      .catch(() => { /* honest empty mirror — no fabricated follows */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- merge keeps any flip made while this was in flight
    return () => { cancelled = true }
  }, [configured, status, user?.id])

  const visiblePosts = useMemo(() => {
    let result = [...posts]
    if (feedTab === 'For You') {
      // Instagram-style: connection first, then recency, engagement and college
      const followSet = new Set(following)
      const scored = result.map(post => ({
        post,
        score: db.forYouScore(
          post,
          followSet.has(post.handle),
          Boolean(identity.college) && post.college === identity.college,
        ),
      }))
      scored.sort((a, b) => b.score - a.score)
      result = scored.map(entry => entry.post)
    }
    if (feedTab === 'Trending') {
      result = result.sort((a, b) => {
        const score = (p: CampusPost) => p.likes * 2 + p.comments + p.reposts
        return score(b) - score(a)
      })
    }
    if (feedTab === 'Following') result = result.filter(p => following.includes(p.handle) || p.author === 'Campus Bot')
    if (feedTab === 'My College') result = result.filter(p => p.college === identity.college || p.college === 'Your college')
    if (feedTab === 'Latest') result = result.reverse()
    if (blockedHandles.length || mutedHandles.length) {
      const hidden = new Set([...blockedHandles, ...mutedHandles])
      result = result.filter(p => !hidden.has(p.handle))
    }
    return result
  }, [posts, feedTab, following, blockedHandles, mutedHandles, identity.college])

  /* ---- first-party sponsored placements ---------------------------------- */
  /* Admin-managed ads. The SERVER decides who sees an ad (college targeting,
   * schedule, creative, frequency) — the client just renders what it gets,
   * once per session. A student of a non-targeted college gets an empty
   * payload and sees no card at all; nothing presumes global reach. */
  const [sponsoredAds, setSponsoredAds] = useState<SponsoredAd[]>([])
  const [hiddenAdIds, setHiddenAdIds] = useState<string[]>([])
  const hiddenAdRef = useRef<string[]>([])
  useEffect(() => { hiddenAdRef.current = hiddenAdIds }, [hiddenAdIds])
  const sponsoredLoadedRef = useRef(false)
  useEffect(() => {
    if (!configured || status !== 'member' || sponsoredLoadedRef.current) return
    sponsoredLoadedRef.current = true
    ads.fetchSponsoredAds(2)
      .then(loaded => setSponsoredAds(loaded.filter(ad => !hiddenAdRef.current.includes(ad.id))))
      .catch(() => { /* no ads is a fine feed — never disturb it */ })
  }, [configured, status])

  /** Hidden ads stay hidden for this session (the server keeps frequency caps). */
  const hideAd = (id: string) => setHiddenAdIds(prev => prev.includes(id) ? prev : [...prev, id])

  /** Feed list with sponsored cards interleaved: first slot after post 2,
   *  then every 8th post, capped by the (already server-capped) payload. */
  const feedItems = useMemo(() => {
    const items: Array<{ kind: 'post'; post: CampusPost } | { kind: 'sponsored'; ad: SponsoredAd }> =
      visiblePosts.map(post => ({ kind: 'post' as const, post }))
    const eligibleAds = sponsoredAds.filter(ad => !hiddenAdIds.includes(ad.id))
    if (!eligibleAds.length) return items
    const out: typeof items = [...items]
    let adIdx = 0
    for (let i = 1; i < out.length && adIdx < eligibleAds.length; i += 8) {
      out.splice(i === 1 ? 2 : i, 0, { kind: 'sponsored' as const, ad: eligibleAds[adIdx++] })
    }
    return out
  }, [visiblePosts, sponsoredAds, hiddenAdIds])

  /* ---- gated actions (visitors get the sign-up prompt) ----------------- */

  /** like/unlike; `item` lets feeds outside `posts` (the Confessions page
   *  keeps its own list) take part — outcomes replay to them via confessPatch.
   *  Resolves true only when the write landed, so callers with local mirrors
   *  (My College's offset pages) can roll back honestly. */
  const toggleLike = async (id: string, item?: CampusPost): Promise<boolean> => {
    if (!requireAuth('react to posts')) return false
    // Optimistic flip, then a real write. Any failure is rolled back and
    // reported — the count on screen always matches the database.
    const target = posts.find(p => p.id === id) ?? item
    if (!target) return false
    const nextLiked = !target.liked
    setPosts(current => current.map(p => p.id === id ? { ...p, liked: !p.liked, likes: p.likes + (p.liked ? -1 : 1) } : p))
    setConfessPatch({ id, liked: nextLiked, likes: target.likes + (target.liked ? -1 : 1) })
    if (feedSource === 'db' && user) {
      try {
        await db.toggleLike(id, user.id, nextLiked)
      } catch (error) {
        setPosts(current => current.map(p => p.id === id ? { ...p, liked: target.liked, likes: target.likes } : p))
        setConfessPatch({ id, liked: target.liked, likes: target.likes })
        notify(db.friendlyMessage(error))
        return false
      }
    }
    return true
  }
  const toggleSave = (id: string, item?: CampusPost) => {
    if (!requireAuth('bookmark posts')) return
    // `item` covers posts living outside `posts` (My College's offset pages);
    // their kind is authoritative from the record itself
    const post = posts.find(p => p.id === id) ?? item
    const kind = post?.kind === 'reel' ? 'reel' : 'post'
    // persisted through the shared saved store: optimistic flip everywhere
    // at once, honest rollback + error toast when the write fails
    bk.toggleSaved(kind, id).catch(error => notify(db.friendlyMessage(error)))
  }
  // the saved-state mirror is per-account: reset it the moment the identity
  // changes (login, logout, account switch) so no saved flags ever leak
  useEffect(() => {
    bk.savedStoreBindUser(user?.id ?? null)
  }, [user?.id])
  // hydrate the mirror with real rows for the posts currently loaded
  useEffect(() => {
    if (!user || feedSource !== 'db' || posts.length === 0) return
    // cosmetic hydration: a failure here leaves flags unsaved (never wrong-
    // saved); the toggle itself still fails loudly if the write cannot happen
    void bk.syncPostSaves(posts).catch(() => undefined)
  }, [posts, user, feedSource])
  const toggleRepost = (id: string, item?: CampusPost) => {
    if (!requireAuth('repost to your campus')) return
    const target = posts.find(p => p.id === id) ?? item
    if (!target) return
    setPosts(current => current.map(p => p.id === id ? { ...p, reposted: !p.reposted, reposts: p.reposts + (p.reposted ? -1 : 1) } : p))
    setConfessPatch({ id })
  }
  const openComments = (post: CampusPost) => {
    if (!requireAuth('join the conversation')) return
    setCommentTarget(post)
  }
  const copyPost = (body: string) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(body).then(() => flash('Post text copied to clipboard.')).catch(() => flash('Could not copy to clipboard.'))
    } else {
      flash('Clipboard is not available in this browser.')
    }
  }
  /** Share button: opens the CAMPUS share sheet — the chat receives a card
   *  referencing the ORIGINAL post (deep link still copyable inside). */
  const sharePost = (post: CampusPost) => {
    if (!requireAuth('share posts')) return
    setOpenShareTarget({
      kind: 'post',
      id: post.id,
      title: post.body.trim().slice(0, 110) || 'Post',
      subtitle: post.anonymous ? 'Anonymous post' : `by ${post.author}`,
      image: post.media?.[0] ?? null,
    })
  }
  /** null = no share sheet open; set = the content card to send into chats */
  const [openShareTarget, setOpenShareTarget] = useState<ShareTarget | null>(null)
  useOverlayBackGuard(!!openShareTarget, () => setOpenShareTarget(null))
  const openShareSheet = (target: ShareTarget) => {
    if (!requireAuth('share content')) return
    setOpenShareTarget(target)
  }
  /** null = no deep-linked reel pending; id = Discover should land on it */
  const [reelAutoOpen, setReelAutoOpen] = useState<string | null>(null)
  // deep links (#p/<id>) from shared posts: reels open in Discover, posts in
  // feed. The hash stays until the post actually lands (boot may re-run this
  // effect). A module flag keeps StrictMode's remount — and repeat
  // hashchange events — from fetching the same id twice. hashchange matters:
  // pasting a link into an already-open tab is a same-document navigation
  // (no reload, only the fragment changes).
  useEffect(() => {
    if (!configured) return
    const handleDeepLink = () => {
      // a hash change is a same-document navigation that creates a fresh
      // history entry with native null state — stamp it as a CAMPUS entry
      // carrying the current view so the in-app chain is never severed
      if (/^#(p|c|e|m|chat|u)\//i.test(window.location.hash)) {
        navHistory.preserveCurrentEntry()
      }
      const match = /#p\/([0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12})$/i.exec(window.location.hash)
      if (match) {
        const id = match[1]
        if (handledDeepLinkId === id) return
        handledDeepLinkId = id
        // a shared link is a destination: first-time visitors land on the content,
        // not on the marketing page (exploring is free and read-only anyway)
        markWelcomeSeen()
        setExplored(true)
        db.fetchPostById(id)
          .then(post => {
            if (!post) { flash('That post is not available — it may have been deleted or is a confession.'); return }
            if (post.kind === 'reel') {
              setActiveNav('Discover')
              setReelAutoOpen(id)
            } else {
              setPosts(current => current.some(p => p.id === id) ? current : [post, ...current])
              setActiveNav('Home')
              // a deep-linked poll still shows real totals on its first paint
              if (post.kind === 'poll') void db.pollStatesFor([post]).then(map => setPollStateMap(cur => ({ ...cur, ...map })))
            }
            // keep the app's own state on this history entry so the chain to
            // the boot screen stays intact for device Back
            navHistory.preserveCurrentEntry()
          })
          .catch(error => flash(db.friendlyMessage(error)))
        return
      }
      // community share links: #c/<slug>
      const communityMatch = /#c\/([a-z0-9-]+)$/i.exec(window.location.hash)
      if (communityMatch) {
        const slug = communityMatch[1].toLowerCase()
        if (handledCommunitySlug !== slug) {
          handledCommunitySlug = slug
          markWelcomeSeen()
          setExplored(true)
          cm.communityIdFromSlug(slug)
            .then(id => {
              if (!id) { flash('That community link is not available — it may be a hidden community or was archived.'); return }
              setActiveNav('Communities')
              setOpenCommunityId(id)
              navHistory.preserveCurrentEntry()
            })
            .catch(error => flash(db.friendlyMessage(error)))
        }
        return
      }
      // event share links: #e/<slug> — the detail page resolves visibility
      // itself and shows an honest "not available" for hidden/draft events
      const eventMatch = /#e\/([a-z0-9-]+)$/i.exec(window.location.hash)
      if (eventMatch) {
        const eventSlug = eventMatch[1].toLowerCase()
        if (handledEventSlug === eventSlug) return
        handledEventSlug = eventSlug
        markWelcomeSeen()
        setExplored(true)
        setActiveNav('Events')
        setOpenEventSlug(eventSlug)
        navHistory.preserveCurrentEntry()
        return
      }
      // listing share links: #m/<slug> — the detail page resolves visibility
      // itself and shows an honest "not available" for hidden/sold/removed listings
      const listingMatch = /#m\/([a-z0-9-]+)$/i.exec(window.location.hash)
      if (listingMatch) {
        const listingSlug = listingMatch[1].toLowerCase()
        if (handledListingSlug === listingSlug) return
        handledListingSlug = listingSlug
        markWelcomeSeen()
        setExplored(true)
        setActiveNav('Marketplace')
        setOpenListingSlug(listingSlug)
        navHistory.preserveCurrentEntry()
      }
      // chat deep links (push + share): #chat/<conversation uuid>. Access
      // itself is enforced by list_chat_messages + member checks, never by
      // the URL — the id in the hash is opaque.
      const chatMatch = /#chat\/([0-9a-f-]{32,36})$/i.exec(window.location.hash)
      if (chatMatch) {
        const conversationId = chatMatch[1]
        if (handledChatId !== conversationId) {
          handledChatId = conversationId
          markWelcomeSeen()
          setExplored(true)
          setOpenChatId(conversationId)
          setChatAutoSeq(n => n + 1)
          setActiveNav('Chats')
          navHistory.preserveCurrentEntry()
        }
        return
      }
      // profile deep links (push): #u/<username> — resolved server-side;
      // private profiles show whatever profile fetch() allows
      const userMatch = /#u\/([a-z0-9_]{2,32})$/i.exec(window.location.hash)
      if (userMatch) {
        const username = userMatch[1].toLowerCase()
        if (handledUsername !== username) {
          handledUsername = username
          markWelcomeSeen()
          setExplored(true)
          void db.getSupabaseClient()
            ?.from('profiles')
            .select('id')
            .ilike('username', username)
            .maybeSingle()
            .then(({ data }: { data: { id: string } | null }) => {
              if (data?.id) {
                setViewingProfileId(data.id)
                setActiveNav('Profile')
                navHistory.preserveCurrentEntry()
              } else {
                flash('That profile link does not exist.')
              }
            })
        }
        return
      }
    }
    handleDeepLink()
    window.addEventListener('hashchange', handleDeepLink)
    return () => window.removeEventListener('hashchange', handleDeepLink)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, status])
  const openReport = (post: CampusPost) => {
    if (!requireAuth('report content')) return
    setReportTarget({
      label: post.anonymous ? 'this confession' : 'this post',
      postId: post.id,
      excerpt: post.body.slice(0, 160),
    })
  }
  // Open (or reuse) a 1:1 chat with a post's author, then land in Chats.
  const messageAuthor = async (post: CampusPost) => {
    if (!requireAuth('message the author')) return
    if (!user) return
    if (!post.handle || post.anonymous || !post.authorId) {
      flash('Confessions are anonymous, so the author has no chat to open.')
      return
    }
    if (post.authorId === user.id) {
      flash('That is your own post — your chats are with classmates.')
      return
    }
    try {
      const conversationId = await db.openDm(post.authorId)
      setOpenChatId(conversationId)
      setChatAutoSeq(n => n + 1)
      navigate('Chats')
    } catch (error) {
      flash(db.friendlyMessage(error))
    }
  }

  // Contact a marketplace seller: open (or reuse) the existing 1:1 chat and
  // prefill a contextual message — it is only sent when the buyer hits send.
  const messageListing = async (sellerId: string, listingTitle: string) => {
    if (!requireAuth('contact the seller')) return
    if (!user) return
    if (sellerId === user.id) {
      flash('That is your own listing — your chats are with classmates.')
      return
    }
    try {
      const conversationId = await db.openDm(sellerId)
      setOpenChatId(conversationId)
      setChatAutoSeq(n => n + 1)
      setChatDraft(`Hi, I'm interested in your listing: ${listingTitle}. Is it still available?`)
      navigate('Chats')
    } catch (error) {
      flash(db.friendlyMessage(error))
    }
  }

  /* ---- rich text jumps: @mention → profile, #hashtag → seeded search ----- */

  const openMentionProfile = async (profileId: string) => {
    if (!profileId) return
    setViewingProfileId(profileId)
    navigate('Profile')
  }

  const openHashtagSearch = (query: string) => {
    setSearchSeed(query.toLowerCase())
    setSearchOpen(true)
  }
  // Open (or reuse) a 1:1 chat with a member found via search, then land in Chats.
  const messagePerson = async (profileId: string) => {
    if (!requireAuth('message a classmate')) return
    if (!user) return
    if (profileId === user.id) {
      flash('That is your own profile — your chats are with classmates.')
      return
    }
    try {
      const conversationId = await db.openDm(profileId)
      setOpenChatId(conversationId)
      setChatAutoSeq(n => n + 1)
      navigate('Chats')
    } catch (error) {
      flash(db.friendlyMessage(error))
    }
  }
  // Follow / unfollow straight through the follows table.
  const toggleFollowFor = async (targetId: string, current: boolean, handle = ''): Promise<boolean> => {
    if (!requireAuth('follow classmates')) return false
    if (!user) return false
    try {
      if (current) await db.unfollowUser(targetId)
      else await db.followUser(user.id, targetId)
      // the session follow-mirror is what feed filters read (Home Following
      // tab, My College students) — keep it in step with the real write
      if (handle) {
        setFollowing(old => current
          ? old.filter(x => x !== handle)
          : old.includes(handle) ? old : [...old, handle])
      }
      return true
    } catch (error) {
      flash(db.friendlyMessage(error))
      return false
    }
  }
  const setRelation = async (table: 'user_blocks' | 'user_mutes', post: CampusPost) => {
    const isBlock = table === 'user_blocks'
    const verb = isBlock ? 'block' : 'mute'
    if (!requireAuth(`${verb} an account`)) return
    if (!user) return
    if (!post.handle || post.anonymous) { notify('Confessions are anonymous, so there is no account to block.'); return }
    const username = post.handle.replace('@', '')
    try {
      const targetId = await db.findProfileIdByUsername(username)
      if (!targetId) { notify(`We could not find @${username} — they may use a private account.`); return }
      await db.setUserRelation(table, user.id, targetId)
      const setter = isBlock ? setBlockedHandles : setMutedHandles
      setter(current => current.includes(username) ? current : [...current, username])
      notify(isBlock ? `Blocked @${username}. Their posts are hidden from your feed.` : `Muted @${username}. You will not see their posts.`)
    } catch (error) {
      notify(db.friendlyMessage(error))
    }
  }

  /** inline validation for the poll composer fields (no alerts — messages
   *  render next to the options) */
  const validatePollDraft = (): string[] => {
    const options = pollOptions.map(value => value.trim()).filter(Boolean)
    const errors: string[] = []
    if (!draft.trim()) errors.push('Write the poll question first.')
    if (options.length < 2) errors.push('A poll needs at least two different options.')
    const seen = new Set<string>()
    for (const option of options) {
      const key = option.toLowerCase()
      if (seen.has(key)) { errors.push('Poll options must be different from each other.'); break }
      seen.add(key)
    }
    return errors
  }

  /**
   * Publish a poll: post + options + settings land in ONE server transaction
   * (create_poll, migration 0028) and the fresh authoritative state hydrates
   * the new card immediately.
   */
  const publishPollDraft = async () => {
    const errors = validatePollDraft()
    if (errors.length) { setPollErrors(errors); return }
    if (!configured || !user) {
      flash('Polls need the campus database — connect CAMPUS to publish a real poll.')
      return
    }
    setPublishing(true)
    try {
      // Admins post platform-wide (no college scope) — see publishPostCore.
      const collegeRow = isStaff
        ? null
        : (colleges.find(c => c.id === profile?.college_id) ?? colleges[0])
      const options = pollOptions.map(value => value.trim()).filter(Boolean)
      /* watchdog: a stalled network must not pin the button forever. Unlike
         plain posts this is NOT retriable-safe from the client — create_poll
         is a single server transaction with no client-generated key, so a
         stalled attempt may still publish later and a manual retry could
         double-post. Honest message, draft kept, no automatic retry. */
      const leg = await raceStall(db.createPoll({
        userId: user.id,
        body: draft.trim(),
        kind: 'poll',
        isAnonymous: false,
        collegeId: profile?.college_id ?? null,
        collegeShort: collegeRow?.short_name ?? '',
        authorName: identity.name,
        authorUsername: identity.username,
        mediaUrls: [],
        options,
        multipleChoice: pollMultiple,
        closeDays: pollDays,
      }), PUBLISH_STALL_MS)
      if (!leg.done) {
        flash('The network is very slow — the poll may still publish in the background. Your draft is safe here.')
        return
      }
      const pollPost = leg.value
      const map = await db.pollStatesFor([pollPost])
      setPollStateMap(current => ({ ...current, ...map }))
      setPosts(current => [pollPost, ...current])
      setDraft(''); setPollOptions(['', '']); setPollMultiple(false); setPollDays(7); setPollErrors([])
      setComposer(false)
      setActiveNav('Home'); setFeedTab('For You')
      setConfessionsOpen(false)
      flash(pollMultiple ? 'Poll posted — classmates can pick several options.' : 'Poll posted to the campus feed.')
    } catch (error) {
      // a failed publish keeps the composer open with the whole draft intact
      flash(db.friendlyMessage(error))
    } finally {
      setPublishing(false)
      setPublishProgress(null)
    }
  }

  const createPost = async () => {
    if (!requireAuth('create posts, polls and confessions')) return
    // polls validate inline through publishPollDraft (question included);
    // media-less drafts aren't real posts either
    if (!draft.trim() && composerKind !== 'poll' && !draftMediaUrls?.length && !draftVideo) { flash('Write something before posting.'); return }
    if (composerKind === 'poll') {
      // single gate + watchdog for the whole publish family
      if (!assertCanPublish()) return
      try {
        await publishPollDraft()
      } finally { releasePublish() }
      return
    }
    if (!assertCanPublish()) return
    // in-flight marker lands in the persisted draft via the publishing dep on
    // the writer effect — kill/resume-from-reload applies to posts, reels and
    // confessions only (polls have no client key)
    composerFlightRef.current = true
    setPublishing(true)
    // becomes true the moment the stall watchdog fires; publishPostCore uses
    // it to keep quiet while a late-landing attempt resolves on its own
    let stalled = false
    try {
      const body = draft.trim()

      // Media reuse across retries: a stalled earlier attempt already uploaded
      // the files and their URLs travel with the persisted draft, so "Post"
      // after a reconnect never re-uploads byte-for-byte identical media.
      // URLs are persisted after EVERY leg, so a kill mid-carousel keeps the
      // progress already made.
      let mediaUrls: string[] | null = draftMediaUrls
      const reuseCount = Array.isArray(mediaUrls) ? mediaUrls.length : 0
      if (composerKind === 'post' && draftImages.length && reuseCount !== draftImages.length) {
        const uploaded: string[] = [...(mediaUrls ?? [])] // resume the partial carousel
        for (let index = 0; index < draftImages.length; index++) {
          if (index < uploaded.length) continue // that stem already has a URL
          const leg = await raceStall(db.uploadMedia(user!.id, draftImages[index]), UPLOAD_STALL_MS)
          if (!leg.done) {
            // clean whatever fully landed before the stall; the permanently
            // stalled upload cannot be identified, so it is left for the
            // retry to supersede rather than guessed away
            void db.removeUploadedFiles(uploaded.slice(reuseCount))
            flash('Your connection stalled while uploading the images. Your draft is kept — press Post again once the network returns (or keep the app open: it keeps trying).')
            return
          }
          uploaded.push(leg.value)
          setPublishProgress(`Uploading image ${uploaded.length} of ${draftImages.length}…`)
          // persist progress NOW — a reload resumes from here, not from zero
          setDraftMediaUrls([...uploaded])
        }
        mediaUrls = uploaded
        setDraftMediaUrls(uploaded)
      }
      if (composerKind === 'reel') {
        if (!draftVideo && reuseCount !== 1) {
          flash('Select a video to post a reel.')
          return
        }
        if (reuseCount !== 1) {
          if (!draftVideo) { flash('Select a video to post a reel.'); return }
          // Videos over 30 s must be trimmed first: the trimmer opens
          // automatically and Publish stays blocked until a window is picked.
          if (reelDuration > REEL_WINDOW_SECONDS + 0.05 && !videoTrim) {
            flash('Trim your reel to 30 seconds first — open the clip timeline and pick a window.')
            setTrimOpen(true)
            return
          }
          const reelFile = draftVideo
          const trimWindow = videoTrim ?? { start: 0, end: Math.min(reelDuration || REEL_WINDOW_SECONDS, REEL_WINDOW_SECONDS) }
          const keepSeconds = Math.min(Math.max(trimWindow.end - trimWindow.start, 0.3), REEL_WINDOW_SECONDS)
          setPublishProgress('Compressing video…')
          const compressed = await media.compressVideo({
            file: reelFile,
            start: trimWindow.start,
            keepSeconds,
            onProgress: progress => {
              if (progress.phase === 'encoding') setPublishProgress(`Compressing ${progress.percent}%…`)
              else setPublishProgress('Uploading video…')
            },
          })
          setPublishProgress('Uploading video…')
          const leg = await raceStall(db.uploadMedia(user!.id, compressed), UPLOAD_STALL_MS)
          if (!leg.done) {
            flash('Your connection stalled while uploading the video. Your draft and trims are kept — press Post again once the network returns (or keep the app open: it keeps trying).')
            return
          }
          mediaUrls = [leg.value]
          setDraftMediaUrls(mediaUrls)
        }
      }

      // exactly-once key: created once per draft, persisted with it, reused
      // by every retry until the post actually lands
      const pendingId = composerPendingIdRef.current ?? db.newPostId()
      composerPendingIdRef.current = pendingId
      const publishPromise = publishPostCore(body, composerKind, mediaUrls, undefined, { postId: pendingId, isStale: () => stalled })
      const leg = await raceStall(publishPromise, PUBLISH_STALL_MS)
      if (!leg.done) {
        stalled = true
        // The attempt keeps running on its own; nothing downs the composer —
        // the user may leave, close the sheet or even the app: the persisted
        // in-flight draft re-drives the publish on the next boot (same id,
        // PK dedupe). If it resolves while the page is still alive, catch it:
        flash('The network is very slow — the publish keeps trying in the background. You can leave this screen; reposting cannot duplicate it.')
        void publishPromise.then(result => {
          if (result === 'posted') {
            setDraft(''); setDraftImages([]); setDraftVideo(null); setVideoTrim(null); setDraftMediaUrls(null)
            composerPendingIdRef.current = null
            composerFlightRef.current = false
            setComposer(false)
            setPublishProgress(null)
            flash('Your draft just finished posting — it is on the Home feed.')
          } else {
            // definitive failure confirmed by the server — the retry below
            // is safe because the exactly-once key was never committed
            composerFlightRef.current = false
            setPublishProgress(null)
            flash('The background publish could not finish — your draft is kept. Press Post to try again.')
          }
        })
        return
      }
      if (leg.value === 'error') {
        composerFlightRef.current = false
        return // composer stays open, draft intact
      }
      setDraft(''); setDraftImages([]); setDraftVideo(null); setVideoTrim(null); setDraftMediaUrls(null)
      composerPendingIdRef.current = null
      composerFlightRef.current = false
      setComposer(false)
      flash(composerSource === 'confessions' && composerKind === 'confession'
        ? 'Confession posted — it appears here in the Confessions feed.'
        : composerKind === 'confession'
          ? 'Confession posted to the campus feed — your name stays hidden.'
          : 'Posted to the campus feed.')
    } catch (error) {
      // Media processing or a database failure: the composer stays open with
      // the draft intact; uploaded media stays reusable for the next attempt.
      composerFlightRef.current = false
      flash(db.friendlyMessage(error))
    } finally {
      setPublishing(false)
      setPublishProgress(null)
      releasePublish()
    }
  }

  /** Each page remembers its scroll depth: on mobile the browser toolbars
   * expand/collapse when the page scroll jumps, which makes the fixed bottom
   * nav visibly slide. Restoring the previous depth keeps switching calm. */
  const pageScrollMemory = useRef<Record<string, number>>({})

  const navigate = (label: string) => {
    setMobileMenu(false)
    if (restrictedNav.includes(label) && status !== 'member') {
      setPendingNav(label)
      requireAuth(
        label === 'Chats' ? 'chat with classmates'
          : label === 'Notifications' ? 'see your notifications'
            : 'save posts for later',
        label,
      )
      return
    }
    if (label !== activeNav) {
      const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 650px)').matches
      const scroller = isMobile ? mainRef.current : null
      pageScrollMemory.current[activeNav] = scroller ? scroller.scrollTop : window.scrollY
    }
    if (label !== 'Communities') { setOpenCommunityId(null); setCommunityTab(null) }
    if (label !== 'Events') setOpenEventSlug(null)
    if (label !== 'Marketplace') setOpenListingSlug(null)
    // the Confessions page lives inside Home only; a second Home press from
    // inside it returns to the feed
    if (label !== 'Home') setConfessionsOpen(false)
    else if (label === activeNav) setConfessionsOpen(false)
    // leaving the Chats pane unmounts the thread screen with it
    if (label !== 'Chats') setDmThread(null)
    setActiveNav(label)
    // any navigation leaves the search overlay behind (it re-opens on demand)
    if (label !== 'Search') { setSearchOpen(false); setSearchSeed('') }
    else setSearchOpen(true)
    if (label === 'Profile' && label === activeNav) setViewingProfileId(null)
    // "coming soon" only for genuinely scaffolded pages; Chats, Bookmarks,
    // Leaderboard, Notifications, Profile and My College are live (the last
    // three render real backends — verified in the M9–M16 probes)
    if (scaffoldNav.includes(label) && !['Chats', 'Bookmarks', 'Leaderboard', 'Notifications', 'Profile', 'My College'].includes(label)) flash(`${label} is coming soon.`)
  }

  /* ---- mobile swipe navigation (touch only, viewport ≤ 650px) -------------
   * Left-edge swipe right → the vertical nav drawer follows the finger and
   * springs open. Anywhere else, horizontal swipes flip between the four main
   * pages (Home → Discover → Chats → Profile and back) with the current page
   * following the finger: commit on distance or velocity, spring back
   * otherwise, and the incoming page slides in. Vertical scrolling, image
   * carousels, inputs and sheets are never hijacked. */

  const mainRef = useRef<HTMLElement | null>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const mobileHeaderRef = useRef<HTMLElement | null>(null)
  // swipe-dismiss attaches through ref callbacks (React 18: no ref cleanup
  // return), so each sheet keeps its own teardown holder
  const composerDismiss = useRef<(() => void) | null>(null)
  const editDismiss = useRef<(() => void) | null>(null)
  const confirmDismiss = useRef<(() => void) | null>(null)
  const [slideDir, setSlideDir] = useState<'none' | 'from-right' | 'from-left'>('none')

  // scroll-edge state for the fixed mobile header: while a page sits at the
  // top the bar reads as frameless; once content passes underneath, the
  // hairline deepens into a soft shadow so it separates from scrolling
  // content (HIG scroll-edge treatment). DOM-only — no re-render per scroll.
  const updateHeaderEdge = () => {
    const header = mobileHeaderRef.current
    if (!header) return
    const scroller = mainRef.current
    const top = scroller ? scroller.scrollTop : 0
    header.classList.toggle('scrolled', top > 6)
  }

  // restore each page's scroll depth synchronously before paint (mobile only —
  // the pages now scroll inside .main-column, so the window never scrolls and
  // the browser toolbar — and with it the fixed bottom nav — can never move)
  useLayoutEffect(() => {
    if (!window.matchMedia('(max-width: 650px)').matches) return
    const scroller = mainRef.current
    if (!scroller) return
    const saved = pageScrollMemory.current[activeNav]
    scroller.scrollTop = typeof saved === 'number' ? saved : 0
    updateHeaderEdge()
  }, [activeNav])
  const slideTimer = useRef<number | null>(null)
  const swipe = useRef({
    startX: 0, startY: 0, lastX: 0, lastT: 0, prevX: 0, prevT: 0,
    dx: 0, vel: 0, active: false, mode: '' as '' | 'page' | 'sidebar',
  })
  const activeNavRef = useRef(activeNav); activeNavRef.current = activeNav
  const navigateRef = useRef(navigate); navigateRef.current = navigate
  const mobileMenuRef = useRef(mobileMenu); mobileMenuRef.current = mobileMenu

  const beginSlide = (dir: 'from-right' | 'from-left') => {
    if (slideTimer.current) window.clearTimeout(slideTimer.current)
    setSlideDir(dir)
    slideTimer.current = window.setTimeout(() => setSlideDir('none'), 360)
  }

  const clearDragStyles = () => {
    const main = mainRef.current
    if (main) { main.classList.remove('swiping'); main.style.transform = '' }
    const sidebar = sidebarRef.current
    if (sidebar) { sidebar.classList.remove('swiping'); sidebar.style.transform = ''; sidebar.style.transition = '' }
  }

  /** Atomic reset used at the start of every touch: kills any in-flight slide
   * animation, pending drag timers and leftover transforms so rapid or
   * overlapping gestures can never compound into a broken UI state. */
  const pendingDragTimers = useRef<number[]>([])
  const queueDragCleanup = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      pendingDragTimers.current = pendingDragTimers.current.filter(t => t !== id)
      fn()
    }, ms)
    pendingDragTimers.current.push(id)
  }
  const resetDragAndAnimations = () => {
    if (slideTimer.current) { window.clearTimeout(slideTimer.current); slideTimer.current = null }
    for (const id of pendingDragTimers.current) window.clearTimeout(id)
    pendingDragTimers.current = []
    setSlideDir('none')
    clearDragStyles()
  }

  const neighborPage = (dx: number): string | null => {
    const current = activeNavRef.current
    const index = swipePageOrder.indexOf(current)
    if (dx < 0) { // finger right → left: next page
      if (index === -1) return 'Home'
      return index < swipePageOrder.length - 1 ? swipePageOrder[index + 1] : null
    }
    // finger left → right: previous page (the left edge already opens the drawer)
    if (index <= 0) return null
    return swipePageOrder[index - 1]
  }

  // The shell (main + drawer) mounts after the boot screens clear, so the
  // gesture handlers attach through ref callbacks — they fire whenever the
  // elements are actually placed in the DOM, boot or no boot.
  const cleanupRef = useRef<(() => void) | null>(null)
  const sidebarCleanupRef = useRef<(() => void) | null>(null)

  const attachMainRef = useCallback((el: HTMLElement | null) => {
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null }
    mainRef.current = el
    if (!el) return
    const isMobile = () => window.matchMedia('(max-width: 650px)').matches
    const main = el

    const onSwipeStart = (event: TouchEvent) => {
      if (!isMobile() || mobileMenuRef.current || event.touches.length > 1) return
      const target = event.target as Element
      // This gesture may already belong to something local (an input, an
      // overlay, or a horizontally scrollable/tab region). Resolve the owner
      // from the touch origin and step aside for the whole gesture — the
      // decision is never revisited on move/end.
      if (localSwipeOwner(target)) {
        swipe.current.active = false
        return
      }
      // every new touch starts from a guaranteed-clean visual state
      resetDragAndAnimations()
      const touch = event.touches[0]
      swipe.current = {
        startX: touch.clientX, startY: touch.clientY,
        lastX: touch.clientX, lastT: performance.now(),
        prevX: touch.clientX, prevT: performance.now(),
        dx: 0, vel: 0, active: true, mode: '',
      }
    }

    const onSwipeMove = (event: TouchEvent) => {
      const state = swipe.current
      if (!state.active || event.touches.length > 1) return
      const touch = event.touches[0]
      const dx = touch.clientX - state.startX
      const dy = touch.clientY - state.startY

      if (!state.mode) {
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          // rightward pulls belong to the nav drawer on Home; every other
          // page flip is handled as paging (so back-swipes work from the edge)
          state.mode = dx > 0 && activeNavRef.current === 'Home' ? 'sidebar' : 'page'
        } else if (dx > 14 && dx > Math.abs(dy) && activeNavRef.current === 'Home') {
          // eased pull so the drawer opens even from a sloppier horizontal drag
          state.mode = 'sidebar'
        } else if (Math.abs(dy) > 14) {
          state.active = false // vertical scroll — never hijack
          return
        } else {
          return
        }
      }

      const now = performance.now()
      const dt = now - state.prevT
      if (dt > 0) state.vel = (touch.clientX - state.prevX) / dt
      state.prevX = touch.clientX; state.prevT = now
      state.dx = dx
      state.lastX = touch.clientX; state.lastT = now

      // once the gesture is ours, the page must not scroll natively — this
      // keeps Chrome's toolbar (and the fixed bottom nav anchored to it)
      // perfectly still during the drag
      event.preventDefault()

      const width = main.clientWidth
      if (state.mode === 'page') {
        main.classList.add('swiping')
        const shift = Math.max(-width * 0.8, Math.min(width * 0.8, dx * 0.9))
        main.style.transform = `translateX(${shift}px)`
      } else if (state.mode === 'sidebar') {
        const sidebar = sidebarRef.current
        if (sidebar) {
          sidebar.classList.add('swiping')
          const shown = Math.min(Math.max(dx, 0), width)
          sidebar.style.transform = `translateX(${shown - sidebar.offsetWidth}px)`
        }
      }
    }

    const finishOrCancel = (event: TouchEvent) => {
      const state = swipe.current
      if (!state.active) return
      state.active = false
      if (!state.mode) return

      const width = main.clientWidth
      if (state.mode === 'page') {
        const commit = Math.abs(state.dx) > width * 0.24 || Math.abs(state.vel) > 0.55
        const target = commit ? neighborPage(state.dx) : null
        if (target) {
          // synchronous commit: clear drag state and navigate in one go.
          // No pending timers — fast repeated swipes can never double-fire,
          // teleport the page off-screen or corrupt the layout under the
          // fixed bottom nav.
          clearDragStyles()
          navigateRef.current(target)
          beginSlide(state.dx < 0 ? 'from-right' : 'from-left')
        } else {
          clearDragStyles() // spring back
        }
      } else {
        const sidebar = sidebarRef.current
        const open = state.dx > width * 0.28 || state.vel > 0.55
        if (open && sidebar) {
          // keep the dragged position, hand control back to the CSS
          // transition so the drawer glides the last bit instead of snapping
          sidebar.classList.remove('swiping')
          sidebar.style.transition = 'transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1)'
          setMobileMenu(true)
          queueDragCleanup(() => {
            if (sidebarRef.current === sidebar) sidebar.style.transform = ''
            queueDragCleanup(() => clearDragStyles(), 360)
          }, 30)
        } else {
          clearDragStyles() // slides back under its own transition
        }
      }
    }

    main.addEventListener('touchstart', onSwipeStart, { passive: true })
    // non-passive so a decided horizontal gesture can freeze native scrolling
    main.addEventListener('touchmove', onSwipeMove, { passive: false })
    main.addEventListener('touchend', finishOrCancel, { passive: true })
    main.addEventListener('touchcancel', finishOrCancel, { passive: true })
    // scroll-edge header: track the scroller directly (on mobile the pages
    // scroll inside .main-column — the window never scrolls)
    const onScrollEdge = () => updateHeaderEdge()
    main.addEventListener('scroll', onScrollEdge, { passive: true })
    onScrollEdge()
    cleanupRef.current = () => {
      main.removeEventListener('touchstart', onSwipeStart)
      main.removeEventListener('touchmove', onSwipeMove)
      main.removeEventListener('touchend', finishOrCancel)
      main.removeEventListener('touchcancel', finishOrCancel)
      main.removeEventListener('scroll', onScrollEdge)
      if (slideTimer.current) window.clearTimeout(slideTimer.current)
      for (const id of pendingDragTimers.current) window.clearTimeout(id)
      pendingDragTimers.current = []
    }
  }, [])

  // Drawer close gestures: swipe it back to the left, or tap the scrim behind it.
  const attachSidebarRef = useCallback((el: HTMLElement | null) => {
    if (sidebarCleanupRef.current) { sidebarCleanupRef.current(); sidebarCleanupRef.current = null }
    sidebarRef.current = el
    if (!el) return
    const sidebar = el
    let start: { x: number; y: number } | null = null

    const onDrawerStart = (event: TouchEvent) => {
      if (!window.matchMedia('(max-width: 650px)').matches) return
      const touch = event.touches[0]
      start = { x: touch.clientX, y: touch.clientY }
    }
    const onDrawerMove = (event: TouchEvent) => {
      if (!start || !mobileMenuRef.current) return
      const touch = event.touches[0]
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        setMobileMenu(false)
        start = null
      }
    }
    const onDrawerEnd = () => { start = null }

    sidebar.addEventListener('touchstart', onDrawerStart, { passive: true })
    sidebar.addEventListener('touchmove', onDrawerMove, { passive: true })
    sidebar.addEventListener('touchend', onDrawerEnd, { passive: true })
    sidebarCleanupRef.current = () => {
      sidebar.removeEventListener('touchstart', onDrawerStart)
      sidebar.removeEventListener('touchmove', onDrawerMove)
      sidebar.removeEventListener('touchend', onDrawerEnd)
    }
  }, [])

  const openComposer = (kind: PostKind = 'post', source: 'home' | 'confessions' = 'home'): boolean => {
    if (!requireAuth('create posts, polls and confessions')) return false
    // A restored draft owns the sheet: images/videos and the trim survive the
    // reload with it, so nothing is wiped on reopen — the user picks up
    // exactly where the draft left off (posting it finishes with the same
    // exactly-once key). Only a genuinely fresh composer starts blank.
    const hasDraft = Boolean(draft.trim()) || draftImages.length > 0 || draftVideo !== null || (draftMediaUrls?.length ?? 0) > 0
    if (hasDraft && !publishing) {
      // the user is looking at their draft — they own it now; a failed boot
      // resume must not re-publish edits they decided to keep unfinished
      composerFlightRef.current = false
    }
    if (!hasDraft) {
      setComposerKind(kind)
      setDraftImages([])
      setDraftVideo(null)
      setVideoTrim(null)
      setTrimOpen(false)
      setPublishProgress(null)
      // poll fields start fresh every time the composer opens blank
      setPollOptions(['', ''])
      setPollMultiple(false)
      setPollDays(7)
      setPollErrors([])
    }
    setComposerSource(source)
    setComposer(true)
    return true
  }

  /**
   * Submit a poll vote (or replace an existing one). The server is
   * authoritative: its returned fresh state replaces the local snapshot;
   * a failed request changes nothing and surfaces a retryable message.
   */
  const votePoll = async (post: CampusPost, optionIds: string[]): Promise<boolean> => {
    if (!requireAuth('vote in campus polls')) return false
    if (!configured || !user) return false
    try {
      const state = await db.castPollVote(post.id, optionIds)
      setPollStateMap(current => ({ ...current, [post.id]: state }))
      return true
    } catch (error) {
      flash(db.friendlyMessage(error))
      return false
    }
  }

  /** open the dedicated Confessions destination (pink Home card) */
  const openConfessionsPage = () => {
    setConfessionsOpen(true)
  }

  /**
   * Shared publish path for the inline composer and the full composer sheet:
   * writes to the posts table when the database is connected, otherwise keeps
   * the post on this device and says exactly that.
   *
   * options.postId: the exactly-once key — retries of a stalled/offline
   * draft reuse it, so the database PK (not client guesswork) is what makes
   * double publishing impossible. options.isStale: when the caller timed out
   * waiting, late failures stay silent (the user was already told); late
   * successes still land in the feed, exactly once.
   */
  const publishPostCore = async (
    body: string,
    kind: PostKind,
    mediaUrls: string[] | null,
    onProgress?: (message: string) => void,
    options: { postId?: string; isStale?: () => boolean } = {},
  ): Promise<'posted' | 'error'> => {
    const anonymous = kind === 'confession'
    // College scope = the author's own college. Staff (platform-level, no
    // college per 0042) post platform-wide with no affiliation chip.
    const collegeRow = isStaff
      ? null
      : (colleges.find(c => c.id === profile?.college_id) ?? colleges[0])
    if (user && configured) {
      try {
        const post = await db.createPost({
          userId: user.id,
          body,
          kind,
          isAnonymous: anonymous,
          collegeId: profile?.college_id ?? null,
          collegeShort: collegeRow?.short_name ?? '',
          authorName: identity.name,
          authorUsername: identity.username,
          mediaUrls,
          postId: options.postId,
        })
        if (profile?.college_id == null && !isStaff) {
          flash('Posted — but pick your college in the onboarding step so your campus can find it.')
        }
        // exactly-once in the feed too: a late-confirming retry replaces the
        // surfaced row instead of appending the same post twice
        setPosts(current => current.some(p => p.id === post.id)
          ? current.map(p => p.id === post.id ? post : p)
          : [post, ...current])
        if (composerSource === 'confessions' && kind === 'confession') {
          // published from the Confessions page: stay on it and let it refresh
          setConfRefreshSeq(seq => seq + 1)
          return 'posted'
        }
        setActiveNav('Home'); setFeedTab('For You')
        return 'posted'
      } catch (error) {
        // a stalled caller already owns the messaging — stay silent for it
        if (!options.isStale?.()) flash(db.friendlyMessage(error))
        return 'error'
      }
    }
    // Local-only path (no database configured). The message says exactly that.
    const post: CampusPost = anonymous
      ? {
          id: `local-${Date.now()}`, author: 'Anonymous', handle: '', initials: '', college: identity.college,
          time: 'just now', body, likes: 0, comments: 0, reposts: 0, kind,
          anonymous: true, tag: identity.college,
        }
      : {
          id: `local-${Date.now()}`, author: identity.name, handle: identity.handle, initials: identity.initials,
          college: identity.college, time: 'just now', body, likes: 0, comments: 0, reposts: 0,
          kind, tag: identity.college,
        }
    setPosts(current => [post, ...current])
    setActiveNav('Home'); setFeedTab('For You')
    onProgress?.('')
    flash(anonymous
      ? 'Confession added to your feed — stored on this device only (no database connected).'
      : 'Post added to your feed — stored on this device only (no database connected).')
    return 'posted'
  }

  /* ---- edit / delete own posts ------------------------------------------- */

  const startEditPost = (post: CampusPost) => {
    if (post.anonymous) { notify('Anonymous confessions cannot be edited — that is what keeps them anonymous.'); return }
    if (post.authorId !== user?.id) { notify('You can only edit your own posts.'); return }
    setEditingPost(post)
    setEditDraft(post.body)
  }

  const saveEditedPost = async () => {
    if (!editingPost) return
    if (!editDraft.trim()) { flash('Write something before saving.'); return }
    setEditBusy(true)
    try {
      const editedAt = await db.updatePost(editingPost.id, editDraft.trim())
      const nextBody = editDraft.trim()
      setPosts(current => current.map(p => p.id === editingPost.id
        ? { ...p, body: nextBody, editedAt: editedAt ?? new Date().toISOString(), time: db.relativeTime(new Date().toISOString()) }
        : p))
      setEditingPost(null)
      setEditDraft('')
      flash('Post updated.')
    } catch (error) {
      flash(db.friendlyMessage(error))
    } finally {
      setEditBusy(false)
    }
  }

  const removePost = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await db.deletePost(deleteTarget.id)
      const removedId = deleteTarget.id
      setPosts(current => current.filter(p => p.id !== removedId))
      setDeleteTarget(null)
      flash('Post deleted.')
    } catch (error) {
      flash(db.friendlyMessage(error))
    } finally {
      setDeleteBusy(false)
    }
  }

  /* ---- inline quick composer (text posts, right on the feed) ------------- */
  const startInlineComposer = () => {
    if (!requireAuth('create posts, polls and confessions')) return
    if (inlineDraft.trim() && !inlineBusy) inlineFlightRef.current = false // user takes ownership
    setInlineOpen(true)
  }

  const publishInlinePost = async () => {
    if (!inlineDraft.trim()) { flash('Write something before posting.'); return }
    if (!assertCanPublish()) return
    inlineFlightRef.current = true
    setInlineBusy(true)
    // true once the watchdog fires — publishPostCore stays quiet about a late
    // failure (the caller below already owns the messaging)
    let stalled = false
    try {
      // exactly-once key: persisted with the inline draft, reused by every
      // retry (double tap, offline recovery, reload mid-outage)
      const pendingId = inlinePendingIdRef.current ?? db.newPostId()
      inlinePendingIdRef.current = pendingId
      const publishPromise = publishPostCore(inlineDraft.trim(), 'post', null, undefined, { postId: pendingId, isStale: () => stalled })
      const leg = await raceStall(publishPromise, PUBLISH_STALL_MS)
      if (!leg.done) {
        stalled = true
        // the attempt keeps running; the inline composer stays open with the
        // draft (and its key) intact — reload-safe via the persisted flag
        flash('The network is very slow — the publish keeps trying in the background. Your draft is safe here, and reposting cannot duplicate it.')
        void publishPromise.then(result => {
          if (result === 'posted') {
            setInlineDraft('')
            setInlineOpen(false)
            flash('Your draft just finished posting — it is on the Home feed.')
          } else {
            inlineFlightRef.current = false
            flash('The background publish could not finish — your draft is kept. Press Post to try again.')
          }
        })
        return
      }
      if (leg.value === 'posted') {
        // clearing the draft empties the persisted store and key (effects above)
        setInlineDraft('')
        setInlineOpen(false)
        flash('Posted to the campus feed.')
      } else {
        inlineFlightRef.current = false
      }
    } finally {
      setInlineBusy(false)
      releasePublish()
    }
  }

  /* Boot-resume: a publish attempt was mid-flight when the app last closed,
     so the platform never saw its outcome — drive it again with the SAME
     exactly-once key. If the original attempt committed, the posts PK
     returns the row instead of duplicating; if it did not, the publish
     happens now. Inline drafts resume through their own publish path. */
  useEffect(() => {
    if (!resumeTarget || !user || !configured || status !== 'member') return
    const target = resumeTarget
    setResumeTarget(null)
    if (publishActiveRef.current) return // something is already publishing
    if (target === 'composer') {
      void createPost()
    } else {
      void publishInlinePost()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeTarget, user, configured, status])

  /** Switching composer type starts the media selection fresh. */
  const changeComposerKind = (kind: PostKind) => {
    if (kind === composerKind) return
    setComposerKind(kind)
    setDraftImages([])
    setDraftVideo(null)
    setVideoTrim(null)
    setPublishProgress(null)
    setDraftMediaUrls(null) // media pending changed — cached URLs are stale
    // fresh poll fields on every switch into the poll composer
    setPollOptions(['', ''])
    setPollMultiple(false)
    setPollDays(7)
    setPollErrors([])
  }

  /**
   * Tapping Post / Reel in the kind row immediately opens the device gallery
   * or file picker. The inputs live outside the sheet so the browser treats
   * the tap as a direct user gesture (required to open pickers).
   */
  const handleKindSelect = (kind: PostKind) => {
    changeComposerKind(kind)
    if (kind === 'post') imagesInputRef.current?.click()
    else if (kind === 'reel') videoInputRef.current?.click()
  }

  const addComposerImages = (files: File[]) => {
    for (const file of files) {
      const message = db.validateMediaFile(file, 'image')
      if (message) { flash(message); return }
    }
    setDraftImages(current => {
      const room = 10 - current.length
      if (files.length > room) flash(`Up to 10 images per carousel — keeping the first ${room}.`)
      return [...current, ...files.slice(0, room)]
    })
    // images pending changed — any cached upload set no longer matches
    setDraftMediaUrls(null)
  }

  const removeComposerImage = (index: number) => {
    setDraftImages(current => current.filter((_, i) => i !== index))
    setDraftMediaUrls(null)
  }

  /** Pick the reel video, then open the trimmer when it is over 30 seconds. */
  const pickReelVideo = async (file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('video/')) { flash('Attach a video file (MP4 or WebM) to post a reel.'); return }
    if (file.size > 300 * 1024 * 1024) { flash('That video is over 300 MB. Pick a smaller one.'); return }
    try {
      setPublishProgress('Reading video…')
      const info = await media.probeVideo(file)
      setDraftVideo(file)
      setVideoTrim(null)
      setReelDuration(info.duration)
      setDraftMediaUrls(null) // a new reel file — cached upload URLs are stale
      if (info.duration > media.REEL_WINDOW_SECONDS + 0.05) setTrimOpen(true)
    } catch (error) {
      flash(db.friendlyMessage(error))
    } finally {
      setPublishProgress(null)
    }
  }

  const toggleFollow = (handle: string) => {
    if (!requireAuth('follow students')) return
    setFollowing(old => old.includes(handle) ? old.filter(x => x !== handle) : [...old, handle])
  }

  const enterExplore = () => {
    markWelcomeSeen()
    setExplored(true)
  }

  const signOut = async () => {
    await auth.signOut()
    setActiveNav('Home')
    flash('Signed out.')
  }

  /* ---- account states -------------------------------------------------- */

  const toast = (notice || auth.notice)
    ? <div className="toast" role="status"><Check size={17}/>{notice || auth.notice}</div>
    : null

  /* A publish keeps running after the composer is closed (Cancel/back mid
     flight) — this is where the user sees it: a status pill above the bottom
     nav, fixed on every page, with a jump-back affordance. */
  const publishBanner = (publishing && !composer)
    ? (
      <div className="publish-banner" role="status">
        <Loader2 size={14} className="nc-spin"/>
        <span>{publishProgress || (composerKind === 'poll' ? 'Publishing poll…' : 'Posting…')}</span>
        <button onClick={() => setComposer(true)}>Show</button>
      </div>
    )
    : null

  const modals = (
    <>
      {bootVeil}
      {toast}
      {publishBanner}
      {gateInfo && (
        <SignUpPrompt
          reason={gateInfo.reason}
          onClose={closeGate}
          onJoin={() => { closeGate(); setAuthMode('signup') }}
          onSignIn={() => { closeGate(); setAuthMode('signin') }}
        />
      )}
      {authMode && <AuthModal mode={authMode} onModeChange={setAuthMode} onClose={() => setAuthMode(null)} />}
      {reportTarget && (
        <ReportDialog
          target={reportTarget}
          onClose={() => setReportTarget(null)}
          onSubmitted={message => { setReportTarget(null); flash(message) }}
        />
      )}
      {openShareTarget && (
        <ShareContentSheet
          target={openShareTarget}
          onClose={() => setOpenShareTarget(null)}
          onFlash={flash}
          onSent={count => flash(count === 1 ? 'Sent to 1 chat.' : `Sent to ${count} chats.`)}
        />
      )}
    </>
  )

  if (auth.booting) {
    return (
      <>
        <BootScreen slow={bootSlow} />
        {toast}
      </>
    )
  }

  if (profileError) {
    return (
      <>
        <BootScreen
          error={profileError}
          onRetry={() => void reloadProfile()}
          onSignOut={() => void auth.signOut()}
        />
        {toast}
      </>
    )
  }

  if (status === 'onboarding') {
    return (
      <>
        {bootVeil}
        <OnboardingWizard />
        {toast}
      </>
    )
  }

  if (status === 'visitor' && !explored) {
    return (
      <>
        <WelcomeScreen onExplore={enterExplore} onJoin={() => setAuthMode('signup')} configured={configured} />
        {modals}
      </>
    )
  }

  return (
    <div className={`app-shell${dmThread && isMobileViewport() ? ' nav-hidden' : ''}`}>
      <header className="mobile-header" ref={el => { mobileHeaderRef.current = el }}>
        <div className="mobile-header-left">
          <button className="icon-button" aria-label="Menu" onClick={() => setMobileMenu(true)}><Menu size={21}/></button>
          <button className="brand-mini" onClick={() => navigate('Home')}><span className="brand-mark">C</span><b>CAMPUS</b></button>
        </div>
        <div className="mobile-header-actions">
          <button className="icon-button" aria-label="Search" onClick={() => setSearchOpen(v => !v)}><Search size={21}/></button>
          <button className="icon-button" aria-label="Notifications" onClick={() => navigate('Notifications')}><Bell size={21}/>{unreadNotifs > 0 && <i className="notification-dot"/>}</button>
        </div>
      </header>

      <aside ref={attachSidebarRef} className={`left-sidebar ${mobileMenu ? 'mobile-open' : ''}`}>
        <button className="icon-button sidebar-close" aria-label="Close menu" onClick={() => setMobileMenu(false)}><X size={20}/></button>
        <button className="brand" onClick={() => navigate('Home')}><span className="brand-mark">C</span><span>CAMPUS</span></button>
        <div className="sidebar-campus-card">
          <div className="sidebar-campus-art"><Building2 size={28}/><span>{activeCollege?.short_name ?? (isStaff ? 'HQ' : 'SPPU')}</span></div>
          <div className="sidebar-campus-info"><b>{activeCollege?.short_name ?? 'SPPU'}</b><small>{activeCollege?.name ?? 'Savitribai Phule Pune University'}</small></div>
          <button onClick={() => navigate('My College')}>Change college <ArrowLeft size={13}/></button>
        </div>
        <nav className="primary-nav" ref={glideNavRef}>
          {navItems.map(({label, icon: Icon}) => (
            <button key={label} className={`nav-item ${activeNav === label ? 'active' : ''} ${label === 'My College' ? 'nav-labelled' : ''} ${navOnMainUi.includes(label) ? 'nav-on-main-ui' : ''}`} onClick={() => navigate(label)} title={label}>
              <Icon size={21} strokeWidth={activeNav === label ? 2.4 : 2}/><span>{label}</span>
            </button>
          ))}
          {isStaff && (
            <>
              <button className={`nav-item ${activeNav === 'Staff Console' ? 'active' : ''}`} onClick={() => navigate('Staff Console')} title="Staff Console">
                <ShieldCheck size={21} strokeWidth={activeNav === 'Staff Console' ? 2.4 : 2}/><span>Staff Console</span>
              </button>
              <button className={`nav-item ${activeNav === 'Advertising' ? 'active' : ''}`} onClick={() => navigate('Advertising')} title="Advertising">
                <Megaphone size={21} strokeWidth={activeNav === 'Advertising' ? 2.4 : 2}/><span>Advertising</span>
              </button>
            </>
          )}
        </nav>
        <div className="drawer-footer">
          {infoNav.map(label => (
            <button key={label} onClick={() => navigate(label)}>{label}</button>
          ))}
        </div>
        <button className="compose-sidebar" onClick={() => openComposer()}><Plus size={20}/> Create post</button>
        <div className="sidebar-bottom">
          {status === 'member' && user
            ? <button className="profile-chip" onClick={signOut} title={`${identity.name} — sign out`}>
                <span className="avatar small">{identity.initials}</span>
                <span className="profile-chip-copy"><b>{identity.name}</b><small>{identity.handle} · Sign out</small></span>
                <LogOut size={16}/>
              </button>
            : <button className="profile-chip" onClick={() => setAuthMode('signup')} title="Join CAMPUS — sign in or create account">
                <span className="avatar small"><UserRound size={17}/></span>
                <span className="profile-chip-copy"><b>Join CAMPUS</b><small>Sign in or create account</small></span>
                <ChevronDown size={16}/>
              </button>}
        </div>
      </aside>

      <main ref={attachMainRef} className={`main-column ${slideDir !== 'none' ? `page-anim ${slideDir}` : ''}`}>
        <div className={`sidebar-scrim ${mobileMenu ? 'open' : ''}`} onClick={() => setMobileMenu(false)} aria-hidden="true"/>
        <div className="desktop-page-title"><h1>{activeNav}</h1>{activeNav !== 'Home' && <span className="section-kicker">YOUR CAMPUS SPACE</span>}</div>

        {status === 'visitor' && (
          <div className="visitor-strip">
            <EyeOff size={16}/>
            <span>You are exploring CAMPUS read-only. Join to post, react and chat.</span>
            <button className="primary-button small" onClick={() => setAuthMode('signup')}>Join CAMPUS</button>
          </div>
        )}

        {searchOpen && <SearchPanel colleges={colleges} clubs={clubs} blockedHandles={blockedHandles} mutedHandles={mutedHandles} initialQuery={searchSeed} onClose={() => { setSearchOpen(false); setSearchSeed('') }} onOpenProfile={personId => { setViewingProfileId(personId); navigate('Profile') }} onMessagePerson={personId => void messagePerson(personId)} onNavigate={navigate} />}
        {activeNav === 'Home' && confessionsOpen ? (
          /* dedicated Confessions destination — Home as a subview, real
             history entry, shares the composer + all post interactions */
          <Confessions
            userId={user?.id ?? null}
            myCollegeId={profile?.college_id ?? null}
            myCollegeShort={identity.college}
            configured={configured}
            requireAuth={requireAuth}
            notify={message => { flash(message) }}
            onShareConfession={() => { openComposer('confession', 'confessions') }}
            onBack={() => { if (!navHistory.popSubviewEntry()) setConfessionsOpen(false) }}
            refreshSeq={confRefreshSeq}
            patch={confessPatch}
            onLike={item => void toggleLike(item.id, item)}
            onSave={item => toggleSave(item.id)}
            onComment={item => openComments(item)}
            onShare={item => void sharePost(item)}
            onReport={item => openReport(item)}
            onRepost={item => toggleRepost(item.id, item)}
            onBlock={item => void setRelation('user_blocks', item)}
            onMute={item => void setRelation('user_mutes', item)}
            onMessage={item => void messageAuthor(item)}
            onOpenMention={openMentionProfile}
            onOpenTag={openHashtagSearch}
          />
        ) : activeNav === 'Home' ? <>
          <div className="desktop-topbar"><div className="desktop-search-trigger" onClick={() => setSearchOpen(true)} role="button" tabIndex={0}><Search size={18}/><span>Search for people, posts, colleges, clubs...</span></div><div className="topbar-actions"><button className="icon-button" aria-label="Notifications" onClick={() => navigate('Notifications')}><Bell size={20}/>{unreadNotifs > 0 && <i className="notification-dot"/>}</button><button className="icon-button" aria-label="My profile" onClick={() => navigate('Profile')}><UserRound size={20}/></button></div></div>
          <section className="campus-hero-banner"><div className="hero-copy"><span className="hero-eyebrow">YOUR PEOPLE. YOUR PLACE.</span><h2>Same Campus,<br/><em>Bigger Dreams.</em></h2><span className="hero-swish"/><p>Connect · Share · Grow</p></div><div className="hero-campus-art" aria-hidden="true"><div className="art-sun"/><div className="art-building"><span/><span/><span/><span/><b/></div><div className="art-hill"/></div><button className="college-pill" onClick={() => navigate('My College')}><span className="college-seal"><Building2 size={22}/></span><span><b>{activeCollege?.short_name ?? (isStaff ? 'CAMPUS HQ' : 'SPPU')}</b><small>{activeCollege?.name ?? (isStaff ? 'Platform team — all colleges' : 'Savitribai Phule Pune University')}</small></span><ChevronDown size={16}/></button></section>
          <div className="feed-tabs" role="tablist">
            {['For You','Following','My College','Trending','Latest'].map(tab => <button key={tab} role="tab" aria-selected={feedTab===tab} className={feedTab===tab?'selected':''} onClick={() => setFeedTab(tab)}>{tab}</button>)}
          </div>
          <div className="feature-row">
            <button className="feature-card leaderboard" onClick={() => navigate('Leaderboard')}><Trophy size={18}/><b>Not ranked yet</b><span>Post to get on the board</span></button>
            <button className="feature-card confessions" aria-label="Open the Confessions feed" onClick={openConfessionsPage}><BookOpen size={18}/><b>Confessions</b><span>Anonymous, campus-only</span></button>
          </div>
          <p className="campus-presence">{identity.college ? `2 students from ${identity.college} are on CAMPUS` : 'Your campus community is on CAMPUS'}</p>
          <section className="composer-inline">
            <div className="avatar campus-avatar">{status === 'member' ? identity.initials : 'C'}<span className="online-dot"/></div>
            <div className="composer-main">
              {inlineOpen ? (
                <div className="inline-composer-open">
                  <textarea
                    value={inlineDraft}
                    onChange={e => setInlineDraft(e.target.value)}
                    placeholder="What's happening on campus?"
                    maxLength={500}
                    autoFocus
                    rows={3}
                  />
                  <div className="inline-composer-actions">
                    <div className="composer-tools">
                      <button aria-label="Add image" onClick={() => { if (openComposer('post')) window.setTimeout(() => imagesInputRef.current?.click(), 50) }}><Image size={18}/></button>
                      <button aria-label="Create poll" onClick={() => openComposer('poll')}><ChartNoAxesColumn size={18}/></button>
                      <button aria-label="Create event" onClick={() => navigate('Events')}><CalendarDays size={18}/></button>
                    </div>
                    <div className="inline-composer-buttons">
                      <button className="inline-cancel" onClick={() => { setInlineOpen(false); setInlineDraft('') }}>Cancel</button>
                      <button className="post-button" disabled={inlineBusy} onClick={() => void publishInlinePost()}>{inlineBusy ? 'Posting…' : `Post${inlineDraft.trim().length ? ` (${inlineDraft.trim().length}/500)` : ''}`}</button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <button className="composer-prompt" onClick={startInlineComposer}>What's happening on campus?</button>
                  <div className="composer-tools">
                    <button aria-label="Add image" onClick={() => { if (openComposer('post')) window.setTimeout(() => imagesInputRef.current?.click(), 50) }}><Image size={18}/></button>
                    <button aria-label="Create poll" onClick={() => openComposer('poll')}><ChartNoAxesColumn size={18}/></button>
                    <button aria-label="Create event" onClick={() => navigate('Events')}><CalendarDays size={18}/></button>
                    <button className="post-button" onClick={startInlineComposer}>Post</button>
                  </div>
                </>
              )}
            </div>
          </section>
          <section className="feed-list">
            {feedError && (
              <div className="feed-status error-card" role="status">
                <b>Showing sample posts — the live feed could not load.</b>
                <p>{feedError}</p>
                <button className="secondary-button" onClick={() => void loadFeed()}>Try again</button>
              </div>
            )}
            {feedLoading && <p className="feed-status" role="status">Loading the campus feed…</p>}
            {feedItems.length ? feedItems.map(item => item.kind === 'sponsored'
              ? <SponsoredCard
                  key={`ad-${item.ad.id}`}
                  ad={item.ad}
                  flash={flash}
                  onHide={() => hideAd(item.ad.id)}
                />
              : <PostCard
              key={item.post.id}
              post={item.post}
              isOwn={Boolean(user && item.post.authorId && item.post.authorId === user.id && !item.post.anonymous)}
              poll={pollStateMap[item.post.id]}
              onVote={optionIds => votePoll(item.post, optionIds)}
              onLike={() => void toggleLike(item.post.id)}
              onSave={() => toggleSave(item.post.id)}
              onComment={() => openComments(item.post)}
              onShare={() => void sharePost(item.post)}
              onReport={() => openReport(item.post)}
              onRepost={() => toggleRepost(item.post.id)}
              onBlock={() => void setRelation('user_blocks', item.post)}
              onMute={() => void setRelation('user_mutes', item.post)}
              onEdit={() => startEditPost(item.post)}
              onDelete={() => setDeleteTarget(item.post)}
              onMessage={() => void messageAuthor(item.post)}
              onOpenMention={openMentionProfile}
              onOpenTag={openHashtagSearch}
            />) :
              feedSource === 'db'
                ? <div className="empty-state"><Sparkles size={28}/><b>No posts yet</b><span>Be the first to post to your campus.</span></div>
                : <div className="empty-state"><Search size={28}/><b>No posts found</b><span>Try another tab or search term.</span></div>}
          </section>
        </> : activeNav === 'Safety Centre'
          ? <SafetyCentre />
          : activeNav === 'Discover'
            ? <ReelsFeed
                userId={user?.id ?? null}
                identity={identity}
                requireAuth={requireAuth}
                flash={flash}
                onReport={openReport}
                onCreateReel={() => openComposer('reel')}
                onOpenAuthor={openMentionProfile}
                onShareContent={openShareSheet}
                autoOpenId={reelAutoOpen}
                onAutoOpened={() => setReelAutoOpen(null)}
              />
            : activeNav === 'Chats'
              ? <Chats
                  key="chats"
                  identity={identity && user ? { id: user.id, name: identity.name, username: identity.username, initials: identity.initials } : null}
                  configured={configured}
                  autoOpen={chatAutoOpen}
                  onAutoOpened={() => setOpenChatId(null)}
                  initialDraft={chatDraft}
                  onDraftConsumed={() => setChatDraft(null)}
                  onOpenProfile={openMentionProfile}
                  onMobileThreadChange={handleMobileThreadChange}
                  closeThreadRequest={threadCloseSeq}
                  requestThreadBack={() => navHistory.popThreadEntry()}
                />
              : activeNav === 'Profile'
              ? <Profile
                  key="profile"
                  profileId={viewingProfileId}
                  myUserId={user?.id ?? ''}
                  colleges={colleges}
                  isMember={status === 'member'}
                  caps={caps}
                  patchProfile={patchProfile}
                  reloadProfile={() => void reloadProfile()}
                  ownProfile={profile}
                  onMessagePerson={personId => void messagePerson(personId)}
                  onToggleFollow={toggleFollowFor}
                  onOpenMention={openMentionProfile}
                  onOpenHashtag={openHashtagSearch}
                  onSignOut={signOut}
                  onOpenPost={openComments}
                  onCreatePost={kind => { openComposer(kind) }}
                />
              : activeNav === 'Communities'
                ? <Communities
                    identity={identity && user ? { id: user.id, name: identity.name, username: identity.username, initials: identity.initials } : null}
                    configured={configured}
                    colleges={colleges}
                    myCollegeId={profile?.college_id ?? null}
                    requireAuth={requireAuth}
                    notify={flash}
                    onOpenMention={openMentionProfile}
                    openCommunityId={openCommunityId}
                    setOpenCommunityId={id => {
                      if (id && id !== openCommunityIdRef.current) setCommunityTab(null)
                      setOpenCommunityId(id)
                      if (!id) setCommunityTab(null)
                    }}
                    onCommunityTabChange={tab => setCommunityTab(tab)}
                    restoreCommunityTab={communityTab}
                  />
              : activeNav === 'Events'
                ? <Events
                    identity={identity && user ? { id: user.id, name: identity.name, username: identity.username, initials: identity.initials } : null}
                    configured={configured}
                    colleges={colleges}
                    myCollegeId={profile?.college_id ?? null}
                    requireAuth={requireAuth}
                    notify={flash}
                    openEventSlug={openEventSlug}
                    setOpenEventSlug={setOpenEventSlug}
                    onOpenCommunity={clubId => { setActiveNav('Communities'); setOpenCommunityId(clubId); setCommunityTab(null) }}
                  />
                : activeNav === 'Marketplace'
                ? <Marketplace
                    identity={identity && user ? { id: user.id, name: identity.name, username: identity.username, initials: identity.initials } : null}
                    configured={configured}
                    colleges={colleges}
                    myCollegeId={profile?.college_id ?? null}
                    requireAuth={requireAuth}
                    notify={flash}
                    openListingSlug={openListingSlug}
                    setOpenListingSlug={setOpenListingSlug}
                    onContactSeller={messageListing}
                    onOpenProfile={openMentionProfile}
                  />
                : activeNav === 'Bookmarks'
                  ? <Bookmarks
                      key="bookmarks"
                      identity={identity && user ? { id: user.id, name: identity.name, username: identity.username, initials: identity.initials } : null}
                      configured={configured}
                      requireAuth={requireAuth}
                      notify={flash}
                      onGoDiscover={() => navigate('Discover')}
                    />
                : activeNav === 'My College'
                  ? <MyCollege
                      key="mycollege"
                      identity={identity && user ? { id: user.id, name: identity.name, username: identity.username, initials: identity.initials, college: identity.college } : null}
                      configured={configured}
                      status={status}
                      isStaff={isStaff}
                      colleges={colleges}
                      caps={caps}
                      myCollegeId={profile?.college_id ?? null}
                      following={following}
                      posts={posts}
                      pollStateMap={pollStateMap}
                      confessionPatch={confessPatch}
                      requireAuth={requireAuth}
                      notify={flash}
                      feedLoading={feedLoading}
                      feedSource={feedSource}
                      feedError={feedError}
                      reloadFeed={() => void loadFeed()}
                      onVote={votePoll}
                      onLike={toggleLike}
                      onSave={toggleSave}
                      onComment={openComments}
                      onShare={sharePost}
                      onReport={openReport}
                      onRepost={toggleRepost}
                      onEdit={startEditPost}
                      onDelete={setDeleteTarget}
                      onMessage={messageAuthor}
                      onRelation={setRelation}
                      onOpenProfile={openMentionProfile}
                      onOpenTag={openHashtagSearch}
                      onToggleFollow={toggleFollowFor}
                      openConfessionsPage={openConfessionsPage}
                      onOpenComposer={kind => openComposer(kind)}
                      onNavigate={navigate}
                      onOpenEvent={slug => { navigate('Events'); setOpenEventSlug(slug) }}
                      onOpenCommunity={clubId => { navigate('Communities'); setOpenCommunityId(clubId); setCommunityTab(null) }}
                      onOpenListing={slug => { navigate('Marketplace'); setOpenListingSlug(slug) }}
                      onContactSeller={messageListing}
                      onProfilePatched={() => void reloadProfile()}
                    />
                : activeNav === 'Leaderboard'
                  ? <Leaderboard
                      key="leaderboard"
                      identity={identity && user ? { id: user.id, name: identity.name, username: identity.username, initials: identity.initials } : null}
                      configured={configured}
                      requireAuth={requireAuth}
                      notify={flash}
                      onOpenProfile={openMentionProfile}
                    />
                : activeNav === 'Notifications'
                  ? <NotificationCenter
                      key="notifications"
                      identity={identity && user ? { id: user.id, name: identity.name, username: identity.username, initials: identity.initials } : { id: '', name: '', username: '', initials: '' }}
                      configured={configured}
                      notify={flash}
                      collegeId={profile?.college_id ?? null}
                      liveTick={notifTick}
                      onCountsChanged={() => setBellRefetch(n => n + 1)}
                      onOpenChat={conversationId => {
                        setOpenChatId(conversationId)
                        setChatAutoSeq(n => n + 1)
                        navigate('Chats')
                      }}
                      onOpenProfile={openMentionProfile}
                    />
                : infoNav.includes(activeNav)
              ? <InfoPage name={activeNav}/>
              : activeNav === 'Staff Console'
                ? isStaff
                  ? <StaffConsole flash={flash}/>
                  : <SectionPage name="Staff Console" onCreate={openComposer} onSignIn={() => setAuthMode('signup')} isMember={status === 'member'} displayName={identity.name}/>
              : activeNav === 'Advertising'
                ? isStaff
                  ? <AdsAdmin flash={flash}/>
                  : <SectionPage name="Advertising" onCreate={openComposer} onSignIn={() => setAuthMode('signup')} isMember={status === 'member'} displayName={identity.name}/>
                : <SectionPage name={activeNav} onCreate={openComposer} onSignIn={() => setAuthMode('signup')} isMember={status === 'member'} displayName={identity.name} />}
      </main>

      <aside className="right-sidebar">
        <section className="right-panel trends-panel">
          <h2><TrendingUp size={17}/> Trending on Campus</h2>
          {trends.length === 0 ? (
            <p className="panel-hint">
              {trendsPending
                ? 'Reading the latest posts…'
                : 'No trends yet — hashtags used in real posts will chart here.'}
            </p>
          ) : (
            <>
              {trends.slice(0, showAllTrends ? trends.length : 5).map(([tag, count]) => (
                <button className="trend-row" key={tag} onClick={() => { setActiveNav('Home'); setSearchSeed(tag); setSearchOpen(true) }}>
                  <b>#{tag}</b>
                  <span>{count >= 1000 ? `${(count / 1000).toFixed(1)}K posts` : count === 1 ? '1 post' : `${count} posts`}</span>
                </button>
              ))}
              <button className="see-more" onClick={() => setShowAllTrends(value => !value)}>
                {showAllTrends ? 'Show fewer trends' : 'Show more trends'} <ArrowLeft size={14}/>
              </button>
            </>
          )}
        </section>

        <section className="right-panel follow-panel">
          <h2>Who to follow</h2>
          {status !== 'member' ? (
            <p className="panel-hint">Join CAMPUS to get follow suggestions from your campus.</p>
          ) : followPicks.length === 0 ? (
            <p className="panel-hint">
              {followPicksPending
                ? 'Looking for classmates…'
                : 'No suggestions yet — they appear here as more classmates join.'}
            </p>
          ) : (
            followPicks.map(person => {
              const initials = db.initialsFor(person.name, person.username)
              return (
                <div className="suggestion" key={person.username}>
                  <button
                    className="suggestion-link"
                    onClick={() => void openMentionProfile(person.id)}
                    aria-label={`Open ${person.name}'s profile`}
                  >
                    <span className="avatar">{initials}</span>
                    <span className="suggestion-copy"><b>{person.name}</b><small>@{person.username}</small></span>
                  </button>
                  <button
                    className={`follow-button ${following.includes(person.username) ? 'is-following' : ''}`}
                    aria-label={following.includes(person.username) ? 'Following' : 'Follow'}
                    onClick={() => toggleFollow(person.username)}
                  >
                    {following.includes(person.username) ? <Check size={15}/> : 'Follow'}
                  </button>
                </div>
              )
            })
          )}
        </section>

        <button className="advertise-panel" onClick={() => { if (isStaff) navigate('Advertising'); else flash('Advertising on CAMPUS is managed by the campus admin team.') }}><span><Megaphone size={17}/> Advertise on CAMPUS</span><small>{isStaff ? 'Manage sponsored campaigns, college targeting and analytics.' : 'First-party sponsored posts, delivered by college targeting.'}</small></button>

        <footer className="right-footer">
          <div className="footer-links">
            {infoNav.map(label => (
              <button key={label} onClick={() => navigate(label)}>{label}</button>
            ))}
          </div>
          <small>CAMPUS · Built for students, by students. © 2026</small>
        </footer>
      </aside>

      {!(dmThread && isMobileViewport()) && (
        <nav className="mobile-bottom-nav">
          <button className={activeNav==='Home'?'active':''} onClick={() => navigate('Home')}><Home size={21}/><span>Home</span></button>
          <button className={activeNav==='Discover'?'active':''} onClick={() => navigate('Discover')}><Compass size={21}/><span>Discover</span></button>
          <button className="mobile-create" aria-label="Create" onClick={() => openComposer()}><Plus size={28}/></button>
          <button className={activeNav==='Chats'?'active':''} onClick={() => navigate('Chats')}><MessageCircle size={21}/><span>Chats{status !== 'member' && <i className="unread-dot"/>}</span></button>
          <button className={activeNav==='Profile'?'active':''} onClick={() => navigate('Profile')}><UserRound size={21}/><span>Profile</span></button>
        </nav>
      )}

      {composer && <div className="overlay" onMouseDown={e => {if(e.target===e.currentTarget)setComposer(false)}}><section className="bottom-sheet composer-sheet" ref={el => { composerDismiss.current?.(); composerDismiss.current = el ? attachSheetDismiss(el, () => setComposer(false)) : null }}><div className="sheet-handle"/><div className="sheet-heading"><div><span className="eyebrow">SHARE WITH YOUR CAMPUS</span><h2>Create {composerKind === 'confession' ? 'a confession' : composerKind === 'poll' ? 'a poll' : composerKind === 'reel' ? 'a reel' : 'a post'}</h2></div><button className="icon-button" onClick={() => setComposer(false)} aria-label="Close composer"><X size={20}/></button></div>
        <div className="composer-kind-row">{([{kind:'post' as PostKind,label:'Post',icon:Image,style:'purple'},{kind:'reel' as PostKind,label:'Reel',icon:Clapperboard,style:'pink'},{kind:'poll' as PostKind,label:'Poll',icon:ChartNoAxesColumn,style:'orange'},{kind:'confession' as PostKind,label:'Confess',icon:BookOpen,style:'dark'}]).map(item=><button key={item.kind} className={`kind-option ${composerKind===item.kind?'chosen':''}`} onClick={() => handleKindSelect(item.kind)}><span className={`kind-icon ${item.style}`}><item.icon size={22}/></span><b>{item.label}</b></button>)}</div>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder={composerKind==='confession'?'Share anonymously with your college…':composerKind==='poll'?'Ask your campus a question…':'What’s happening on campus?'} maxLength={500}/>
        {(composerKind === 'post') && (
          <div className="sheet-media-row">
            {draftImages.length > 0 && (
              <div className="carousel-picker">
                {imageThumbs.map((thumb, index) => (
                  <button key={thumb.url} className="picker-thumb" onClick={() => removeComposerImage(index)} aria-label={`Remove image ${index + 1}`}>
                    <img src={thumb.url} alt="" />
                    <X size={14} />
                  </button>
                ))}
                <label className="picker-thumb picker-thumb-more" role="button" tabIndex={0} aria-label="Add more images"
                  onClick={() => imagesInputRef.current?.click()}>
                  <span><X size={16} style={{ transform: 'rotate(45deg)' }}/></span>
                </label>
              </div>
            )}
            {draftImages.length === 0 && <p className="media-hint">Tap <b>Post</b> above to pick images — they will post as a swipeable carousel.</p>}
            {draftImages.length > 1 && <p className="carousel-hint">Swipe-through carousel, {draftImages.length} images ready.</p>}
          </div>
        )}
        {(composerKind === 'reel') && (
          <div className="sheet-media-row reel-picker">
            {draftVideo ? (
              <div className="reel-ready">
                <b>{draftVideo.name}</b>
                <span>{reelDuration > 0 && `· ${media.formatClipTime(reelDuration)} video`}</span>
                {videoTrim ? (
                  <span className="trim-chip">✂ Trimmed: {media.formatClipTime(videoTrim.end - videoTrim.start)} clip (from {media.formatClipTime(videoTrim.start)})</span>
                ) : reelDuration > media.REEL_WINDOW_SECONDS ? (
                  <button className="attach-button trim-needed" onClick={() => setTrimOpen(true)}>✂ Trim to 30s — required</button>
                ) : (
                  <span>CAMPUS compresses it automatically before upload.</span>
                )}
                <span className="reel-ready-actions">
                  <button className="attach-button" onClick={() => setTrimOpen(true)} disabled={reelDuration === 0}>Change trim</button>
                  <button className="attach-button ghost" onClick={() => { setDraftVideo(null); setVideoTrim(null); setReelDuration(0) }}>Remove</button>
                </span>
              </div>
            ) : (
              <p className="media-hint">Tap <b>Reel</b> above to choose a video (MP4 / WebM). Longer than 30 seconds? The reel trimmer opens automatically.</p>
            )}
            {publishProgress && <span className="media-progress">{publishProgress}</span>}
          </div>
        )}
        {composerKind === 'poll' && (
          <div className="poll-composer-block">
            <span className="poll-field-label" id="poll-options-label">Answer options <i>(2–6, all different)</i></span>
            {pollOptions.map((value, index) => (
              <div className="poll-option-row" key={index}>
                <input
                  value={value}
                  onChange={e => setPollOptions(current => current.map((v, i) => i === index ? e.target.value : v))}
                  placeholder={index < 2 ? `Option ${index + 1} (required)` : `Option ${index + 1}`}
                  maxLength={120}
                  aria-labelledby="poll-options-label"
                  aria-label={`Answer option ${index + 1}`}
                />
                {pollOptions.length > 2 && (
                  <button className="icon-button" aria-label={`Remove option ${index + 1}`}
                    onClick={() => setPollOptions(current => current.length <= 2 ? current : current.filter((_, i) => i !== index))}>
                    <X size={15}/>
                  </button>
                )}
              </div>
            ))}
            {pollOptions.length < 6 && (
              <button className="poll-add-option" onClick={() => setPollOptions(current => [...current, ''])}>
                <Plus size={14}/> Add option
              </button>
            )}
            <div className="poll-settings-row">
              <label className="poll-check">
                <input type="checkbox" checked={pollMultiple} onChange={e => setPollMultiple(e.target.checked)} aria-label="Allow multiple choices"/>
                <span>Multiple choices allowed</span>
              </label>
              <label className="poll-length">
                <span>Poll length</span>
                <select value={pollDays} onChange={e => setPollDays(Number(e.target.value))} aria-label="Poll duration">
                  <option value={1}>1 day</option>
                  <option value={3}>3 days</option>
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                </select>
              </label>
            </div>
            {pollErrors.length > 0 && <p className="poll-error" role="alert">{pollErrors[0]}</p>}
          </div>
        )}
        <div className="sheet-helper">{composerKind==='confession'?'Your identity will be hidden in the feed.':composerKind==='poll'?'Single choice by default — set multiple choices and the poll length below.':'Keep it kind. Your campus is listening.'}<span>{draft.length}/500</span></div>
        <div className="sheet-actions"><button className="secondary-button" onClick={() => setComposer(false)}>Cancel</button><button className="primary-button" disabled={publishing} onClick={() => void createPost()}><Send size={16}/>{publishing ? (publishProgress || (composerKind === 'poll' ? 'Publishing poll…' : 'Posting…')) : composerKind === 'poll' ? ' Publish poll' : ' Publish'}</button></div>
      </section></div>}

      {/* Persistent media pickers: tapping Post/Reel in the composer opens the
          device gallery directly (user gesture works from anywhere). */}
      <input ref={imagesInputRef} type="file" hidden multiple accept="image/*"
        onChange={e => { void addComposerImages(Array.from(e.target.files ?? [])); e.currentTarget.value = '' }}/>
      <input ref={videoInputRef} type="file" hidden accept="video/*"
        onChange={e => { void pickReelVideo(e.target.files?.[0] ?? null); e.currentTarget.value = '' }}/>

      {editingPost && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setEditingPost(null) }}>
          <section className="bottom-sheet composer-sheet" role="dialog" aria-label="Edit post" ref={el => { editDismiss.current?.(); editDismiss.current = el ? attachSheetDismiss(el, () => setEditingPost(null)) : null }}>
            <div className="sheet-handle"/>
            <div className="sheet-heading"><div><span className="eyebrow">YOUR POST</span><h2>Edit post</h2></div><button className="icon-button" onClick={() => setEditingPost(null)} aria-label="Close editor"><X size={20}/></button></div>
            {editingPost.media && editingPost.media.length > 0 && (
              <p className="media-hint">{editingPost.kind === 'reel' ? 'The reel video stays as it is — text captions can be edited.' : `${editingPost.media.length} image${editingPost.media.length > 1 ? 's' : ''} stay as they are — text can be edited here.`}</p>
            )}
            <textarea value={editDraft} onChange={e => setEditDraft(e.target.value)} maxLength={500} rows={4} autoFocus/>
            <div className="sheet-helper">{editingPost.anonymous ? '' : 'Your post keeps its original timestamp, plus an edited marker.'}<span>{editDraft.length}/500</span></div>
            <div className="sheet-actions">
              <button className="secondary-button" onClick={() => setEditingPost(null)}>Cancel</button>
              <button className="primary-button" disabled={editBusy} onClick={() => void saveEditedPost()}><Pencil size={15}/>{editBusy ? ' Saving…' : ' Save changes'}</button>
            </div>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setDeleteTarget(null) }}>
          <section className="bottom-sheet confirm-sheet" role="dialog" aria-label="Delete post" ref={el => { confirmDismiss.current?.(); confirmDismiss.current = el ? attachSheetDismiss(el, () => setDeleteTarget(null)) : null }}>
            <div className="sheet-handle"/>
            <div className="sheet-heading"><div><span className="eyebrow">DELETE POST</span><h2>Delete this post?</h2></div><button className="icon-button" onClick={() => setDeleteTarget(null)} aria-label="Cancel delete"><X size={20}/></button></div>
            <p className="confirm-copy">“{deleteTarget.body.slice(0, 120)}{deleteTarget.body.length > 120 ? '…' : ''}”</p>
            <p className="media-hint">This removes the post{deleteTarget.media?.length ? ' and its media' : ''} from CAMPUS for everyone. This cannot be undone.</p>
            <div className="sheet-actions">
              <button className="secondary-button" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="primary-button danger-button" disabled={deleteBusy} onClick={() => void removePost()}><Trash2 size={15}/>{deleteBusy ? ' Deleting…' : ' Delete post'}</button>
            </div>
          </section>
        </div>
      )}

      {commentTarget && (
        <CommentsSheet
          theme="light"
          post={commentTarget}
          userId={user?.id ?? null}
          identity={identity}
          requireAuth={requireAuth}
          onClose={() => setCommentTarget(null)}
          onCountChange={count => {
            setPosts(current => current.map(p => p.id === commentTarget.id ? { ...p, comments: count } : p))
            setConfessPatch({ id: commentTarget.id, comments: count })
          }}
        />
      )}

      {trimOpen && draftVideo ? (
        <ReelTrim
          file={draftVideo}
          onApply={selection => { setVideoTrim(selection); setTrimOpen(false); flash(`Clip selected: ${media.formatClipTime(selection.end - selection.start)}`) }}
          onCancel={() => setTrimOpen(false)}
        />
      ) : null}

      {modals}
    </div>
  )
}

/* ---- System info pages (About · Guidelines · Privacy · Help) --------------- */

const INFO_PAGES: Record<string, {
  icon: typeof Compass
  title: string
  intro: string
  blocks: Array<{ heading: string; paragraphs?: string[]; bullets?: string[] }>
}> = {
  'About': {
    icon: GraduationCap,
    title: 'What CAMPUS is',
    intro: 'CAMPUS is a campus-first social app for college students in India — built to feel like your campus, not the whole internet.',
    blocks: [
      { heading: 'The idea', paragraphs: [
        'Most social apps put you in front of the entire world. CAMPUS starts with the people who actually walk the same corridors: your collegemates first, the wider campus community second.',
        'You explore before you join — the feed, Discover reels and the real campus data are open to visitors, so you know exactly what you are signing up for.',
      ]},
      { heading: 'What works today', bullets: [
        'A real campus feed — text posts, image carousels, short reels (up to 30 seconds)',
        'Replies: comment threads on every kind of post, on the Home feed and on Discover',
        'Anonymous confessions — posted under no name, visible to your campus',
        'Edit and delete your own posts (anonymous confessions stay as posted, by design)',
        'Report and block tools for anything that breaks the rules',
      ]},
      { heading: 'What is on the way', bullets: [
        'Full profile pages with avatars, bios and follow connections',
        'Polls, events, clubs and community spaces backed by real data',
        'Direct chats and notifications',
        'Search and trending beyond the basics',
      ]},
      { heading: 'How it is built', paragraphs: [
        'CAMPUS runs on your real account and real data — every post, reel and reply goes into a live database, and every number on the screen is the real number. Where something is not connected yet, the app says so instead of faking it.',
      ]},
    ],
  },
  'Guidelines': {
    icon: Shield,
    title: 'Campus guidelines',
    intro: 'CAMPUS should feel like the good parts of your campus. These rules apply everywhere in the app — posts, reels, confessions and comments.',
    blocks: [
      { heading: 'Be decent', bullets: [
        'No harassment, threats, hate speech or targeted abuse of any person or group.',
        'Do not abuse the confession feature: no naming or clearly identifying classmates, no spreading rumours about real people, no threats — anonymous is a shield for honesty, not a weapon.',
        'No impersonation: do not post pretending to be another student, professor or organisation.',
      ]},
      { heading: 'Keep it campus-real', bullets: [
        'Post things your campus community can actually use — notes, events, questions, wins, opportunities, honest moments.',
        'No spam. No repeated self-promotion, chain posts or engagement-bait.',
        'No selling dangerous or illegal items in the marketplace — the marketplace is for student-to-student exchange of ordinary goods.',
      ]},
      { heading: 'Media rules', bullets: [
        'No nudity, sexual content, gore, violence or illegal activity in posts, images or reels.',
        'Do not upload media you do not have the right to share (including other people’s private photos).',
        'Reels are limited to 30 seconds; the uploader will ask you to trim longer clips.',
      ]},
      { heading: 'How enforcement works', bullets: [
        'Use Report on any post or comment — reports go straight to the moderation queue.',
        'You can Block or Mute any account from the ⋯ menu on their posts; blocked accounts can no longer interact with you.',
        'Clear violations lead to content removal and account suspension. Serious cases (threats, illegal content) can escalate beyond the app.',
        'Moderation tooling is young and improving — if a report seems unanswered, report again; every report is stored and reviewed.',
      ]},
      { heading: 'Who this protects', paragraphs: [
        'These rules exist to protect students first. When in doubt: if you would not say it with your name to someone’s face in the corridor, do not post it from behind a screen either.',
      ]},
    ],
  },
  'Privacy': {
    icon: EyeOff,
    title: 'Privacy on CAMPUS',
    intro: ' Plain-language version: we store the minimum needed to run your campus account, we never sell it, and confessions stay anonymous in every place a human looks.',
    blocks: [
      { heading: 'What we store', bullets: [
        'Your sign-in email — used for account access and essential emails only.',
        'Your profile: the name, username, bio, course, year, college and avatar you choose to enter.',
        'Your content: posts, reels, comments, likes, bookmarks and blocks.',
        'Reports you file, and the basic technical data needed to keep the service running safely.',
      ]},
      { heading: 'How confessions work under the hood', bullets: [
        'Every confession does have an internal author id — that is what lets us enforce rules if a confession breaks them.',
        'That author id is never shown on screen: to every viewer the post carries no name, no username and no avatar.',
        'You cannot edit or delete a confession once posted, and confession authors never appear in “who to follow”.',
      ]},
      { heading: 'What we do not do', bullets: [
        'We do not sell your data, run third-party ad trackers or build advertising profiles from your activity.',
        'The only advertising on CAMPUS is first-party sponsored posts chosen by your college targeting — no outsiders buy access to your data, and a sponsorship is always labelled as one.',
        'We do not expose your email to other users — profiles show your chosen name and username only.',
        'We do not publish your likes or private lists; they are yours.',
      ]},
      { heading: 'Your controls', bullets: [
        'Delete any of your own posts, images or reels at any time — deletion removes the media file too.',
        'Set your profile private, block or mute anyone, and withdraw from interactions you do not want.',
        'Account deletion and full data-copy requests are handled through the account team — request it from your college admin or the in-app report flow, and it will be completed.',
      ]},
      { heading: 'The honest caveat', paragraphs: [
        'Anything you post publicly can be screenshotted by others. Anonymity and deletion are strong here, but the internet is forever — post like the whole campus can read it, because it can.',
      ]},
    ],
  },
  'Help': {
    icon: CircleHelp,
    title: 'Help & answers',
    intro: ' Quick answers for the features that are live today. Anything not listed here is still being built.',
    blocks: [
      { heading: 'Posting', bullets: [
        'Tap the + button (bottom bar) or “Create post” (sidebar) to post text, an image carousel, a reel or a confession.',
        'Reels must be 30 seconds or shorter — if your clip is longer, the built-in trimmer opens first; pick a window and continue.',
        'Large videos are compressed on your phone before upload, so long clips may take a moment.',
      ]},
      { heading: 'Editing and deleting', bullets: [
        'Use the ⋯ menu on your own post to edit or delete it; edited posts carry a small “edited” badge.',
        'Only you can edit or delete your posts. Anonymous confessions cannot be edited or deleted after posting — that keeps the anonymous trail short and safe for everyone.',
      ]},
      { heading: 'Comments and reactions', bullets: [
        'Every post type supports comments — open the comment sheet from the comment button on any post, including reels in Discover.',
        'You can edit and delete your own comments; deletions ask for confirmation.',
        'Double-tap a reel to like it; likes persist across sessions.',
      ]},
      { heading: 'Safety', bullets: [
        '⋯ menu on any post: report the post, or block/mute its author. Blocks apply immediately.',
        'Reports are reviewed in the moderation queue; add context in the report form to help reviewers.',
      ]},
      { heading: 'Account problems', bullets: [
        'Sign-in uses email + password. Check the confirmation-password match and your email verification when signing up.',
        'Locked out? Profiles and onboarding information are never lost — use the sign-in screen again or a fresh device; your feed and drafts are stored server-side.',
        'If the app shows a database error banner, it is honest — wait a moment and retry; your draft text is kept while the composer stays open.',
      ]},
    ],
  },
}

function InfoPage({ name }: { name: string }) {
  const page = INFO_PAGES[name] ?? INFO_PAGES.About
  const Icon = page.icon
  return (
    <section className="section-page info-page">
      <div className="section-hero-icon"><Icon size={27}/></div>
      <span className="eyebrow">CAMPUS / {name.toUpperCase()}</span>
      <h2>{page.title}</h2>
      <p className="info-intro">{page.intro}</p>
      {page.blocks.map(block => (
        <div className="info-block" key={block.heading}>
          <h3>{block.heading}</h3>
          {block.paragraphs?.map((text, i) => <p key={i}>{text}</p>)}
          {block.bullets && (
            <ul className="info-list">
              {block.bullets.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          )}
        </div>
      ))}
      <div className="coming-note"><Shield size={16}/><span>These pages describe how CAMPUS works today. As features go live, the matching rules are documented here.</span></div>
    </section>
  )
}

function SectionPage({name,onCreate,onSignIn,isMember,displayName}:{name:string;onCreate:(kind?:PostKind)=>void;onSignIn:()=>void;isMember:boolean;displayName:string}) {
  const content:Record<string,{icon:typeof Compass;title:string;desc:string;items:string[]}> = {
    'Discover':{icon:Compass,title:'Find your campus people',desc:'Discover students, conversations and communities from your college and beyond.',items:['Popular near you','New student introductions','Campus conversations']},
    'Campus Pulse':{icon:Sparkles,title:'What’s happening right now?',desc:'A live snapshot of what students are talking about.',items:['Trending discussions','Campus polls','Popular confessions']},
    'Communities':{icon:Users,title:'Find your people',desc:'Join spaces for your interests, courses, hobbies and campus life.',items:['Coding & Technology','Hostel Life','Photography Club']},
    'Events':{icon:CalendarDays,title:'Campus events',desc:'Find fests, workshops, meetups and activities around your college.',items:['Upcoming college fest','Resume review workshop','Robotics club meetup']},
    'Leaderboard':{icon:Trophy,title:'Campus leaderboard',desc:'Celebrate students who bring useful ideas and energy to campus.',items:['Top contributors','Most helpful posts','Community champions']},
    'Opportunities':{icon:BriefcaseBusiness,title:'Your next opportunity',desc:'Internships, placements, competitions and campus openings.',items:['Software Engineering Intern','Campus ambassador','National project competition']},
    'Marketplace':{icon:CircleDollarSign,title:'Student marketplace',desc:'Buy, sell, lend and exchange useful things within your campus.',items:['Engineering calculator','Second-hand textbooks','Cycle available']},
    'Clubs':{icon:BookOpen,title:'Clubs & societies',desc:'Explore campus clubs, join activities and find collaborators.',items:['Robotics Club','Cultural Committee','Developer Student Community']},
    'Chats':{icon:MessageCircle,title:'Your conversations',desc:'Direct messages and group chats help your campus stay connected.',items:['Class group','Robotics Club','Start a new conversation']},
    'Notifications':{icon:Bell,title:'You’re all caught up',desc:'Replies, mentions, follows and campus updates will appear here.',items:['Replies to your posts','New followers','College announcements']},
    'Bookmarks':{icon:Bookmark,title:'Saved for later',desc:'Keep important posts, opportunities and campus updates close.',items:['Saved posts','Saved opportunities','Reading list']},
    'Search':{icon:Search,title:'Search CAMPUS',desc:'Find students, posts, colleges and topics.',items:['Search by name','Browse topics','Explore colleges']},
    'My College':{icon:Building2,title:'Your college, together',desc:'A dedicated space for your college community.',items:['College announcements','Student directory','College clubs']},
    'Profile':{icon:UserRound,title:isMember?displayName:'Your profile',desc:'Your profile, posts, saved items and campus identity live here.',items:['Edit your profile','Your posts','Your connections']},
  }
  const page=content[name]??content.Discover
  const Icon=page.icon
  return <section className="section-page"><div className="section-hero-icon"><Icon size={27}/></div><span className="eyebrow">CAMPUS / {name.toUpperCase()}</span><h2>{page.title}</h2><p>{page.desc}</p>
    <div className="section-quick-actions"><button className="primary-button" onClick={()=>onCreate()}><Plus size={16}/> Create a post</button>{!isMember&&<button className="secondary-button" onClick={onSignIn}>Join CAMPUS</button>}</div>
    <div className="section-list">{page.items.map((item,i)=><button key={item} className="section-list-row" onClick={()=>{}}><span className="section-list-number">0{i+1}</span><span>{item}</span><ArrowLeft size={16}/></button>)}</div>
    <div className="coming-note"><Sparkles size={16}/><span>This screen is scaffolded. Connect its database tables and actions to make it fully live.</span></div>
  </section>
}
