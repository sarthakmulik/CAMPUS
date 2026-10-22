import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, HelpCircle, Info, MessageCircleOff, PencilRuler } from 'lucide-react'
import * as db from '../lib/db'
import type { CampusPost } from '../types'
import PostCard from './PostCard'

export interface ConfessionsProps {
  /** signed-in member identity (null for visitors — the feed itself is open) */
  userId: string | null
  myCollegeId: string | null
  myCollegeShort: string
  /** false = CAMPUS is not connected; the page degrades honestly */
  configured: boolean
  requireAuth: (what: string) => boolean
  notify: (message: string) => void
  /** opens the EXISTING composer in confession mode (source stays Confessions) */
  onShareConfession: () => void
  /** in-app back arrow: the shell pops history OR closes this page itself */
  onBack: () => void
  /** bumps after a confession is published from the composer → reload */
  refreshSeq: number
  /** live count/like patches coming from app-level comment & like flows */
  patch: { id: string; likes?: number; liked?: boolean; comments?: number } | null
  onLike: (post: CampusPost) => void
  onSave: (post: CampusPost) => void
  onComment: (post: CampusPost) => void
  onShare: (post: CampusPost) => void
  onReport: (post: CampusPost) => void
  onRepost: (post: CampusPost) => void
  onBlock: (post: CampusPost) => void
  onMute: (post: CampusPost) => void
  onMessage: (post: CampusPost) => void
  onOpenMention: (profileId: string) => void
  onOpenTag: (query: string) => void
}

const PAGE_SIZE = 20

/** A slim, honest loading placeholder — never seeded with fake content. */
function ConfessionSkeleton() {
  return <div className="post-card conf-skeleton" aria-hidden="true">
    <div className="skeleton-row"/>
    <div className="skeleton-block"/>
    <div className="skeleton-row short"/>
  </div>
}

/**
 * The dedicated Confessions destination (migration 0028). It reuses the
 * existing confession system end to end: the same posts table rows
 * (kind='confession'), the same composer, the same reporting/reactions and
 * the same anonymity guarantee — author columns arrive as NULL from
 * list_confessions(), so no card, tooltip or reply can leak the author.
 */
