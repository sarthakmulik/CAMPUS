import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bookmark, BookmarkCheck, CalendarDays, Compass, FileText, Link2, Loader2,
  MessageCircle, Play, Search, ShoppingCart, X,
} from 'lucide-react'
import * as bk from '../lib/bookmarks'
import { SAVED_KIND_LABEL } from '../lib/bookmarks'
import type { SavedFilter, SavedItem, SavedKind } from '../lib/bookmarks'
import { relativeTime } from '../lib/db'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
  onGoDiscover: () => void
}

const FILTERS: { key: SavedFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'post', label: 'Posts' },
  { key: 'reel', label: 'Reels' },
  { key: 'event', label: 'Events' },
  { key: 'resource', label: 'Resources' },
  { key: 'listing', label: 'Marketplace' },
]

const PAGE_SIZE = 12

type Row = { item: SavedItem; key: string }

/**
 * The Saved page (nav label "Bookmarks"): one private place where everything
 * the member bookmarked across CAMPUS lives together — newest save first,
 * filterable by kind, searchable, deeplinkable, removable.
 *
 * The list is a real server read (list_saved_items, migration 0026): opening
 * the page always reflects what is actually persisted for this account, and
 * visibility rules are re-enforced per row server-side. The shared savedStore
 * keeps the bookmark icons on other surfaces in sync at the same moment.
 */
