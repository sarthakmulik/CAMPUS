import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { popSubviewEntry } from '../lib/navHistory'
import {
  Bookmark, BookmarkCheck, Building2, ChevronRight, Clock, Loader2,
  Package, Plus, RotateCcw, Search, SlidersHorizontal, X,
} from 'lucide-react'
import * as mk from '../lib/marketplace'
import * as bk from '../lib/bookmarks'
import * as db from '../lib/db'
import type { ListingSummary, ListingScope, ListingSort } from '../lib/marketplace'
import ListingDetail from './ListingDetail'
import CreateListingWizard from './CreateListingWizard'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  colleges: db.College[]
  myCollegeId: string | null
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
  openListingSlug: string | null
  setOpenListingSlug: (slug: string | null) => void
  onContactSeller: (sellerId: string, listingTitle: string) => void
  onOpenProfile: (profileId: string) => void
}

const TABS = [
  'Discover', 'My College', 'Popular', 'Newest', 'Books', 'Electronics',
  'Free', 'My Listings', 'Saved',
] as const
type Tab = typeof TABS[number]

const PAGE_SIZE = 24

const EMPTY_COPY: Record<Tab, string> = {
  Discover: 'Nothing listed here yet — be the first to list something useful.',
  'My College': 'No listings from your college yet. List the first one!',
  Popular: 'No saved listings yet — save the ones you like and they will show up here.',
  Newest: 'Nothing has been listed yet. Your first listing could be right here.',
  Books: 'No books listed yet — that calculator-linked textbook could be yours.',
  Electronics: 'No electronics listed yet — headphones, keyboards, monitors…',
  Free: 'No free items listed yet. Free stuff moves fast, so check back soon.',
  'My Listings': 'You have not listed anything yet. Sell an Item to get started.',
  Saved: 'You have not saved anything yet — tap the bookmark on any listing.',
}

/** Gradient placeholder for a card without a photo — deterministic per category. */
function categoryGradient(category: string): string {
  let hash = 0
  for (const ch of category) hash = (hash * 31 + ch.charCodeAt(0)) % 100000
  const hue = hash % 360
  return `linear-gradient(135deg, hsl(${hue} 68% 26%), hsl(${(hue + 42) % 360} 62% 16%))`
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function ListingCard({ row, onOpen, onToggleSave }: {
  row: ListingSummary
  onOpen: (slug: string) => void
  onToggleSave: (id: string) => Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const price = mk.priceLine(row, 56)
  const scopeLabel = row.audience === 'global' ? 'All colleges' : (row.collegeName ?? 'College listing')

  const toggleSave = async (event: React.MouseEvent) => {
    event.stopPropagation()
    setSaving(true)
    try { await onToggleSave(row.id) } finally { setSaving(false) }
  }

  return (
    <article className="mk-card">
      <button
        className="mk-card-media"
        style={{ background: row.images[0] ? undefined : categoryGradient(row.category) }}
        onClick={() => onOpen(row.slug)}
        aria-label={`View ${row.title}`}
      >
        {row.images[0]
          ? <img src={row.images[0]} alt="" loading="lazy" />
          : <span className="mk-card-placeholder"><Package size={30} /></span>}
        <span className="mk-save" role="button" tabIndex={0} aria-label={row.savedByMe ? 'Remove from saved' : 'Save listing'}
          onClick={toggleSave}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); toggleSave(e as unknown as React.MouseEvent) } }}>
          {row.savedByMe ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
        </span>
        {row.status !== 'active' && (
          <span className={`mk-status ${mk.STATUS_CHIP_CLASSES[row.status]}`}>{mk.STATUS_LABELS[row.status]}</span>
        )}
      </button>
      <div className="mk-card-body">
        <div className="mk-price">{price}</div>
        <button className="mk-card-title" onClick={() => onOpen(row.slug)}>{row.title}</button>
        <div className="mk-chips">
          {row.condition && <span className="mk-chip">{mk.CONDITION_LABELS[row.condition]}</span>}
          <span className="mk-chip mk-chip-soft">{row.category}</span>
          {row.transactionType !== 'for_sale' && (
            <span className="mk-chip mk-chip-soft">{mk.TX_LABELS[row.transactionType]}</span>
          )}
        </div>
        <p className="mk-meta">
          <span className="mk-scope"><Building2 size={12} /> {scopeLabel}</span>
          <span className="mk-time"><Clock size={12} /> {relativeTime(row.createdAt)}</span>
          <span className="mk-owner">{row.ownerName ?? row.ownerUsername}</span>
        </p>
        <div className="mk-card-actions">
          <button className="primary-button small" onClick={() => onOpen(row.slug)}>
            View details <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </article>
  )
}