export default function Confessions({
  userId, myCollegeId, myCollegeShort, configured, requireAuth, notify,
  onShareConfession, onBack, refreshSeq, patch, onLike, onSave, onComment,
  onShare, onReport, onRepost, onBlock, onMute, onMessage, onOpenMention, onOpenTag,
}: ConfessionsProps) {
  const [mode, setMode] = useState<'latest' | 'trending' | 'college'>('latest')
  const [items, setItems] = useState<CampusPost[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const hadCollege = Boolean(myCollegeId)

  /** collect the confessions actually eligible for the chosen filter */
  const load = useCallback(async (sort: 'latest' | 'trending' | 'college', offset: number, replace: boolean) => {
    if (!configured) { setError('CAMPUS is not connected.'); setLoading(false); return }
    if (replace) setLoading(true)
    else setLoadingMore(true)
    try {
      const result = await db.fetchConfessions({
        sort: sort === 'trending' ? 'trending' : 'latest',
        collegeId: sort === 'college' ? myCollegeId : null,
        limit: PAGE_SIZE,
        offset,
      })
      setTotal(result.total)
      setItems(current => {
        const base = replace ? [] : current
        // de-dupe defensively (a fresh confession shifting offsets can never
        // sneak the same post into the list twice)
        const seen = new Set(base.map(p => p.id))
        return [...base, ...result.posts.filter(p => !seen.has(p.id))]
      })
      setError(null)
    } catch (caught) {
      if (replace) setItems([])
      setError(db.friendlyMessage(caught))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [configured, myCollegeId])

  // initial load + every tab switch restarts at the first page
  useEffect(() => {
    void load(mode, 0, true)
  }, [mode, refreshSeq, load])

  // comment / like actions performed at app level translate into these cards
  useEffect(() => {
    if (!patch) return
    setItems(current => current.map(p => p.id === patch.id ? {
      ...p,
      likes: patch.likes ?? p.likes,
      liked: patch.liked ?? p.liked,
      comments: patch.comments ?? p.comments,
    } : p))
  }, [patch])

  const hasMore = items.length < total
  const sharingBegins = () => {
    if (!requireAuth('share a confession')) return
    onShareConfession()
  }

  return <section className="conf-page" aria-label="Confessions">
    <header className="conf-header">
      <button className="icon-button conf-back" aria-label="Back to the feed" onClick={onBack}>
        <ArrowLeft size={20}/>
      </button>
      <div className="conf-titles">
        <h1><MessageCircleOff size={17}/> Confessions</h1>
        <p>Anonymous thoughts. Your campus.</p>
      </div>
      <button className="icon-button conf-info" aria-label="How anonymity works" aria-expanded={noteOpen} onClick={() => setNoteOpen(v => !v)}>
        <HelpCircle size={20}/>
      </button>
    </header>

    {noteOpen && <div className="conf-note" role="note">
      <Info size={14}/>
      <p>Every confession posts under <b>no name</b> — not even CAMPUS shows it. Confessions cannot be edited or deleted after posting, and the author never appears in profiles, chats or suggestions.</p>
    </div>}

    <div className="conf-controls">
      <div className="community-tabs conf-tabs" data-no-page-swipe="true" role="tablist" aria-label="Confession feed filters">
        {([['latest', 'Latest'], ['trending', 'Trending'], ['college', hadCollege ? `My College${myCollegeShort ? ` · ${myCollegeShort}` : ''}` : 'My College']] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={mode === key}
            disabled={key === 'college' && !hadCollege}
            title={key === 'college' && !hadCollege ? 'Pick your college to see campus confessions' : undefined}
            className={`community-tab ${mode === key ? 'on' : ''}`}
            onClick={() => setMode(key)}
          >{label}</button>
        ))}
      </div>
      <button className="conf-share-action" onClick={sharingBegins} aria-label="Share a confession">
        <PencilRuler size={16}/> Share a confession
      </button>
    </div>

    <div className="feed-list conf-feed">
      {error && (
        <div className="feed-status error-card" role="status">
          <b>The confessions feed could not load.</b>
          <p>{error}</p>
          <button className="secondary-button" onClick={() => void load(mode, 0, true)}>Try again</button>
        </div>
      )}
      {loading && <><ConfessionSkeleton/><ConfessionSkeleton/><ConfessionSkeleton/></>}
      {!loading && !error && items.length === 0 && (
        <div className="empty-state conf-empty">
          <MessageCircleOff size={28}/>
          <b>It's quiet here for now.</b>
          <span>Be the first to share a thought with your campus.</span>
          <button className="primary-button small" onClick={sharingBegins}>Share a confession</button>
        </div>
      )}
      {!loading && items.map(item => <PostCard
        key={item.id}
        post={item}
        isOwn={Boolean(userId && item.authorId && item.authorId === userId && !item.anonymous)}
        onLike={() => onLike(item)}
        onSave={() => onSave(item)}
        onComment={() => onComment(item)}
        onShare={() => onShare(item)}
        onReport={() => onReport(item)}
        onRepost={() => onRepost(item)}
        onBlock={() => onBlock(item)}
        onMute={() => onMute(item)}
        onEdit={() => notify('Anonymous confessions cannot be edited — that is what keeps them anonymous.')}
        onDelete={() => notify('Anonymous confessions cannot be deleted after posting — that keeps the anonymous trail short.')}
        onMessage={() => onMessage(item)}
        onOpenMention={onOpenMention}
        onOpenTag={onOpenTag}
      />)}
      {!loading && hasMore && (
        <button className="secondary-button conf-more" disabled={loadingMore} onClick={() => void load(mode, items.length, false)}>
          {loadingMore ? 'Loading…' : `Load more confessions${total ? ` (${items.length} of ${total})` : ''}`}
        </button>
      )}
    </div>
  </section>
}
