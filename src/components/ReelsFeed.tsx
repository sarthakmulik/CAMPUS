import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bookmark, Flag, Heart, MessageCircle, MoreHorizontal,
  Play, Share2, Volume2, VolumeX,
} from 'lucide-react'
import {
  fetchPostById, fetchReels, postLink, toggleLike as dbToggleLike, copyToClipboard, friendlyMessage,
  initialsFor,
} from '../lib/db'
import type { CampusPost } from '../types'
import CommentsSheet from './CommentsSheet'
import type { ShareTarget } from './chat/ShareContentSheet'

type ReelsFeedProps = {
  userId: string | null
  identity: { name: string; username: string; initials: string }
  requireAuth: (reason: string) => boolean
  flash: (message: string) => void
  onReport: (post: CampusPost) => void
  onCreateReel: () => void
  /** tap the author's avatar or name → open their profile (anonymous reels keep the author hidden) */
  onOpenAuthor: (profileId: string) => void
  /** share the reel INTO CAMPUS chats (opens the share sheet) instead of only copying a link */
  onShareContent?: (target: ShareTarget) => void
  /** deep-linked reel id — the stage slides to it (fetching it if needed) */
  autoOpenId?: string | null
  onAutoOpened?: () => void
}

const PAGE_SIZE = 8

/**
 * Discover page: an Instagram-Reels-style vertical feed. One snap-scrolled
 * full-height slide per reel, autoplaying the slide in view, tap to
 * pause/resume, double-tap to like (with a heart burst), right action rail,
 * caption + author overlay and a live progress line — everything reads its
 * numbers from the database (list_public_reels, migration 0004).
 */
