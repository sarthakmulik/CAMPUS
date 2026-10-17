import { useEffect, useMemo, useLayoutEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import {
  Home, Compass, Sparkles, Users, CalendarDays, Trophy, BriefcaseBusiness,
  CircleDollarSign, BookOpen, MessageCircle, Bell, Bookmark, Search, Building2,
  Shield, Plus, Image, ChartNoAxesColumn, Clapperboard, Heart, MessageSquare,
  Repeat2, Share2, Flag, MoreHorizontal, X, Send, ChevronDown, TrendingUp,
  Settings, LogOut, UserRound, Check, Hash, Menu, ArrowLeft, CircleHelp,
  GraduationCap, Megaphone, SlidersHorizontal, EyeOff, VolumeX, AlertCircle,
  Pencil, Trash2
} from 'lucide-react'
import { AuthProvider, hasSeenWelcome, markWelcomeSeen, useAuth } from './lib/auth'
import * as db from './lib/db'
import WelcomeScreen from './components/WelcomeScreen'
import AuthModal, { type AuthMode } from './components/AuthModal'
import SignUpPrompt from './components/SignUpPrompt'
import OnboardingWizard from './components/OnboardingWizard'
import SafetyCentre from './components/SafetyCentre'
import ReelTrim from './components/ReelTrim'
import ReelPlayer from './components/ReelPlayer'
import ReelsFeed from './components/ReelsFeed'
import CommentsSheet from './components/CommentsSheet'
import ReportDialog, { type ReportTarget } from './components/ReportDialog'
import type { CampusPost, PostKind } from './types'
import * as media from './lib/media'
import { REEL_WINDOW_SECONDS } from './lib/media'

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
const trends = [
  ['#FestSeason','12.4K posts'],['#Placements','8.1K posts'],['#Exams','6.7K posts'],
  ['#HostelLife','5.3K posts'],['#Internships','4.9K posts'],['#CampusLife','3.2K posts'],
]
const suggestions = [{name:'Typical Editing',handle:'@test1',initials:'TE'},{name:'Pranav Salunkhe',handle:'@uatta',initials:'PS'}]

/** Pages that only make sense for a signed-in member (visitor gate applies). */
const restrictedNav = ['Chats', 'Notifications', 'Bookmarks']
const allNav = [...navItems.map(item => item.label), 'Profile']

/** The four primary pages reachable by horizontal swipe on mobile. */
const swipePageOrder = ['Home', 'Discover', 'Chats', 'Profile']
const scaffoldNav = allNav.filter(label => !['Home', 'Discover', 'Search', 'Safety Centre'].includes(label))

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

/** Pages already reachable from the persistent mobile chrome (bottom nav +
 * header icons), so they are dropped from the mobile drawer to avoid duplicates. */
const navOnMainUi = ['Home', 'Discover', 'Chats', 'Notifications', 'Search']

function CAMPUSApp() {
  const auth = useAuth()
  const { user, profile, status, configured, colleges, requireAuth, notify, gateInfo, closeGate, profileError, reloadProfile } = auth

  const [activeNav, setActiveNav] = useState('Home')
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

  // Stable, revoked-on-change object URLs for the carousel previews.
  const imageThumbs = useMemo(
    () => draftImages.map(file => ({ file, url: URL.createObjectURL(file) })),
    [draftImages],
  )
  useEffect(() => () => { imageThumbs.forEach(thumb => URL.revokeObjectURL(thumb.url)) }, [imageThumbs])
  const [composerKind, setComposerKind] = useState<PostKind>('post')
  const [draft, setDraft] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)
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

  const flash = (message: string) => {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3200)
  }

  /* ---- signed-in member context ---------------------------------------- */

  const identity = useMemo(() => {
    const name = profile?.display_name?.trim() || user?.email?.split('@')[0] || 'CAMPUS member'
    const username = profile?.username || (user?.email ? user.email.split('@')[0] : '')
    const initials = name.split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase() || 'CM'
    const college = colleges.find(item => item.id === profile?.college_id)?.short_name
      ?? colleges[0]?.short_name
      ?? 'SPPU'
    return { name, username, initials, college, handle: username ? `@${username}` : '@campus' }
  }, [profile, user, colleges])

  const activeCollege = useMemo(
    () => colleges.find(item => item.id === profile?.college_id) ?? colleges[0] ?? null,
    [colleges, profile?.college_id],
  )

  // Apply saved blocks/mutes to the local feed for a signed-in member.
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

  const visiblePosts = useMemo(() => {
    let result = [...posts]
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
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(p => `${p.author} ${p.body} ${p.college} ${p.tag ?? ''}`.toLowerCase().includes(q))
    }
    return result
  }, [posts, feedTab, following, blockedHandles, mutedHandles, searchQuery, identity.college])

  /* ---- gated actions (visitors get the sign-up prompt) ----------------- */

  const toggleLike = async (id: string) => {
    if (!requireAuth('react to posts')) return
    // Optimistic flip, then a real write. Any failure is rolled back and
    // reported — the count on screen always matches the database.
    const target = posts.find(p => p.id === id)
    if (!target) return
    setPosts(current => current.map(p => p.id === id ? { ...p, liked: !p.liked, likes: p.likes + (p.liked ? -1 : 1) } : p))
    if (feedSource === 'db' && user) {
      try {
        await db.toggleLike(id, user.id, !target.liked)
      } catch (error) {
        setPosts(current => current.map(p => p.id === id ? { ...p, liked: target.liked, likes: target.likes } : p))
        notify(db.friendlyMessage(error))
      }
    }
  }
  const toggleSave = (id: string) => {
    if (!requireAuth('bookmark posts')) return
    setPosts(current => current.map(p => p.id === id ? { ...p, saved: !p.saved } : p))
  }
  const toggleRepost = (id: string) => {
    if (!requireAuth('repost to your campus')) return
    setPosts(current => current.map(p => p.id === id ? { ...p, reposted: !p.reposted, reposts: p.reposts + (p.reposted ? -1 : 1) } : p))
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
  const openReport = (post: CampusPost) => {
    if (!requireAuth('report content')) return
    setReportTarget({
      label: post.anonymous ? 'this confession' : 'this post',
      postId: post.id,
      excerpt: post.body.slice(0, 160),
    })
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

  const createPost = async () => {
    if (!requireAuth('create posts, polls and confessions')) return
    if (!draft.trim()) { flash('Write something before posting.'); return }
    if (composerKind === 'poll') {
      flash('Polls are not connected to the database yet — share your question as a regular post for now.')
      return
    }
    setPublishing(true)
    try {
      const body = draft.trim()

      let mediaUrls: string[] | null = null
      if (composerKind === 'post' && draftImages.length) {
        const uploaded: string[] = []
        for (const image of draftImages) {
          uploaded.push(await db.uploadMedia(user!.id, image))
          setPublishProgress(`Uploading image ${uploaded.length} of ${draftImages.length}…`)
        }
        mediaUrls = uploaded
      }
      if (composerKind === 'reel') {
        if (!draftVideo) {
          flash('Select a video to post a reel.')
          return
        }
        // Videos over 30 s must be trimmed first: the trimmer opens
        // automatically and Publish stays blocked until a window is picked.
        if (reelDuration > REEL_WINDOW_SECONDS + 0.05 && !videoTrim) {
          flash('Trim your reel to 30 seconds first — open the clip timeline and pick a window.')
          setTrimOpen(true)
          return
        }
        const trimWindow = videoTrim ?? { start: 0, end: Math.min(reelDuration || REEL_WINDOW_SECONDS, REEL_WINDOW_SECONDS) }
        const keepSeconds = Math.min(Math.max(trimWindow.end - trimWindow.start, 0.3), REEL_WINDOW_SECONDS)
        setPublishProgress('Compressing video…')
        const compressed = await media.compressVideo({
          file: draftVideo,
          start: trimWindow.start,
          keepSeconds,
          onProgress: progress => {
            if (progress.phase === 'encoding') setPublishProgress(`Compressing ${progress.percent}%…`)
            else setPublishProgress('Uploading video…')
          },
        })
        setPublishProgress('Uploading video…')
        mediaUrls = [await db.uploadMedia(user!.id, compressed)]
      }

      const result = await publishPostCore(body, composerKind, mediaUrls)
      if (result === 'error') return // composer stays open, draft intact
      setDraft(''); setDraftImages([]); setDraftVideo(null); setVideoTrim(null)
      setComposer(false)
      flash(composerKind === 'confession'
        ? 'Confession posted to the campus feed — your name stays hidden.'
        : 'Posted to the campus feed.')
    } catch (error) {
      // Media processing or a database failure: the composer stays open with
      // the draft intact.
      flash(db.friendlyMessage(error))
    } finally {
      setPublishing(false)
      setPublishProgress(null)
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
    setActiveNav(label)
    if (label === 'Search') setSearchOpen(true)
    if (scaffoldNav.includes(label)) flash(`${label} is coming soon.`)
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
  const [slideDir, setSlideDir] = useState<'none' | 'from-right' | 'from-left'>('none')

  // restore each page's scroll depth synchronously before paint (mobile only —
  // the pages now scroll inside .main-column, so the window never scrolls and
  // the browser toolbar — and with it the fixed bottom nav — can never move)
  useLayoutEffect(() => {
    if (!window.matchMedia('(max-width: 650px)').matches) return
    const scroller = mainRef.current
    if (!scroller) return
    const saved = pageScrollMemory.current[activeNav]
    scroller.scrollTop = typeof saved === 'number' ? saved : 0
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
      if (target.closest?.('input, textarea, select, .overlay, .bottom-sheet, .post-menu, .reel-more-pop, .carousel-track, .carousel-dots, .picker-thumb, .mobile-bottom-nav')) {
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
    cleanupRef.current = () => {
      main.removeEventListener('touchstart', onSwipeStart)
      main.removeEventListener('touchmove', onSwipeMove)
      main.removeEventListener('touchend', finishOrCancel)
      main.removeEventListener('touchcancel', finishOrCancel)
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

  const openComposer = (kind: PostKind = 'post'): boolean => {
    if (!requireAuth('create posts, polls and confessions')) return false
    setComposerKind(kind)
    setDraftImages([])
    setDraftVideo(null)
    setVideoTrim(null)
    setTrimOpen(false)
    setPublishProgress(null)
    setComposer(true)
    return true
  }

  /**
   * Shared publish path for the inline composer and the full composer sheet:
   * writes to the posts table when the database is connected, otherwise keeps
   * the post on this device and says exactly that.
   */
  const publishPostCore = async (
    body: string,
    kind: PostKind,
    mediaUrls: string[] | null,
    onProgress?: (message: string) => void,
  ): Promise<'posted' | 'error'> => {
    const anonymous = kind === 'confession'
    const collegeRow = colleges.find(c => c.id === profile?.college_id) ?? colleges[0]
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
        })
        if (profile?.college_id == null) {
          flash('Posted — but pick your college in the onboarding step so your campus can find it.')
        }
        setPosts(current => [post, ...current])
        setActiveNav('Home'); setFeedTab('For You')
        return 'posted'
      } catch (error) {
        flash(db.friendlyMessage(error))
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
    setInlineOpen(true)
  }

  const publishInlinePost = async () => {
    if (!inlineDraft.trim()) { flash('Write something before posting.'); return }
    setInlineBusy(true)
    const result = await publishPostCore(inlineDraft.trim(), 'post', null)
    setInlineBusy(false)
    if (result === 'posted') {
      setInlineDraft('')
      setInlineOpen(false)
      flash('Posted to the campus feed.')
    }
  }

  /** Switching composer type starts the media selection fresh. */
  const changeComposerKind = (kind: PostKind) => {
    if (kind === composerKind) return
    setComposerKind(kind)
    setDraftImages([])
    setDraftVideo(null)
    setVideoTrim(null)
    setPublishProgress(null)
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
  }

  const removeComposerImage = (index: number) => {
    setDraftImages(current => current.filter((_, i) => i !== index))
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

  const modals = (
    <>
      {toast}
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
    </>
  )

  if (auth.booting) {
    return (
      <div className="boot-screen">
        <span className="brand-mark large">C</span>
        <p>Opening your campus…</p>
        {toast}
      </div>
    )
  }

  if (profileError) {
    return (
      <div className="boot-screen">
        <span className="brand-mark large">C</span>
        <h2>We could not load your profile.</h2>
        <p className="form-error" role="alert"><AlertCircle size={15} /> {profileError}</p>
        <div className="wizard-actions inline">
          <button className="secondary-button" onClick={() => void auth.signOut()}>Sign out</button>
          <button className="primary-button" onClick={() => void reloadProfile()}>Try again</button>
        </div>
      </div>
    )
  }

  if (status === 'onboarding') {
    return (
      <>
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
    <div className="app-shell">
      <header className="mobile-header">
        <div className="mobile-header-left">
          <button className="icon-button" aria-label="Menu" onClick={() => setMobileMenu(true)}><Menu size={21}/></button>
          <button className="brand-mini" onClick={() => navigate('Home')}><span className="brand-mark">C</span><b>CAMPUS</b></button>
        </div>
        <div className="mobile-header-actions">
          <button className="icon-button" aria-label="Search" onClick={() => setSearchOpen(v => { if (v) setSearchQuery(''); return !v })}><Search size={21}/></button>
          <button className="icon-button" aria-label="Notifications" onClick={() => navigate('Notifications')}><Bell size={21}/></button>
        </div>
      </header>

      <aside ref={attachSidebarRef} className={`left-sidebar ${mobileMenu ? 'mobile-open' : ''}`}>
        <button className="icon-button sidebar-close" aria-label="Close menu" onClick={() => setMobileMenu(false)}><X size={20}/></button>
        <button className="brand" onClick={() => navigate('Home')}><span className="brand-mark">C</span><span>CAMPUS</span></button>
        <div className="sidebar-campus-card">
          <div className="sidebar-campus-art"><Building2 size={28}/><span>{activeCollege?.short_name ?? 'SPPU'}</span></div>
          <div className="sidebar-campus-info"><b>{activeCollege?.short_name ?? 'SPPU'}</b><small>{activeCollege?.name ?? 'Savitribai Phule Pune University'}</small></div>
          <button onClick={() => navigate('My College')}>Change college <ArrowLeft size={13}/></button>
        </div>
        <nav className="primary-nav">
          {navItems.map(({label, icon: Icon}) => (
            <button key={label} className={`nav-item ${activeNav === label ? 'active' : ''} ${label === 'My College' ? 'nav-labelled' : ''} ${navOnMainUi.includes(label) ? 'nav-on-main-ui' : ''}`} onClick={() => navigate(label)} title={label}>
              <Icon size={21} strokeWidth={activeNav === label ? 2.4 : 2}/><span>{label}</span>
            </button>
          ))}
        </nav>
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

        {searchOpen && <div className="search-bar"><Search size={18}/><input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search posts, people, topics…" autoFocus/><button onClick={() => {setSearchOpen(false);setSearchQuery('')}} aria-label="Close search"><X size={18}/></button></div>}
        {activeNav === 'Home' ? <>
          <div className="desktop-topbar"><div className="desktop-search-trigger" onClick={() => setSearchOpen(true)} role="button" tabIndex={0}><Search size={18}/><span>Search for people, posts, colleges, clubs...</span></div><div className="topbar-actions"><button className="icon-button" aria-label="Notifications" onClick={() => navigate('Notifications')}><Bell size={20}/><i className="notification-dot"/></button><button className="icon-button" aria-label="My profile" onClick={() => navigate('Profile')}><UserRound size={20}/></button></div></div>
          <section className="campus-hero-banner"><div className="hero-copy"><span className="hero-eyebrow">YOUR PEOPLE. YOUR PLACE.</span><h2>Same Campus,<br/><em>Bigger Dreams.</em></h2><span className="hero-swish"/><p>Connect · Share · Grow</p></div><div className="hero-campus-art" aria-hidden="true"><div className="art-sun"/><div className="art-building"><span/><span/><span/><span/><b/></div><div className="art-hill"/></div><button className="college-pill" onClick={() => navigate('My College')}><span className="college-seal"><Building2 size={22}/></span><span><b>{activeCollege?.short_name ?? 'SPPU'}</b><small>{activeCollege?.name ?? 'Savitribai Phule Pune University'}</small></span><ChevronDown size={16}/></button></section>
          <div className="feed-tabs" role="tablist">
            {['For You','Following','My College','Trending','Latest'].map(tab => <button key={tab} role="tab" aria-selected={feedTab===tab} className={feedTab===tab?'selected':''} onClick={() => setFeedTab(tab)}>{tab}</button>)}
          </div>
          <div className="feature-row">
            <button className="feature-card leaderboard" onClick={() => navigate('Leaderboard')}><Trophy size={18}/><b>Not ranked yet</b><span>Post to get on the board</span></button>
            <button className="feature-card confessions" onClick={() => openComposer('confession')}><BookOpen size={18}/><b>Confessions</b><span>Anonymous, campus-only</span></button>
          </div>
          <p className="campus-presence">2 students from {identity.college} are on CAMPUS</p>
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
                      <button aria-label="Create event" onClick={() => { navigate('Events'); flash('Event creation can be connected in the next backend pass.') }}><CalendarDays size={18}/></button>
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
                    <button aria-label="Create event" onClick={() => { navigate('Events'); flash('Event creation can be connected in the next backend pass.') }}><CalendarDays size={18}/></button>
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
            {visiblePosts.length ? visiblePosts.map(post => <PostCard
              key={post.id}
              post={post}
              isOwn={Boolean(user && post.authorId && post.authorId === user.id && !post.anonymous)}
              onLike={() => void toggleLike(post.id)}
              onSave={() => toggleSave(post.id)}
              onComment={() => openComments(post)}
              onShare={() => copyPost(post.body)}
              onReport={() => openReport(post)}
              onRepost={() => toggleRepost(post.id)}
              onBlock={() => void setRelation('user_blocks', post)}
              onMute={() => void setRelation('user_mutes', post)}
              onEdit={() => startEditPost(post)}
              onDelete={() => setDeleteTarget(post)}
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
              />
            : <SectionPage name={activeNav} onCreate={openComposer} onSignIn={() => setAuthMode('signup')} isMember={status === 'member'} displayName={identity.name} />}
      </main>

      <aside className="right-sidebar">
        <section className="right-panel trends-panel"><h2><TrendingUp size={17}/> Trending on Campus</h2>{trends.map(([tag,count])=><button className="trend-row" key={tag} onClick={() => {setActiveNav('Home');setSearchOpen(true);setSearchQuery(tag.replace('#',''))}}><b>{tag}</b><span>{count}</span></button>)}<button className="see-more" onClick={() => {setActiveNav('Home');setFeedTab('Trending')}}>Show more trends <ArrowLeft size={14}/></button></section>
        <section className="right-panel follow-panel"><h2>Who to follow</h2>{suggestions.map(person=><div className="suggestion" key={person.handle}><span className="avatar">{person.initials}</span><span className="suggestion-copy"><b>{person.name}</b><small>{person.handle}</small></span><button className={`follow-button ${following.includes(person.handle)?'is-following':''}`} aria-label={following.includes(person.handle)?'Following':'Follow'} onClick={() => toggleFollow(person.handle)}>{following.includes(person.handle)?<Check size={15}/>: 'Follow'}</button></div>)}</section>
        <button className="advertise-panel" onClick={() => flash('Campus advertising tools can be added as an admin feature.')}><span><Megaphone size={17}/> Advertise on CAMPUS</span><small>Reach students at one college. Flat monthly pricing.</small></button>
        <footer className="right-footer">About · Guidelines · Privacy · Help<br/>CAMPUS · Built for students, by students. © 2026</footer>
      </aside>

      <nav className="mobile-bottom-nav">
        <button className={activeNav==='Home'?'active':''} onClick={() => navigate('Home')}><Home size={21}/><span>Home</span></button>
        <button className={activeNav==='Discover'?'active':''} onClick={() => navigate('Discover')}><Compass size={21}/><span>Discover</span></button>
        <button className="mobile-create" aria-label="Create" onClick={() => openComposer()}><Plus size={28}/></button>
        <button className={activeNav==='Chats'?'active':''} onClick={() => navigate('Chats')}><MessageCircle size={21}/><span>Chats{status !== 'member' && <i className="unread-dot"/>}</span></button>
        <button className={activeNav==='Profile'?'active':''} onClick={() => navigate('Profile')}><UserRound size={21}/><span>Profile</span></button>
      </nav>

      {composer && <div className="overlay" onMouseDown={e => {if(e.target===e.currentTarget)setComposer(false)}}><section className="bottom-sheet composer-sheet"><div className="sheet-handle"/><div className="sheet-heading"><div><span className="eyebrow">SHARE WITH YOUR CAMPUS</span><h2>Create {composerKind === 'confession' ? 'a confession' : composerKind === 'poll' ? 'a poll' : composerKind === 'reel' ? 'a reel' : 'a post'}</h2></div><button className="icon-button" onClick={() => setComposer(false)} aria-label="Close composer"><X size={20}/></button></div>
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
        <div className="sheet-helper">{composerKind==='confession'?'Your identity will be hidden in the feed.':composerKind==='poll'?'Poll options will be enabled when the polls backend is connected.':'Keep it kind. Your campus is listening.'}<span>{draft.length}/500</span></div>
        <div className="sheet-actions"><button className="secondary-button" onClick={() => setComposer(false)}>Cancel</button><button className="primary-button" disabled={publishing} onClick={() => void createPost()}><Send size={16}/>{publishing ? (publishProgress || 'Posting…') : ' Publish'}</button></div>
      </section></div>}

      {/* Persistent media pickers: tapping Post/Reel in the composer opens the
          device gallery directly (user gesture works from anywhere). */}
      <input ref={imagesInputRef} type="file" hidden multiple accept="image/*"
        onChange={e => { void addComposerImages(Array.from(e.target.files ?? [])); e.currentTarget.value = '' }}/>
      <input ref={videoInputRef} type="file" hidden accept="video/*"
        onChange={e => { void pickReelVideo(e.target.files?.[0] ?? null); e.currentTarget.value = '' }}/>

      {editingPost && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setEditingPost(null) }}>
          <section className="bottom-sheet composer-sheet" role="dialog" aria-label="Edit post">
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
          <section className="bottom-sheet confirm-sheet" role="dialog" aria-label="Delete post">
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
          onCountChange={count => setPosts(current => current.map(p => p.id === commentTarget.id ? { ...p, comments: count } : p))}
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

function PostCard({post,isOwn,onLike,onSave,onComment,onShare,onReport,onRepost,onBlock,onMute,onEdit,onDelete}:{post:CampusPost;isOwn:boolean;onLike:()=>void;onSave:()=>void;onComment:()=>void;onShare:()=>void;onReport:()=>void;onRepost:()=>void;onBlock:()=>void;onMute:()=>void;onEdit:()=>void;onDelete:()=>void}) {
  const [menuOpen,setMenuOpen] = useState(false)
  const [slide,setSlide] = useState(0)
  const slides = post.media ?? []
  const canActOnAuthor = Boolean(post.handle) && !post.anonymous
  const trackRef = useRef<HTMLDivElement | null>(null)
  const onTrackScroll = () => {
    const track = trackRef.current
    if (!track || slides.length < 2) return
    const index = Math.round(track.scrollLeft / track.clientWidth)
    setSlide(index > slides.length - 1 ? slides.length - 1 : index < 0 ? 0 : index)
  }
  const goSlide = (index: number) => {
    setSlide(index)
    const track = trackRef.current
    if (track) track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' })
  }
  const mediaBlock = slides.length === 1 ? (
    post.kind === 'reel'
      ? <ReelPlayer src={slides[0]} />
      : <img className="post-media" src={slides[0]} alt="" loading="lazy"/>
  ) : slides.length > 1 ? (
    <div className="carousel" role="group" aria-label="Image carousel">
      <div className="carousel-track" ref={trackRef} onScroll={onTrackScroll}>
        {slides.map(url => <img key={url} src={url} alt="" loading="lazy" draggable={false}/>)}
      </div>
      {slides.length > 1 && <div className="carousel-dots">{slides.map((url, index) => <button key={url} className={index === slide ? 'on' : ''} onClick={() => goSlide(index)} aria-label={`Image ${index + 1} of ${slides.length}`}/>)}</div>}
      {slides.length > 1 && <>
        <button className="carousel-arrow left" onClick={() => goSlide(Math.max(0, slide - 1))} aria-label="Previous image" disabled={slide === 0}>‹</button>
        <button className="carousel-arrow right" onClick={() => goSlide(Math.min(slides.length - 1, slide + 1))} aria-label="Next image" disabled={slide === slides.length - 1}>›</button>
      </>}
    </div>
  ) : null
  return <article className="post-card">
    <div className={`avatar post-avatar ${post.anonymous?'anonymous-avatar':''}`}>{post.anonymous?<BookOpen size={21}/>:post.initials}</div>
    <div className="post-content">
      <div className="post-head"><div className="post-author-line"><b>{post.author}</b>{post.handle&&<span>{post.handle}</span>}<i>·</i><span>{post.time}</span>{post.editedAt&&<><i>·</i><span className="edited-marker">edited {db.relativeTime(post.editedAt)}</span></>}{post.college&&<><i>·</i><span>{post.college}</span></>}</div><button className="icon-button more-button" onClick={() => setMenuOpen(v=>!v)} aria-label="More options"><MoreHorizontal size={20}/></button>{menuOpen&&<div className="post-menu">{isOwn&&<button onClick={()=>{onEdit();setMenuOpen(false)}}><Pencil size={15}/> Edit post</button>}{isOwn&&<button className="danger" onClick={()=>{onDelete();setMenuOpen(false)}}><Trash2 size={15}/> Delete post</button>}<button onClick={()=>{onReport();setMenuOpen(false)}}><Flag size={15}/> Report post</button><button onClick={()=>{onShare();setMenuOpen(false)}}><Share2 size={15}/> Copy post text</button>{canActOnAuthor&&<button onClick={()=>{onMute();setMenuOpen(false)}}><VolumeX size={15}/> Mute {post.handle}</button>}{canActOnAuthor&&<button onClick={()=>{onBlock();setMenuOpen(false)}}><EyeOff size={15}/> Block {post.handle}</button>}</div>}</div>
      {(post.trending || post.anonymous || post.tag) && <div className="post-badges">{post.trending&&<span className="badge trending-badge"><Sparkles size={12}/> Trending</span>}{post.anonymous&&<span className="badge confession-badge">😳 Confession</span>}{post.tag&&<span className="badge college-badge">{post.tag}</span>}</div>}
      {slides.length === 0 && <p className="post-body">{post.body}</p>}
      {mediaBlock}
      <div className="post-actions"><button className={post.liked?'liked':''} onClick={onLike} aria-label={`Like post (${post.likes})`}><Heart size={19} fill={post.liked?'currentColor':'none'}/><span>{post.likes}</span></button><button onClick={onComment} aria-label={`Comment (${post.comments})`}><MessageCircle size={19}/><span>{post.comments}</span></button><button className={post.reposted?'reposted':''} onClick={onRepost} aria-label={`Repost (${post.reposts})`}><Repeat2 size={19}/><span>{post.reposts}</span></button><button onClick={onShare} aria-label="Share"><Share2 size={18}/></button><span className="action-spacer"/><button className={post.saved?'saved':''} onClick={onSave} aria-label="Bookmark"><Bookmark size={19} fill={post.saved?'currentColor':'none'}/></button><button onClick={onReport} aria-label="Report"><Flag size={18}/></button></div>
      {slides.length > 0 && <p className="post-body post-caption">{post.body}</p>}
    </div>
  </article>
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