export default function Marketplace({
  identity, configured, colleges, myCollegeId, requireAuth, notify,
  openListingSlug, setOpenListingSlug, onContactSeller, onOpenProfile,
}: Props) {
  const [tab, setTab] = useState<Tab>('Discover')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [scope, setScope] = useState<ListingScope>('all')
  const [sort, setSort] = useState<ListingSort>('recommended')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [category, setCategory] = useState<string | null>(null)
  const [txType, setTxType] = useState<mk.ListingTxType | null>(null)
  const [condition, setCondition] = useState<mk.ListingCondition | null>(null)
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [college, setCollege] = useState<string | null>(null)
  const [mineStatus, setMineStatus] = useState<mk.ListingStatus | 'all'>('all')

  const [rows, setRows] = useState<ListingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editing, setEditing] = useState<mk.ListingDetail | null>(null)
  const [detailKey, setDetailKey] = useState(0)
  const requestId = useRef(0)
  const rowsRef = useRef<ListingSummary[]>([])

  // The list callbacks read the current rows through this mirror instead of a
  // `rows.length` dependency — depending on the length recreated `load` after
  // every fetch, which refetched page one each time and collapsed "Load more"
  // back to the first page.
  useEffect(() => { rowsRef.current = rows })

  // debounce search input
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 350)
    return () => window.clearTimeout(timer)
  }, [query])

  const effectiveSort: ListingSort = useMemo(() => {
    if (tab === 'Popular') return 'saved'
    if (tab === 'Newest') return 'new'
    return sort
  }, [tab, sort])

  const load = useCallback(async (mode: 'replace' | 'append' = 'replace') => {
    const id = ++requestId.current
    if (mode === 'replace') setLoading(true); else setLoadingMore(true)
    setError(null)
    try {
      const params: mk.ListParams = {
        mode: tab === 'My College' ? 'mycollege' : tab === 'My Listings' ? 'mine' : tab === 'Saved' ? 'saved' : 'discover',
        query: debouncedQuery || undefined,
        category: category ?? (tab === 'Books' ? 'Books & Study Materials' : tab === 'Electronics' ? 'Electronics' : null),
        txType: txType ?? (tab === 'Free' ? 'free' : null),
        condition,
        minPrice: minPrice ? Number(minPrice) : null,
        maxPrice: maxPrice ? Number(maxPrice) : null,
        college,
        scope: tab === 'Discover' ? scope : 'all',
        sort: effectiveSort,
        status: tab === 'My Listings' ? mineStatus : 'all',
        limit: PAGE_SIZE,
        offset: mode === 'append' ? rowsRef.current.length : 0,
      }
      const result = await mk.listListings(params)
      if (id !== requestId.current) return
      const nextRows = mode === 'append' ? [...rowsRef.current, ...result] : result
      rowsRef.current = nextRows
      setRows(nextRows)
    } catch (err) {
      if (id !== requestId.current) return
      setError(err instanceof Error ? err.message : 'The marketplace could not be loaded.')
    } finally {
      if (id === requestId.current) { setLoading(false); setLoadingMore(false) }
    }
  }, [tab, debouncedQuery, category, txType, condition, minPrice, maxPrice, college, scope, effectiveSort, mineStatus])

  useEffect(() => { void load('replace') }, [load])

  const switchTab = (next: Tab) => {
    setTab(next)
    setRows([])
  }

  const toggleSave = useCallback(async (id: string) => {
    try {
      const saved = await mk.toggleSavedListing(id)
      setRows(prev => prev.map(r => (r.id === id
        ? { ...r, savedByMe: saved, savedCount: Math.max(0, r.savedCount + (saved ? 1 : -1)) }
        : r)))
      // mirror into the shared saved store so the Saved page stays in step
      bk.savedStoreSet('listing', id, saved)
      notify(saved ? 'Listing saved — find it under Saved.' : 'Removed from your saved listings.')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not change the saved state.')
    }
  }, [notify])

  const openDetail = (slug: string) => setOpenListingSlug(slug)
  const backToList = () => {
    // pop the listing detail's own history entry (device Back parity)
    if (!popSubviewEntry()) setOpenListingSlug(null)
  }

  // opening a detail — from the grid or a #m/ deep link — must start at the
  // top; the body scroll offset from deep in the grid used to leak into detail
  useEffect(() => {
    if (openListingSlug) window.scrollTo(0, 0)
  }, [openListingSlug])

  const openCreate = () => {
    if (!requireAuth('list an item')) return
    setEditing(null)
    setWizardOpen(true)
  }

  const openEdit = (listing: mk.ListingDetail) => {
    setEditing(listing)
    setWizardOpen(true)
  }

  if (openListingSlug) {
    return (
      <ListingDetail
        key={`${openListingSlug}-${detailKey}`}
        identity={identity}
        configured={configured}
        slug={openListingSlug}
        colleges={colleges}
        myCollegeId={myCollegeId}
        requireAuth={requireAuth}
        notify={notify}
        onBack={backToList}
        onContactSeller={onContactSeller}
        onOpenProfile={onOpenProfile}
        onEdit={openEdit}
        onChanged={() => setDetailKey(k => k + 1)}
      />
    )
  }

  return (
    <main className="mk-page">
      <header className="mk-header">
        <div className="mk-header-text">
          <h1>Campus Marketplace</h1>
          <p>Buy, sell and exchange within your student community.</p>
        </div>
        <button className="primary-button" onClick={openCreate}>
          <Plus size={16} /> Sell an Item
        </button>
      </header>

      <div className="mk-toolbar">
        <label className="mk-search">
          <Search size={15} />
          <input
            type="text"
            placeholder="Search titles, brands, categories…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}
        </label>
        <select
          aria-label="Filter by college"
          className="mk-select"
          value={college ?? ''}
          onChange={e => setCollege(e.target.value || null)}
        >
          <option value="">Any college</option>
          {colleges.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          aria-label="Sort listings"
          className="mk-select"
          value={effectiveSort}
          onChange={e => setSort(e.target.value as ListingSort)}
        >
          <option value="recommended">Recommended</option>
          <option value="new">Newest first</option>
          <option value="price_asc">Price: low to high</option>
          <option value="price_desc">Price: high to low</option>
          <option value="saved">Most saved</option>
        </select>
        <button className="ghost-button" onClick={() => setFiltersOpen(o => !o)}>
          <SlidersHorizontal size={15} /> Filters
        </button>
      </div>

      <nav className="mk-tabs" aria-label="Marketplace sections" data-no-page-swipe="true">
        {TABS.map(t => (
          <button
            key={t}
            className={`mk-tab ${tab === t ? 'on' : ''}`}
            onClick={() => switchTab(t)}
          >{t}</button>
        ))}
      </nav>

      {tab === 'Discover' && (
        <div className="mk-scope-row" role="group" aria-label="Discovery scope">
          {([['all', 'All listings'], ['mine_only', 'My college only'], ['beyond', 'Beyond my college']] as const).map(([value, label]) => (
            <button
              key={value}
              className={`mk-scope ${scope === value ? 'on' : ''}`}
              onClick={() => setScope(value)}
            >{label}</button>
          ))}
        </div>
      )}

      {tab === 'My Listings' && (
        <div className="mk-scope-row" role="group" aria-label="Listing status">
          {(['all', 'active', 'draft', 'reserved', 'sold', 'archived'] as const).map(value => (
            <button
              key={value}
              className={`mk-scope ${mineStatus === value ? 'on' : ''}`}
              onClick={() => setMineStatus(value)}
            >{value === 'all' ? 'All' : mk.STATUS_LABELS[value]}</button>
          ))}
        </div>
      )}

      {filtersOpen && (
        <div className="mk-filters">
          <label className="mk-filter-field">
            <span>Category</span>
            <select value={category ?? ''} onChange={e => setCategory(e.target.value || null)}>
              <option value="">All categories</option>
              {mk.MARKET_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="mk-filter-field">
            <span>Type</span>
            <select value={txType ?? ''} onChange={e => setTxType((e.target.value || null) as mk.ListingTxType | null)}>
              <option value="">All types</option>
              <option value="for_sale">For sale</option>
              <option value="free">Free</option>
              <option value="exchange">Exchange</option>
              <option value="wanted">Wanted</option>
            </select>
          </label>
          <label className="mk-filter-field">
            <span>Condition</span>
            <select value={condition ?? ''} onChange={e => setCondition((e.target.value || null) as mk.ListingCondition | null)}>
              <option value="">Any condition</option>
              {Object.entries(mk.CONDITION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="mk-filter-field">
            <span>Min price (₹)</span>
            <input type="number" min={0} value={minPrice} onChange={e => setMinPrice(e.target.value)} placeholder="0" />
          </label>
          <label className="mk-filter-field">
            <span>Max price (₹)</span>
            <input type="number" min={0} value={maxPrice} onChange={e => setMaxPrice(e.target.value)} placeholder="Any" />
          </label>
          <button
            className="ghost-button small"
            onClick={() => { setCategory(null); setTxType(null); setCondition(null); setMinPrice(''); setMaxPrice('') }}
          >Clear filters</button>
        </div>
      )}

      <section className="mk-results" aria-live="polite">
        {loading ? (
          <div className="mk-state"><Loader2 className="spin" size={22} /> Loading listings…</div>
        ) : error ? (
          <div className="mk-state mk-error">
            <p>{error}</p>
            <button className="primary-button small" onClick={() => void load('replace')}>
              <RotateCcw size={14} /> Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="mk-state">
            <Package size={26} />
            <p>{EMPTY_COPY[tab]}</p>
            {(tab === 'Discover' || tab === 'My Listings') && (
              <button className="primary-button small" onClick={openCreate}>
                <Plus size={14} /> Sell an Item
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="mk-grid">
              {rows.map(row => (
                <ListingCard key={row.id} row={row} onOpen={openDetail} onToggleSave={toggleSave} />
              ))}
            </div>
            {rows.length >= PAGE_SIZE && (
              <div className="mk-more">
                <button className="ghost-button" disabled={loadingMore} onClick={() => void load('append')}>
                  {loadingMore ? <><Loader2 className="spin" size={14} /> Loading…</> : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {wizardOpen && (
        <CreateListingWizard
          identity={identity}
          configured={configured}
          colleges={colleges}
          myCollegeId={myCollegeId}
          editing={editing}
          onClose={() => setWizardOpen(false)}
          onSaved={slug => {
            setWizardOpen(false)
            setEditing(null)
            setDetailKey(k => k + 1)
            if (slug) setOpenListingSlug(slug)
          }}
          notify={notify}
        />
      )}
    </main>
  )
}