export default function ReelsFeed({ userId, identity, requireAuth, flash, onReport, onCreateReel, onOpenAuthor, onShareContent, autoOpenId, onAutoOpened }: ReelsFeedProps) {
  const [reels, setReels] = useState<CampusPost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(true)
  const [activeIndex, setActiveIndex] = useState(0)
  const [moreMenuFor, setMoreMenuFor] = useState<string | null>(null)
  const [commentsFor, setCommentsFor] = useState<CampusPost | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const nextPage = useRef(0)
  const hasMore = useRef(true)
  const fetching = useRef(false)

  const loadPage = useCallback(async () => {
    if (fetching.current) return
    if (!hasMore.current) return
    fetching.current = true
    const offset = nextPage.current * PAGE_SIZE
    try {
      const rows = await fetchReels(PAGE_SIZE, offset)
      nextPage.current += 1
      hasMore.current = rows.length === PAGE_SIZE
      setReels(current => [...current, ...rows.filter(row => !current.some(c => c.id === row.id))])
      setError(null)
    } catch (err) {
      setError(friendlyMessage(err))
      hasMore.current = false
    } finally {
      fetching.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadPage() }, [loadPage])

  // deep link: slide the stage to the shared reel once the list is here;
  // if it is not in the loaded pages, fetch it alone and put it in front.
  useEffect(() => {
    if (!autoOpenId || loading) return
    let cancelled = false
    const scrollToIndex = (index: number) => {
      requestAnimationFrame(() => {
        const stage = stageRef.current
        if (stage) { stage.scrollTop = index * stage.clientHeight; setActiveIndex(index) }
        onAutoOpened?.()
      })
    }
    const existing = reels.findIndex(r => r.id === autoOpenId)
    if (existing >= 0) { scrollToIndex(existing); return }
    void (async () => {
      try {
        const post = await fetchPostById(autoOpenId)
        if (cancelled) return
        if (!post) { flash('That reel is not available — it may have been deleted.'); onAutoOpened?.(); return }
        if (post.kind !== 'reel') { flash('That link points to a post, not a reel.'); onAutoOpened?.(); return }
        setReels(current => current.some(r => r.id === post.id) ? current : [post, ...current])
        scrollToIndex(0)
      } catch (err) {
        if (!cancelled) flash(friendlyMessage(err))
        onAutoOpened?.()
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenId, loading])

  const retry = () => {
    nextPage.current = 0
    hasMore.current = true
    setReels([])
    setLoading(true)
    void loadPage()
  }

  const onStageScroll = () => {
    const stage = stageRef.current
    if (!stage || reels.length === 0) return
    const index = Math.round(stage.scrollTop / stage.clientHeight)
    setActiveIndex(clampInt(index, 0, reels.length - 1))
    if (index >= reels.length - 2) void loadPage()
  }

  const likeReel = async (post: CampusPost, forceLike = false) => {
    if (!userId) { requireAuth('like reels'); return }
    const target = reels.find(r => r.id === post.id)
    if (!target) return
    if (forceLike && target.liked) return // already liked: a double-tap never un-likes
    const nextLiked = forceLike ? true : !target.liked
    setReels(current => current.map(r => r.id === post.id
      ? { ...r, liked: nextLiked, likes: r.likes + (nextLiked ? 1 : -1) }
      : r))
    try {
      await dbToggleLike(post.id, userId, nextLiked)
    } catch (err) {
      setReels(current => current.map(r => r.id === post.id ? { ...r, liked: target.liked, likes: target.likes } : r))
      flash(friendlyMessage(err))
    }
  }

  const openReelComments = (post: CampusPost) => {
    if (!requireAuth('join the conversation')) return
    setCommentsFor(post)
  }

  const saveReel = (post: CampusPost) => {
    if (!requireAuth('bookmark reels')) return
    setReels(current => current.map(r => r.id === post.id ? { ...r, saved: !r.saved } : r))
  }

  /** share: open the CAMPUS share sheet (send into chats) when wired —
   *  otherwise the legacy native-share/clipboard hand-off */
  const shareReel = (post: CampusPost) => {
    if (!requireAuth('share reels')) return
    if (onShareContent) {
      onShareContent({
        kind: 'reel',
        id: post.id,
        title: post.body.trim().slice(0, 110) || 'Reel',
        subtitle: post.anonymous ? 'Anonymous reel' : `by ${post.author}`,
        image: post.media?.[0] ?? null,
      })
      return
    }
    void copyCaption(post)
  }

  const copyCaption = async (post: CampusPost) => {
    if (!requireAuth('share reels')) return
    const url = postLink(post.id)
    const nav = navigator as Navigator & { share?: (data: { title?: string; text?: string; url?: string }) => Promise<void> }
    if (nav.share) {
      try {
        await nav.share({ title: 'CAMPUS', text: post.body.trim() ? `${post.author}: ${post.body.trim().slice(0, 90)}` : `A reel by ${post.author} on CAMPUS`, url })
        return
      } catch {
        // sheet dismissed — fall through to copying the link
      }
    }
    const failure = await copyToClipboard(url)
    flash(failure ?? 'Reel link copied — paste it anywhere to share.')
  }

  if (loading && reels.length === 0) {
    return (
      <div className="reels-stage">
        <div className="reels-status"><div className="reels-spinner" aria-hidden="true"/><span>Loading reels…</span></div>
      </div>
    )
  }

  if (error && reels.length === 0) {
    return (
      <div className="reels-stage">
        <div className="reels-status error">
          <b>Reels could not load.</b>
          <p>{error}</p>
          <button className="reels-retry" onClick={retry}>Try again</button>
        </div>
      </div>
    )
  }

  return (
    <div className="reels-stage" ref={stageRef} onScroll={onStageScroll}>
      {reels.length === 0
        ? <div className="reels-status"><b>No reels yet</b><span>Be the first to post a reel to your campus.</span><button className="reels-retry" onClick={onCreateReel}>Post a reel</button></div>
        : reels.map((post, index) =>
            <ReelSlide
              key={post.id}
              post={post}
              active={index === activeIndex}
              muted={muted}
              onToggleMute={() => setMuted(m => !m)}
              onLikeTap={forceLike => void likeReel(post, forceLike)}
              onToggleLike={() => void likeReel(post)}
              onSave={() => saveReel(post)}
              onComment={() => openReelComments(post)}
              onShare={() => shareReel(post)}
              onReport={() => onReport(post)}
              menuOpen={moreMenuFor === post.id}
              onMenu={() => setMoreMenuFor(current => current === post.id ? null : post.id)}
              onMenuClose={() => setMoreMenuFor(null)}
              onOpenAuthor={onOpenAuthor}
            />
          )}
      {loading && reels.length > 0 && <div className="reels-loading-more"><div className="reels-spinner small" aria-hidden="true"/></div>}

      {commentsFor && (
        <CommentsSheet
          theme="dark"
          post={commentsFor}
          userId={userId}
          identity={identity}
          requireAuth={requireAuth}
          onClose={() => setCommentsFor(null)}
          onCountChange={count => setReels(current => current.map(r => r.id === commentsFor.id ? { ...r, comments: count } : r))}
        />
      )}
    </div>
  )
}

function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/* -------------------------------------------------------------------------- */

type ReelSlideProps = {
  post: CampusPost
  active: boolean
  muted: boolean
  onToggleMute: () => void
  onLikeTap: (forceLike: boolean) => void
  onToggleLike: () => void
  onSave: () => void
  onComment: () => void
  onShare: () => void
  onReport: () => void
  menuOpen: boolean
  onMenu: () => void
  onMenuClose: () => void
  /** tap the author's avatar or name → open their profile */
  onOpenAuthor: (profileId: string) => void
}

function ReelSlide({
  post, active, muted, onToggleMute, onLikeTap, onToggleLike, onSave,
  onComment, onShare, onReport, menuOpen, onMenu, onMenuClose, onOpenAuthor,
}: ReelSlideProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [bursts, setBursts] = useState<{ id: number; x: number; y: number }[]>([])
  const burstId = useRef(0)
  const lastTap = useRef(0)
  const tapTimer = useRef<number | null>(null)

  const src = post.media && post.media.length > 0 ? post.media[0] : ''
  const initials = post.anonymous ? '' : initialsFor(post.author, post.handle.replace('@', ''))

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (active) {
      video.muted = muted
      const playback = video.play()
      if (playback) playback.catch(() => { /* autoplay blocked until the viewer taps */ })
    } else {
      video.pause()
    }
  }, [active, muted])

  // Pause when the tab is hidden, resume the slide in view when it returns.
  useEffect(() => {
    const onVisibility = () => {
      const video = videoRef.current
      if (!video) return
      if (document.hidden) {
        video.pause()
      } else if (active) {
        video.muted = muted
        const playback = video.play()
        if (playback) playback.catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [active, muted])

  useEffect(() => () => {
    if (tapTimer.current) window.clearTimeout(tapTimer.current)
  }, [])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const spawnBurst = (x: number, y: number) => {
    const id = ++burstId.current
    setBursts(current => [...current, { id, x, y }])
    window.setTimeout(() => setBursts(current => current.filter(burst => burst.id !== id)), 800)
  }

  // Instagram gesture: one tap toggles play/pause (after a short grace
  // period), a quick second tap likes the reel with a heart burst.
  const onVideoTap = (event: React.MouseEvent<HTMLVideoElement>) => {
    const now = Date.now()
    if (now - lastTap.current < 300) {
      if (tapTimer.current) { window.clearTimeout(tapTimer.current); tapTimer.current = null }
      lastTap.current = 0
      const rect = event.currentTarget.getBoundingClientRect()
      spawnBurst(event.clientX - rect.left, event.clientY - rect.top)
      onLikeTap(true)
      if (!playing) togglePlay()
    } else {
      lastTap.current = now
      if (tapTimer.current) window.clearTimeout(tapTimer.current)
      tapTimer.current = window.setTimeout(togglePlay, 300)
    }
  }

  const onTimeUpdate = () => {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration) || video.duration === 0) return
    setProgress(video.currentTime / video.duration * 100)
  }

  const stop = (event: React.MouseEvent) => event.stopPropagation()

  return (
    <div className="reel-slide" onClick={onMenuClose}>
      <div
        className="reel-frame"
        tabIndex={0}
        onKeyDown={event => {
          if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); togglePlay() }
        }}
      >
        {src
          ? <video
              ref={videoRef}
              className="reel-slide-video"
              src={src}
              preload="metadata"
              loop
              playsInline
              muted={muted}
              onTimeUpdate={onTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={onVideoTap}
            />
          : <div className="reel-video-missing"><span>This reel has no video file.</span></div>}

        {!playing && src && <span className="reel-big-play" aria-hidden="true"><Play size={30}/></span>}

        {bursts.map(burst => (
          <span key={burst.id} className="reel-heart-burst" style={{ left: burst.x, top: burst.y }} aria-hidden="true">
            <Heart size={92} fill="currentColor"/>
          </span>
        ))}

        {/* legibility gradients, top and bottom */}
        <div className="reel-shade top" aria-hidden="true"/>
        <div className="reel-shade" aria-hidden="true"/>

        {/* top bar: mute */}
        <div className="reel-top" onClick={stop}>
          <button className="reel-mute" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <VolumeX size={16}/> : <Volume2 size={16}/>}
          </button>
        </div>

        {/* right action rail */}
        <div className="reel-rail" onClick={stop}>
          <div className="reel-rail-item">
            <button className={post.liked ? 'liked' : ''} onClick={onToggleLike} aria-label={`Like reel (${post.likes})`}>
              <Heart size={27} fill={post.liked ? 'currentColor' : 'none'}/>
            </button>
            <span>{post.likes}</span>
          </div>
          <div className="reel-rail-item">
            <button onClick={onComment} aria-label={`Replies (${post.comments})`}>
              <MessageCircle size={26}/>
            </button>
            <span>{post.comments}</span>
          </div>
          <div className="reel-rail-item">
            <button onClick={onShare} aria-label="Share reel"><Share2 size={25}/></button>
          </div>
          <div className="reel-rail-item">
            <button className={post.saved ? 'saved' : ''} onClick={onSave} aria-label="Save reel">
              <Bookmark size={25} fill={post.saved ? 'currentColor' : 'none'}/>
            </button>
          </div>
          <div className="reel-rail-item">
            <button onClick={onMenu} aria-label="More options"><MoreHorizontal size={26}/></button>
          </div>
        </div>

        {menuOpen && (
          <div className="reel-more-pop" onClick={stop}>
            <button onClick={onReport}><Flag size={15}/> Report reel</button>
            <button onClick={onShare}><Share2 size={15}/> Share reel link</button>
          </div>
        )}

        {/* caption + author overlay */}
        <div className="reel-info" onClick={stop}>
          <button
            className={`reel-info-avatar reel-author-link ${post.anonymous ? 'anonymous' : ''}`}
            onClick={() => { if (!post.anonymous && post.authorId) onOpenAuthor(post.authorId) }}
            aria-label={post.anonymous ? 'Anonymous reel' : `Open ${post.author}'s profile`}
            tabIndex={post.anonymous || !post.authorId ? -1 : 0}
          >
            {post.anonymous ? '😳' : initials}
          </button>
          <div className="reel-meta">
            <div className="reel-meta-line">
              <button
                className="reel-author-link reel-author-name"
                onClick={() => { if (!post.anonymous && post.authorId) onOpenAuthor(post.authorId) }}
                aria-label={post.anonymous ? 'Anonymous reel' : `Open ${post.author}'s profile`}
                tabIndex={post.anonymous || !post.authorId ? -1 : 0}
              >
                {post.anonymous ? 'Anonymous' : post.author}
              </button>
              {post.college && <span className="reel-college-chip">{post.college}</span>}
              <span className="reel-time">{post.time}</span>
              {post.editedAt && <span className="reel-time">· edited</span>}
            </div>
            {post.body && <p className="reel-caption">{post.body}</p>}
          </div>
        </div>

        <div className="reel-progressline" aria-hidden="true"><i style={{ width: `${progress}%` }}/></div>
      </div>
    </div>
  )
}
