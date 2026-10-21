import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { popSubviewEntry } from '../lib/navHistory'
import {
  CalendarDays, ChevronLeft, ChevronRight, Clock3, Globe2, List as ListIcon,
  Loader2, MapPin, RefreshCw, Search, SlidersHorizontal, Sparkles, Ticket, Users, Video, X, Building2,
  Bookmark, BookmarkCheck, Plus, VideoIcon,
} from 'lucide-react'
import * as ev from '../lib/events'
import * as bk from '../lib/bookmarks'
import * as db from '../lib/db'
import { friendlyMessage } from '../lib/db'
import EventDetail from './EventDetail'
import CreateEventWizard from './CreateEventWizard'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  colleges: db.College[]
  myCollegeId: string | null
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
  openEventSlug: string | null
  setOpenEventSlug: (slug: string | null) => void
  onOpenCommunity: (clubId: string) => void
}

const EVENT_TABS = [
  'Discover', 'For You', 'My College', 'Following', 'Upcoming',
  'Past', 'Registered', 'Saved', 'My Events',
] as const
type EventTab = typeof EVENT_TABS[number]

const MODE_BY_TAB: Record<EventTab, ev.EventMode> = {
  Discover: 'discover',
  'For You': 'foryou',
  'My College': 'mycollege',
  Following: 'following',
  Upcoming: 'upcoming',
  Past: 'past',
  Registered: 'registered',
  Saved: 'saved',
  'My Events': 'organized',
}

const PAGE_SIZE = 24

function categoryGradient(category: string): string {
  let hash = 0
  for (const ch of category) hash = (hash * 31 + ch.charCodeAt(0)) % 100000
  const hue = hash % 360
  return `linear-gradient(135deg, hsl(${hue} 68% 26%), hsl(${(hue + 42) % 360} 62% 16%))`
}

/** Real lifecycle state straight off the row — no invented statuses. */
export function registrationState(row: ev.EventSummary): { key: string; label: string } {
  if (row.cancelled_at) return { key: 'cancelled', label: 'Cancelled' }
  if (!row.published) return { key: 'draft', label: 'Draft' }
  const end = row.ends_at ? new Date(row.ends_at).getTime() : new Date(row.starts_at).getTime() + 1
  if (end < Date.now()) return { key: 'done', label: 'Completed' }
  if (row.my_status) {
    if (row.my_status === 'registered') return { key: 'registered', label: 'Registered' }
    if (row.my_status === 'going') return { key: 'going', label: 'Going' }
    if (row.my_status === 'interested') return { key: 'interested', label: 'Interested' }
    if (row.my_status === 'waitlisted') return { key: 'waitlisted', label: 'Waitlisted' }
  }
  const deadline = row.reg_deadline ? new Date(row.reg_deadline).getTime() : Infinity
  if (deadline < Date.now()) return { key: 'closed', label: 'Closed' }
  if (row.reg_opens_at && new Date(row.reg_opens_at).getTime() > Date.now()) {
    return { key: 'soon', label: 'Opening soon' }
  }
  const cap = row.capacity
  const seats = Number(row.seats_taken ?? 0)
  if (row.reg_type === 'registration' && cap != null && seats >= cap) {
    return { key: 'full', label: 'Full' }
  }
  if (row.reg_type === 'rsvp') return { key: 'open-rsvp', label: 'RSVP open' }
  return { key: 'open', label: 'Open' }
}