export default function Bookmarks({ identity, configured, requireAuth, notify, onGoDiscover }: Props) {
  const [filter, setFilter] = useState<SavedFilter>('all')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [cursor, setCursor] = useState<bk.SavedPage['next']>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [everLoaded, setEverLoaded] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const requestId = useRef(0)
  const firstLoadDone = useRef(false)
  /** a local removal already updated the list; its store change must not trigger a refetch (which would reset pagination) */
  const suppressRefetch = useRef(false)

  /** search debounce — typing never fires a request per keystroke */
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(input.trim()), 350)
    return () => window.clearTimeout(timer)
  }, [input])

  const fetchPage = useCallback(async (replace: boolean, nextCursor: bk.SavedPage['next']) => {
    const id = ++requestId.current
    if (replace) setLoading(true)
    else setLoadingMore(true)
    setError(null)
    try {
      const result = await bk.fetchSavedPage(filter, query, replace ? null : nextCursor)
      if (requestId.current !== id) return
      setRows(current => {
        const fresh = result.items.map(item => ({ item, key: `${item.kind}:${item.id}:${item.savedAt}` }))
        if (replace) return fresh
        const seen = new Set(current.map(row => row.key))
        return [...current, ...fresh.filter(row => !seen.has(row.key))]
      })
      setCursor(result.next)
      setEverLoaded(true)
      firstLoadDone.current = true
    } catch (err) {
      if (requestId.current !== id) return
      setRows([])
      setEverLoaded(false)
      firstLoadDone.current = false
      setError(err instanceof Error ? err.message : 'Could not load your saved items.')
    } finally {
      if (requestId.current === id) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [filter, query])

  /** initial load + every filter / search change */
  useEffect(() => {
    if (!configured || !identity) return
    void fetchPage(true, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, identity?.id, filter, query])

  /** a save added from anywhere else in the app (while this page is open)
      refreshes the list; local removals skip it (they updated the row already) */
  useEffect(() => {
    const unsubscribe = bk.subscribeToStore(() => {
      if (!firstLoadDone.current || suppressRefetch.current) {
        suppressRefetch.current = false
        return
      }
      void fetchPage(true, null)
    })
    return unsubscribe
  }, [fetchPage])

  const remove = async (row: Row) => {
    if (!identity) { requireAuth('save items', 'Bookmarks'); return }
    setRemoving(row.key)
    suppressRefetch.current = true
    // optimistic: the row disappears immediately; the shared store flag flips
    // with it, so every bookmark icon elsewhere updates in the same moment
    setRows(current => current.filter(r => r.key !== row.key))
    try {
      await bk.toggleSaved(row.item.kind, row.item.id)
    } catch (err) {
      // rollback: nothing was persisted, put the row back in save order
      setRows(current => {
        if (current.some(r => r.key === row.key)) return current
        const next = [...current, row]
        next.sort((a, b) => new Date(b.item.savedAt).getTime() - new Date(a.item.savedAt).getTime())
        return next
      })
      notify(err instanceof Error ? err.message : 'Could not remove the saved item. Try again.')
    } finally {
      setRemoving(null)
      suppressRefetch.current = false
    }
  }

  const open = (item: SavedItem) => {
    if (typeof window === 'undefined') return
    // the same deep links the share system produces — the app's hashchange
    // handler resolves them with the content's own visibility rules
    const slug = typeof item.payload?.slug === 'string' ? item.payload.slug : ''
    if (item.kind === 'event' && slug) { window.location.hash = `#e/${encodeURIComponent(slug)}`; return }
    if (item.kind === 'listing' && slug) { window.location.hash = `#m/${encodeURIComponent(slug)}`; return }
    if ((item.kind === 'post' || item.kind === 'reel')) { window.location.hash = `#p/${encodeURIComponent(item.id)}`; return }
    const clubSlug = typeof item.payload?.club_slug === 'string' ? item.payload.club_slug : ''
    if (item.kind === 'resource' && clubSlug) { window.location.hash = `#c/${encodeURIComponent(clubSlug)}`; return }
    notify('This item no longer has an openable location.')
  }

  if (!configured) {
    return (
      <div className="bk-page">
        <header className="bk-head">
          <h1 className="page-title">Saved</h1>
        </header>
        <div className="bk-state"><Bookmark size={30}/><b>Saved items are offline</b><span>CAMPUS is not connected to the server right now.</span></div>
      </div>
    )
  }

  const nothingMatched = !loading && !error && rows.length === 0

  return (
    <div className="bk-page">
      <header className="bk-head">
        <h1 className="page-title">Saved</h1>
        <p className="bk-sub">Your private collection — nobody else can see what you save.</p>
      </header>

      <div className="community-searchbar bk-search">
        <Search size={18}/>
        <input
          value={input}
          onChange={event => setInput(event.target.value)}
          placeholder="Search your saved items"
          aria-label="Search saved items"
        />
        {input && (
          <button className="icon-button" onClick={() => setInput('')} aria-label="Clear search">
            <X size={16}/>
          </button>
        )}
      </div>

      <nav className="community-tabs bk-tabs" data-no-page-swipe="true" aria-label="Saved item types">
        {FILTERS.map(item => (
          <button
            key={item.key}
            className={filter === item.key ? 'on' : ''}
            onClick={() => setFilter(item.key)}
            aria-current={filter === item.key ? 'true' : undefined}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {loading && (
        <div className="bk-grid" aria-hidden="true">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="bk-card skeleton-card" key={index}>
              <div className="skeleton-block bk-thumb-skeleton"/>
              <div className="skeleton-lines">
                <div className="skeleton-block w60"/>
                <div className="skeleton-block w90"/>
                <div className="skeleton-block w40"/>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="bk-state" role="alert">
          <Bookmark size={28}/>
          <b>Could not load your saved items</b>
          <span>{error}</span>
          <button className="secondary-button" onClick={() => { void fetchPage(true, null) }}>Try again</button>
        </div>
      )}

      {nothingMatched && everLoaded && (
        filter === 'all' && !query ? (
          <div className="bk-state">
            <Bookmark size={34}/>
            <b>Nothing saved yet</b>
            <span>Tap the bookmark icon on any post, event, reel, resource or listing while you browse — it will wait for you here.</span>
            <button className="primary-button" onClick={onGoDiscover}><Compass size={15}/> Discover CAMPUS</button>
          </div>
        ) : (
          <div className="bk-state">
            <Bookmark size={26}/>
            <b>{query ? 'No matching saved items' : `No saved ${filterLabel(filter).toLowerCase()}s yet`}</b>
            {query ? (
              <>
                <span>Nothing you saved matches “{query}”.</span>
                <button className="secondary-button" onClick={() => setInput('')}>Clear search</button>
              </>
            ) : (
              <>
                <span>You have saved items in other categories.</span>
                <button className="secondary-button" onClick={() => setFilter('all')}>Show all saved items</button>
              </>
            )}
          </div>
        )
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="bk-grid">
          {rows.map(row => (
            <SavedCard
              key={row.key}
              row={row}
              busy={removing === row.key}
              onRemove={() => { void remove(row) }}
              onOpen={() => open(row.item)}
            />
          ))}
        </div>
      )}

      {!loading && !error && cursor && rows.length > 0 && (
        <div className="community-more">
          <button onClick={() => { void fetchPage(false, cursor) }} disabled={loadingMore}>
            {loadingMore ? <Loader2 size={16} className="spin"/> : null}
            Show older saves
          </button>
        </div>
      )}
    </div>
  )
}

function filterLabel(key: SavedFilter): string {
  return key === 'all' ? 'Items' : SAVED_KIND_LABEL[key as SavedKind]
}

/* -------------------------------------------------------------------------- */
/* One saved-item card                                                         */
/* -------------------------------------------------------------------------- */

function SavedCard({
  row, busy, onRemove, onOpen,
}: {
  row: Row
  busy: boolean
  onRemove: () => void
  onOpen: () => void
}) {
  const item = row.item
  const payload = item.payload ?? {}
  const kindIcon =
    item.kind === 'event' ? <CalendarDays size={22}/> :
    item.kind === 'resource' ? <FileText size={22}/> :
    item.kind === 'listing' ? <ShoppingCart size={22}/> :
    item.kind === 'reel' ? <Play size={22}/> : <MessageCircle size={22}/>

  return (
    <article className="bk-card" data-kind={item.kind}>
      <button className="bk-open" onClick={onOpen} aria-label={`Open ${SAVED_KIND_LABEL[item.kind]} — ${titleOf(item)}`}>
        <div className="bk-thumb">{thumbOf(item, payload, kindIcon)}</div>
        <div className="bk-body">
          <div className="bk-topline">
            <span className="bk-kind">{SAVED_KIND_LABEL[item.kind]}</span>
            <span className="bk-time">Saved {relativeTime(item.savedAt)}</span>
          </div>
          <b className="bk-title">{titleOf(item)}</b>
          <p className="bk-subtext">{subtitleOf(item, payload)}</p>
          <div className="bk-meta">
            {metaOf(item, payload).map(chip => <span className="chip" key={chip}>{chip}</span>)}
          </div>
        </div>
      </button>
      <button
        className="icon-button bk-remove"
        onClick={onRemove}
        aria-label={`${busy ? 'Removing' : 'Remove this saved item'}`}
        disabled={busy}
      >
        {busy ? <Loader2 size={16} className="spin"/> : <BookmarkCheck size={18}/>}
      </button>
    </article>
  )
}

function text(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  return typeof value === 'string' ? value : ''
}

function titleOf(item: SavedItem): string {
  const payload = item.payload ?? {}
  if (item.kind === 'event' || item.kind === 'listing' || item.kind === 'resource') {
    const raw = text(payload, 'title').trim()
    return raw || `${SAVED_KIND_LABEL[item.kind]}`
  }
  const body = text(payload, 'body').trim()
  return body ? body.slice(0, 140) : 'Post'
}

function subtitleOf(item: SavedItem, payload: Record<string, unknown>): string {
  switch (item.kind) {
    case 'post':
    case 'reel': {
      const author = payload.anonymous ? 'Anonymous' : text(payload, 'author_name') || 'Student'
      const body = text(payload, 'body').trim()
      const snippet = body.length > 120 ? `${body.slice(0, 120)}…` : body
      if (snippet && snippet !== titleOf(item)) return `${author} · ${snippet}`
      const college = text(payload, 'college')
      return college ? `${author} · ${college}` : author
    }
    case 'resource': {
      const fileName = text(payload, 'file_name')
      if (fileName) return fileName
      const uploader = text(payload, 'uploader_name')
      return uploader ? `Shared by ${uploader}` : text(payload, 'club_name')
    }
    case 'event':
      return [text(payload, 'venue'), text(payload, 'city')].filter(Boolean).join(', ') || 'Saved event'
    default: {
      // listing: decided-by-owner meta beats a description retell
      const college = text(payload, 'college_name')
      const owner = text(payload, 'owner_name')
      return [owner && owner !== 'null' ? `by ${owner}` : '', college].filter(Boolean).join(' · ') || 'Marketplace listing'
    }
  }
}

function metaOf(item: SavedItem, payload: Record<string, unknown>): string[] {
  const chips: string[] = []
  if (item.kind === 'event') {
    if (typeof payload.starts_at === 'string' && payload.starts_at) {
      const at = new Date(payload.starts_at)
      chips.push(at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
    }
    chips.push(text(payload, 'format').replace('offline', 'In person').replace('online', 'Online').replace('hybrid', 'Hybrid'))
    if (payload.cancelled_at) chips.push('Cancelled')
    else if (typeof payload.registered_count === 'number' && payload.registered_count > 0) chips.push(`${payload.registered_count} registered`)
  }
  if (item.kind === 'listing') {
    const price = payload.price
    chips.push(typeof price === 'number' && price > 0 ? `₹${price}` : 'Free')
    chips.push(text(payload, 'status') === 'sold' ? 'Sold' : text(payload, 'condition'))
  }
  if (item.kind === 'resource') {
    if (payload.has_file) chips.push('File')
    else chips.push('Link')
    const size = payload.file_size
    if (typeof size === 'number' && size > 0) chips.push(`${Math.max(1, Math.round(size / 1024))} KB`)
  }
  if (item.kind === 'reel') chips.push('Reel')
  if (item.kind === 'post' && typeof payload.comment_count === 'number' && payload.comment_count > 0) {
    chips.push(`${payload.comment_count} comment${payload.comment_count === 1 ? '' : 's'}`)
  }
  if (text(payload, 'college_name')) chips.push(text(payload, 'college_name'))
  return chips.filter(Boolean)
}

function thumbOf(item: SavedItem, payload: Record<string, unknown>, icon: JSX.Element) {
  // 1) the real image when the content has one
  const media = payload.media ?? payload.image ?? payload.cover
  if (typeof media === 'string' && media) {
    return <img src={media} alt="" loading="lazy"/>
  }
  // 2) resource file: type-tinted icon tile; link-only: link tile
  if (item.kind === 'resource') {
    if (payload.has_file) return <span className="bk-fallback resource">{icon}</span>
    return <span className="bk-fallback linklink"><Link2 size={22}/></span>
  }
  // 3) branded, per-kind gradient tile otherwise
  return <span className={`bk-fallback ${item.kind}`}>{icon}</span>
}