export default function Events({
  identity, configured, colleges, myCollegeId, requireAuth, notify,
  openEventSlug, setOpenEventSlug, onOpenCommunity,
}: Props) {
  const [tab, setTab] = useState<EventTab>('Discover')
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [format, setFormat] = useState<'any' | ev.EventFormat>('any')
  const [scope, setScope] = useState<'any' | 'global' | 'college' | 'community'>('any')
  const [sort, setSort] = useState<ev.EventSort>('recommended')
  const [month, setMonth] = useState(() => ym(new Date()))
  const [rows, setRows] = useState<ev.EventSummary[]>([])
  const [featured, setFeatured] = useState<ev.EventSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const [calLoading, setCalLoading] = useState(false)
  const [calRows, setCalRows] = useState<ev.EventSummary[]>([])
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ev.EventSummary | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const debounceRef = useRef<number | null>(null)

  /** how many non-default discovery dimensions are set (category, format,
      scope — scope only counts on Discover where it actually applies) */
  const activeFilters = useMemo(() => {
    let count = 0
    if (category !== 'All') count += 1
    if (format !== 'any') count += 1
    if (tab === 'Discover' && scope !== 'any') count += 1
    return count
  }, [category, format, scope, tab])

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      setDebouncedQuery(query)
      setPage(0)
    }, 350)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [query])

  const paramsBase = useCallback((activePage: number, listLimit = PAGE_SIZE): ev.ListEventsParams => ({
    mode: MODE_BY_TAB[tab],
    query: tab === 'Upcoming' || tab === 'Past' || tab === 'Registered' || tab === 'Saved' || tab === 'My Events'
      ? '' : debouncedQuery,
    category: category === 'All' ? '' : category,
    format,
    scope: tab === 'Discover' ? scope : 'any',
    sort: tab === 'Past' ? 'recommended' : sort,
    limit: listLimit,
    offset: activePage * listLimit,
  }), [tab, debouncedQuery, category, format, scope, sort])

  const load = useCallback(async (activePage: number, mode: 'replace' | 'append') => {
    if (!configured) return
    if (mode === 'replace') setLoading(true)
    setMore(false)
    setError(null)
    try {
      const data = await ev.listEvents(paramsBase(activePage))
      if (mode === 'append') {
        setRows(prev => [...prev, ...data])
      } else {
        setRows(data)
      }
      setMore(data.length >= PAGE_SIZE)
    } catch (err) {
      setError(friendlyMessage(err))
      if (mode === 'replace') setRows([])
    } finally {
      setLoading(false)
    }
  }, [configured, paramsBase])

  useEffect(() => {
    setRows([])
    void load(0, 'replace')
  }, [load])

  /** Featured strip: genuinely featured events (organizer-chosen), upcoming,
   *  visible to this viewer — only shown on Discover. */
  const loadFeatured = useCallback(async () => {
    if (!configured || tab !== 'Discover') { setFeatured([]); return }
    try {
      const data = await ev.listEvents({ mode: 'discover', sort: 'soonest', limit: 48 })
      setFeatured(data.filter(row => row.featured).slice(0, 6))
    } catch {
      setFeatured([])
    }
  }, [configured, tab])

  useEffect(() => {
    void loadFeatured()
  }, [loadFeatured])

  const loadCalendar = useCallback(async () => {
    if (!configured || view !== 'calendar') { setCalRows([]); return }
    setCalLoading(true)
    try {
      const data = await ev.listEvents({
        mode: MODE_BY_TAB[tab] === 'organized' ? 'organized' : tab === 'Past' ? 'past' : 'discover',
        query: debouncedQuery,
        category: category === 'All' ? '' : category,
        format,
        month,
        sort: 'soonest',
        limit: 60,
      })
      setCalRows(data)
    } catch (err) {
      setError(friendlyMessage(err))
      setCalRows([])
    } finally {
      setCalLoading(false)
    }
  }, [configured, view, tab, debouncedQuery, category, format, month])

  useEffect(() => {
    void loadCalendar()
  }, [loadCalendar])

  const refresh = useCallback(() => {
    void load(0, 'replace')
    void loadFeatured()
    void loadCalendar()
  }, [load, loadFeatured, loadCalendar])

  const openEvent = (slug: string) => {
    const allowed = requireAuth('Sign in to open event pages.', 'Events')
    if (!allowed) return
    setOpenEventSlug(slug)
  }

  const toggleSaved = async (row: ev.EventSummary) => {
    if (!identity) { requireAuth('Sign in to save events.', 'Events'); return }
    try {
      const saved = await ev.toggleSavedEvent(row.id, !row.saved)
      setRows(current => current.map(r => r.id === row.id ? { ...r, saved } : r))
      setCalRows(current => current.map(r => r.id === row.id ? { ...r, saved } : r))
      // mirror into the shared saved store so the Saved page stays in step
      bk.savedStoreSet('event', row.id, saved)
      notify(saved ? 'Event saved to your list.' : 'Removed from your saved events.')
      if (tab === 'Saved') void load(0, 'replace')
    } catch (err) {
      setError(friendlyMessage(err))
    }
  }

  const cancelSeat = async (row: ev.EventSummary) => {
    try {
      if (row.reg_type === 'registration') {
        const result = await ev.cancelRegistration(row.id)
        notify(result === 'promoted'
          ? 'Registration cancelled — the next student on the waitlist was promoted.'
          : result === 'left_waitlist' ? 'You left the waitlist.' : 'Registration cancelled.')
      } else {
        await ev.unrespondEvent(row.id)
        notify('Response cleared.')
      }
      void load(0, 'replace')
    } catch (err) {
      setError(friendlyMessage(err))
    }
  }

  const organizerAction = async (row: ev.EventSummary, action: 'publish' | 'unpublish' | 'cancel' | 'delete') => {
    try {
      if (action === 'publish') {
        await ev.publishEvent(row.id, true)
        notify(`${row.title} is live.`)
      } else if (action === 'unpublish') {
        await ev.publishEvent(row.id, false)
        notify(`${row.title} is back to draft.`)
      } else if (action === 'cancel') {
        if (!window.confirm(`Cancel "${row.title}"? Attendees keep their seat records and are notified. This cannot be undone.`)) return
        await ev.cancelEvent(row.id)
        notify(`${row.title} was cancelled — attendees were notified.`)
      } else {
        if (!window.confirm(`Delete "${row.title}"? This cannot be undone; registrations are removed with it.`)) return
        await ev.deleteEvent(row.id)
        notify(`${row.title} was deleted.`)
      }
      void load(0, 'replace')
    } catch (err) {
      setError(friendlyMessage(err))
    }
  }

  if (openEventSlug) {
    return (
      <EventDetail
        slug={openEventSlug}
        identity={identity}
        configured={configured}
        colleges={colleges}
        myCollegeId={myCollegeId}
        requireAuth={requireAuth}
        notify={notify}
        onBack={() => {
          // pop the detail's history entry, then refresh the list beneath
          if (!popSubviewEntry()) setOpenEventSlug(null)
          refresh()
        }}
        onOpenOtherEvent={nextSlug => setOpenEventSlug(nextSlug)}
        onOpenCommunity={onOpenCommunity}
      />
    )
  }

  const emptyCopy =
    tab === 'My Events'
      ? {
          icon: CalendarDays,
          title: identity ? 'No events organized yet' : 'Sign in to organize events',
          body: identity ? 'Create an event for your community, your college, or everyone — from the Create button.' : 'Sign in to create and manage events.',
        }
      : tab === 'Registered'
        ? {
            icon: Ticket,
            title: identity ? 'No registrations yet' : 'Sign in to register for events',
            body: identity ? 'Register from Discover — registrations and RSVPs appear here.' : 'Sign in to register for events.',
          }
        : tab === 'Saved'
          ? {
              icon: Bookmark,
              title: identity ? 'Nothing saved yet' : 'Sign in to save events',
              body: identity ? 'Tap the bookmark on any event card to keep it here.' : 'Sign in to save events for later.',
            }
          : tab === 'My College' && !myCollegeId
            ? {
                icon: Building2,
                title: 'Pick your college first',
                body: 'Add your college on your profile to see events from your campus.',
              }
            : {
                icon: Search,
                title: 'No events found',
                body: 'Try another search term, tab or category — or organize the first one.',
              }

  return (
    <div className="events-page">
      <header className="events-head">
        <h1 className="page-title">Events</h1>
        <button className="primary-button events-create" onClick={() => {
          if (!requireAuth('Sign in to create an event.', 'Events')) return
          setEditTarget(null)
          setCreateOpen(true)
        }}>
          <Plus size={17}/> Create event
        </button>
      </header>
      <p className="page-subtitle events-subtitle">Discover what’s happening across campus — fests, hackathons, workshops and more.</p>
      {identity && (
        <p className="events-context muted-inline">
          <Building2 size={13}/> {colleges.find(c => c.id === myCollegeId)?.short_name ?? 'No college set'}
        </p>
      )}

      <div className="community-searchbar">
        <Search size={18}/>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search events by title, venue, college or community"
          aria-label="Search events"
        />
        {query && <button className="icon-button" onClick={() => setQuery('')} aria-label="Clear search"><X size={16}/></button>}
      </div>

      <div className="events-viewrow">
        <nav className="community-tabs event-tabs" data-no-page-swipe="true" aria-label="Event discovery tabs">
          {EVENT_TABS.map(item => (
            <button key={item} className={item === tab ? 'on' : ''} onClick={() => { setTab(item); setPage(0) }}>
              {item}
            </button>
          ))}
        </nav>
        <div className="events-viewtoggle" role="group" aria-label="View mode">
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-label="List view"><ListIcon size={15}/></button>
          <button className={view === 'calendar' ? 'on' : ''} onClick={() => setView('calendar')} aria-label="Calendar view"><CalendarDays size={15}/></button>
        </div>
      </div>

      {/* mobile-only summary row: one Filters action with an active count; the
          discovery tabs above stay immediately accessible (never hidden behind
          the filters sheet) */}
      <div className="events-filter-bar" data-no-page-swipe="true">
        <button
          type="button"
          className={`events-filter-toggle${activeFilters > 0 ? ' has' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
        >
          <SlidersHorizontal size={14}/> Filters
          {activeFilters > 0 && <i>{activeFilters}</i>}
        </button>
      </div>

      <div className="community-category-row" data-no-page-swipe="true">
         {['All', ...ev.EVENT_CATEGORIES].map(item => (
          <button key={item} className={`community-chip${item === category ? ' on' : ''}`} onClick={() => { setCategory(item); setPage(0) }}>
            {item}
          </button>
        ))}
      </div>

      {tab === 'Discover' && (
        <div className="events-filterrow">
          <label>
            <span>Format</span>
            <select value={format} onChange={event => setFormat(event.target.value as 'any' | ev.EventFormat)}>
              <option value="any">Any</option>
              <option value="offline">In person</option>
              <option value="online">Online</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </label>
          <label>
            <span>Scope</span>
            <select value={scope} onChange={event => setScope(event.target.value as 'any' | 'global' | 'college' | 'community')}>
              <option value="any">Any</option>
              <option value="global">Global</option>
              <option value="college">College</option>
              <option value="community">Community</option>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select value={sort} onChange={event => setSort(event.target.value as ev.EventSort)}>
              <option value="recommended">Recommended</option>
              <option value="soonest">Soonest</option>
              <option value="new">Recently added</option>
            </select>
          </label>
        </div>
      )}

      {error && (
        <div className="community-error" role="alert">
          <p>{error}</p>
          <button onClick={refresh}><RefreshCw size={15}/> Try again</button>
        </div>
      )}

      {view === 'calendar' ? (
        <EventCalendar
          month={month}
          onMonthChange={setMonth}
          rows={calRows}
          loading={calLoading}
          selectedDay={selectedDay}
          onSelectDay={day => setSelectedDay(day === selectedDay ? null : day)}
          onOpen={openEvent}
        />
      ) : (
        <>
          {tab === 'Discover' && featured.length > 0 && (
            <section className="featured-strip" aria-label="Featured events">
              <h2><Sparkles size={16}/> Featured events</h2>
              <div className="featured-scroll" data-no-page-swipe="true">
                {featured.map(row => (
                  <FeaturedCard key={row.id} row={row} onOpen={() => openEvent(row.slug)} />
                ))}
              </div>
            </section>
          )}

          {loading && (
            <div className="event-grid" aria-label="Loading events">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="event-card skeleton-card">
                  <div className="event-banner skeleton-block"/>
                  <div className="skeleton-lines"><div className="skeleton-block w90"/><div className="skeleton-block w60"/></div>
                </div>
              ))}
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="empty-state">
              <emptyCopy.icon size={30}/>
              <b>{emptyCopy.title}</b>
              <span>{emptyCopy.body}</span>
            </div>
          )}

          {!loading && rows.length > 0 && (
            <>
              <div className="event-grid">
                {rows.map(row => (
                  <EventCard
                    key={row.id}
                    row={row}
                    identity={identity}
                    onOpen={() => openEvent(row.slug)}
                    onSave={() => void toggleSaved(row)}
                    onCancelSeat={() => void cancelSeat(row)}
                    onOrganize={action => void organizerAction(row, action)}
                    onEdit={() => {
                      if (!requireAuth('Sign in to manage your events.', 'Events')) return
                      setEditTarget(row)
                      setCreateOpen(true)
                    }}
                  />
                ))}
              </div>
              {more && (
                <div className="community-more">
                  <button onClick={() => { const next = page + 1; setPage(next); void load(next, 'append') }}>
                    {loading ? <Loader2 size={16} className="spin"/> : null}
                    Load more events
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {createOpen && (
        <CreateEventWizard
          key={editTarget?.id ?? 'create'}
          editing={editTarget}
          colleges={colleges}
          myCollegeId={myCollegeId}
          identityId={identity?.id ?? ''}
          notify={notify}
          onClose={() => { setCreateOpen(false); setEditTarget(null) }}
          onDone={(slug, title, published) => {
            setCreateOpen(false)
            setEditTarget(null)
            refresh()
            if (published && slug) {
              setOpenEventSlug(slug)
              notify(`${title} is live — registrations are open.`)
            } else {
              notify(published ? `${title} is live.` : `${title} saved as a draft.`)
            }
          }}
        />
      )}

      {sheetOpen && (
        <EventFilterSheet
          tab={tab}
          category={category}
          format={format}
          scope={scope}
          sort={sort}
          setCategory={item => { setCategory(item); setPage(0) }}
          setFormat={setFormat}
          setScope={setScope}
          setSort={setSort}
          onReset={() => {
            setCategory('All')
            setFormat('any')
            setScope('any')
            setSort('recommended')
            setPage(0)
          }}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Mobile filter bottom sheet                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Houses the existing discovery dimensions (category, format, scope, sort) in
 * one mobile surface. The inline rows these mirror keep their exact meaning —
 * the sheet only changes where the controls live. Room, format and sort apply
 * on every tab; scope is a Discover dimension, so it reads disabled elsewhere.
 */
function EventFilterSheet({
  tab, category, format, scope, sort,
  setCategory, setFormat, setScope, setSort, onReset, onClose,
}: {
  tab: EventTab
  category: string
  format: 'any' | ev.EventFormat
  scope: 'any' | 'global' | 'college' | 'community'
  sort: ev.EventSort
  setCategory: (item: string) => void
  setFormat: (value: 'any' | ev.EventFormat) => void
  setScope: (value: 'any' | 'global' | 'college' | 'community') => void
  setSort: (value: ev.EventSort) => void
  onReset: () => void
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const sheetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // keep the sheet area out of the page-swipe gesture like other overlays
  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return
    sheet.setAttribute('data-no-page-swipe', 'true')
  }, [])

  const onDiscover = tab === 'Discover'
  const onPast = tab === 'Past'

  return (
    <div className="overlay events-sheet-overlay"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={sheetRef} className="events-filter-sheet" role="dialog" aria-modal="true" aria-label="Event filters">
        <header className="events-sheet-head">
          <b>Filters</b>
          <span className="events-sheet-tab">{tab}</span>
          <button ref={closeRef} className="events-sheet-close" aria-label="Close filters" onClick={onClose}>
            <X size={18}/>
          </button>
        </header>

        <div className="events-sheet-body">
          <p className="events-sheet-label" id="filters-category">Category</p>
          <div className="events-sheet-chips" role="group" aria-labelledby="filters-category">
            {['All', ...ev.EVENT_CATEGORIES].map(item => (
              <button key={item} type="button"
                className={`community-chip${item === category ? ' on' : ''}`}
                aria-pressed={item === category}
                onClick={() => setCategory(item)}>
                {item}
              </button>
            ))}
          </div>

          <div className="events-sheet-selects">
            <label>
              <span>Format</span>
              <select value={format} onChange={event => setFormat(event.target.value as 'any' | ev.EventFormat)}>
                <option value="any">Any</option>
                <option value="offline">In person</option>
                <option value="online">Online</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </label>
            {!onPast && (
              <label>
                <span>Sort</span>
                <select value={sort} onChange={event => setSort(event.target.value as ev.EventSort)}>
                  <option value="recommended">Recommended</option>
                  <option value="soonest">Soonest</option>
                  <option value="new">Recently added</option>
                </select>
              </label>
            )}
            <label className={onDiscover ? '' : 'disabled'}>
              <span>Scope</span>
              <select value={scope} disabled={!onDiscover}
                onChange={event => setScope(event.target.value as 'any' | 'global' | 'college' | 'community')}>
                <option value="any">Any</option>
                <option value="global">Global</option>
                <option value="college">College</option>
                <option value="community">Community</option>
              </select>
            </label>
          </div>
          {!onDiscover && (
            <p className="events-sheet-note">Scope applies on the Discover tab.</p>
          )}
        </div>

        <footer className="events-sheet-actions">
          <button type="button" className="ghost-button" onClick={onReset}>Reset</button>
          <button type="button" className="primary-button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Month helper + calendar                                                     */
/* -------------------------------------------------------------------------- */

function ym(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function shiftMonth(ymValue: string, delta: number): string {
  const [year, month] = ymValue.split('-').map(Number)
  const next = new Date(year, month - 1 + delta, 1)
  return ym(next)
}

function monthLabel(ymValue: string): string {
  const [year, month] = ymValue.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1))
}

function dayKey(iso: string): string {
  // informational bucket for the viewer's own time zone
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function EventCalendar({ month, onMonthChange, rows, loading, selectedDay, onSelectDay, onOpen }: {
  month: string
  onMonthChange: (next: string) => void
  rows: ev.EventSummary[]
  loading: boolean
  selectedDay: string | null
  onSelectDay: (day: string) => void
  onOpen: (slug: string) => void
}) {
  const byDay = useMemo(() => {
    const map = new Map<string, ev.EventSummary[]>()
    for (const row of rows) {
      const key = dayKey(row.starts_at)
      const list = map.get(key) ?? []
      list.push(row)
      map.set(key, list)
    }
    return map
  }, [rows])

  const cells = useMemo(() => {
    const [year, monthNum] = month.split('-').map(Number)
    const first = new Date(year, monthNum - 1, 1)
    const start = first.getDay() // 0 = Sunday
    const days: Array<{ key: string; day: number; month: number }> = []
    for (let index = 0; index < start; index++) days.push({ key: `pad-${index}`, day: 0, month: monthNum })
    const last = new Date(year, monthNum, 0).getDate()
    for (let day = 1; day <= last; day++) {
      days.push({ key: `${month}-${String(day).padStart(2, '0')}`, day, month: monthNum })
    }
    return days
  }, [month])

  const todayKey = dayKey(new Date().toISOString())

  return (
    <section className="event-calendar" aria-label="Event calendar">
      <header className="calendar-head">
        <button onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label="Previous month"><ChevronLeft size={16}/></button>
        <b>{monthLabel(month)}</b>
        <button onClick={() => onMonthChange(shiftMonth(month, 1))} aria-label="Next month"><ChevronRight size={16}/></button>
      </header>
      <div className="calendar-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(dayName => (
          <span key={dayName} className="calendar-dow">{dayName}</span>
        ))}
        {cells.map(cell => {
          if (cell.day === 0) return <span key={cell.key} className="calendar-pad"/>
          const dayRows = byDay.get(cell.key) ?? []
          const hasEvent = dayRows.length > 0
          const isToday = cell.key === todayKey
          const count = dayRows.length
          return (
            <button
              key={cell.key}
              className={`calendar-day${hasEvent ? ' has-event' : ''}${selectedDay === cell.key ? ' picked' : ''}${isToday ? ' today' : ''}`}
              onClick={() => hasEvent && onSelectDay(cell.key)}
              aria-label={hasEvent ? `${cell.day} — ${count} event${count === 1 ? '' : 's'}` : `${cell.day} — no events`}
            >
              <span>{cell.day}</span>
              {hasEvent && <i aria-hidden />}
            </button>
          )
        })}
      </div>
      {loading && <p className="calendar-note"><Loader2 size={14} className="spin"/> Reading events…</p>}
      {selectedDay && (
        <div className="calendar-day-events">
          {(byDay.get(selectedDay) ?? []).map(row => (
            <button key={row.id} className="calendar-event-row" onClick={() => onOpen(row.slug)}>
              <b>{row.title}</b>
              <span>
                <Clock3 size={12}/> {ev.fmtTime(row.starts_at)}
                {row.format !== 'offline' && <><Video size={12}/> {row.format}</>}
                {row.format !== 'online' && <><MapPin size={12}/> {row.venue ?? ''}</>}
              </span>
            </button>
          ))}
        </div>
      )}
      {!loading && rows.length === 0 && <p className="calendar-note">No events this month for the current tab and filters.</p>}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Featured + cards                                                            */
/* -------------------------------------------------------------------------- */

function FeaturedCard({ row, onOpen }: { row: ev.EventSummary; onOpen: () => void }) {
  return (
    <button className="featured-card" onClick={onOpen}>
      <span className="featured-banner">
        {row.cover_url
          ? <img src={row.cover_url} alt="" loading="lazy"/>
          : <span className="community-card-banner-fallback" style={{ background: categoryGradient(row.category) }}/>}
      </span>
      <span className="featured-body">
        <span className="event-chips"><span className="chip">{row.category}</span></span>
        <b>{row.title}</b>
        <span className="featured-meta">
          <CalendarDays size={12}/> {ev.fmtDay(row.starts_at)} · {ev.fmtTime(row.starts_at)}
        </span>
        <span className="featured-meta">
          {row.format !== 'online'
            ? <><MapPin size={12}/>{row.venue ?? 'Venue in the details'}</>
            : <><VideoIcon size={12}/>Online</>}
          {row.format === 'hybrid' && <> · <VideoIcon size={12}/> + online</>}
        </span>
        <span className="featured-meta">
          {row.club_name && <><Users size={12}/>{row.club_name}</>}
          {!row.club_name && row.college_short_name && <><Building2 size={12}/>{row.college_short_name}</>}
          {!row.club_name && !row.college_short_name && <><Globe2 size={12}/> Global</>}
          {' · '}
          {registrationState(row).label}
        </span>
      </span>
    </button>
  )
}

function EventCard({
  row, identity, onOpen, onSave, onCancelSeat, onOrganize, onEdit,
}: {
  row: ev.EventSummary
  identity: Identity | null
  onOpen: () => void
  onSave: () => void
  onCancelSeat: () => void
  onOrganize: (action: 'publish' | 'unpublish' | 'cancel' | 'delete') => void
  onEdit: () => void
}) {
  const state = registrationState(row)
  const mine = identity && row.organizer_id === identity.id
  const manage = row.can_manage
  const isPast = new Date(row.ends_at ?? row.starts_at).getTime() < Date.now()
  const seats = Number(row.seats_taken ?? 0)

  return (
    <article className="event-card">
      <button className="event-banner" onClick={onOpen} aria-label={`Open ${row.title}`}>
        {row.cover_url
          ? <img src={row.cover_url} alt="" loading="lazy"/>
          : <span className="community-card-banner-fallback" style={{ background: categoryGradient(row.category) }}/>}
        <span className="event-datechip">
          <b>{new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(row.starts_at))}</b>
          <i>{new Date(row.starts_at).getDate()}</i>
        </span>
      </button>
      <div className="event-card-body">
        <div className="event-chips">
          <span className="chip">{row.category}</span>
          <span className={`chip state-${state.key}`}>{state.label}</span>
          {row.format !== 'offline' && <span className="chip">{row.format === 'online' ? 'Online' : 'Hybrid'}</span>}
        </div>
        <button className="event-card-title" onClick={onOpen}>{row.title}</button>
        {row.summary && <p className="event-card-summary">{row.summary}</p>}
        <p className="event-card-meta">
          <Clock3 size={13}/> {ev.fmtDay(row.starts_at)} · {ev.fmtTime(row.starts_at)}
        </p>
        <p className="event-card-meta">
          {row.format !== 'online' && <><MapPin size={13}/> {row.venue ?? 'Venue in details'}{row.city ? `, ${row.city}` : ''} · </>}
          <VideoIcon size={13}/>
          {' '}
          {row.format === 'offline' ? 'In person' : row.format === 'online' ? 'Online' : 'Hybrid'}
        </p>
        <p className="event-card-meta organizer-line">
          {row.club_name
            ? <><Users size={13}/> {row.club_name}</>
            : row.college_short_name
              ? <><Building2 size={13}/> {row.college_short_name}</>
              : <><Globe2 size={13}/> Global</>}
          {row.organizer_name && <span className="organizer-name"> · by {row.organizer_name}</span>}
        </p>
        <div className="event-card-actions">
          <button className="secondary-button" onClick={onOpen}>
            {state.key === 'done' ? 'View' : state.key === 'registered' || state.key === 'going' ? 'View + manage' : 'View'}
          </button>
          {!isPast && !row.cancelled_at && row.my_status && state.key !== 'draft' && (
            <button className="ghost-button" onClick={onCancelSeat}>
              {row.reg_type === 'registration' ? 'Cancel seat' : 'Un-RSVP'}
            </button>
          )}
          <button
            className={row.saved ? 'icon-button saved-on' : 'icon-button'}
            onClick={onSave}
            aria-label={row.saved ? 'Remove from saved' : 'Save this event'}
          >
            {row.saved ? <BookmarkCheck size={17}/> : <Bookmark size={17}/>}
          </button>
        </div>
        {manage && (
          <div className="event-card-manage">
            <button className="mini-action" onClick={onEdit}>Edit</button>
            {!row.published && isEventUpcoming(row) && (
              <button className="mini-action" onClick={() => onOrganize('publish')}>Publish</button>
            )}
            {row.published && !isPast && (
              <button className="mini-action" onClick={() => onOrganize('unpublish')}>Unpublish</button>
            )}
            {!row.cancelled_at && (
              <button className="mini-action" onClick={() => onOrganize('cancel')}>Cancel event</button>
            )}
            {seats === 0 && (
              <button className="mini-action" onClick={() => onOrganize('delete')}>
                {row.published || !isEventUpcoming(row) ? 'Delete' : 'Delete draft'}
              </button>
            )}
          </div>
        )}
        {mine && !manage && null}
      </div>
    </article>
  )
}

function isEventUpcoming(row: ev.EventSummary): boolean {
  return new Date(row.ends_at ?? row.starts_at).getTime() >= Date.now()
}
