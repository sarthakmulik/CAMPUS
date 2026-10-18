import { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft, Bookmark, BookmarkCheck, Building2, CalendarDays, Check, Clock3,
  Copy, Download, Flag, Globe2, Link2, Loader2, Lock, MapPin, Play, RefreshCw,
  Square, Undo2, Users, Video, X,
} from 'lucide-react'
import * as ev from '../lib/events'
import * as db from '../lib/db'
import { friendlyMessage } from '../lib/db'
import { registrationState } from './Events'
import CreateEventWizard from './CreateEventWizard'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  slug: string
  identity: Identity | null
  configured: boolean
  colleges: db.College[]
  myCollegeId: string | null
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
  onBack: () => void
  onOpenCommunity: (clubId: string) => void
  onOpenOtherEvent: (slug: string) => void
}

export default function EventDetail({
  slug, identity, configured, colleges, myCollegeId, requireAuth, notify, onBack, onOpenCommunity, onOpenOtherEvent,
}: Props) {
  const [detail, setDetail] = useState<ev.EventDetailRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [similar, setSimilar] = useState<ev.EventSummary[]>([])
  const [seatBusy, setSeatBusy] = useState(false)
  const [savedBusy, setSavedBusy] = useState(false)
  const [attending, setAttending] = useState<ev.AttendeeRow[] | null>(null)
  const [attendBusy, setAttendBusy] = useState<string | null>(null)
  const [reports, setReports] = useState<ev.EventReportRow[] | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const reload = useCallback(async () => {
    if (!configured) return
    setLoading(true)
    setError(null)
    try {
      const row = await ev.eventDetail(slug)
      setDetail(row)
      setAttending(null)
      setConfirmCancel(false)
      if (row && row.can_manage) {
        void ev.fetchEventReports(row.id).then(setReports).catch(() => setReports([]))
      } else {
        setReports(null)
      }
      if (row) {
        try {
          const matches = await ev.listEvents({ mode: 'discover', category: row.category, sort: 'soonest', limit: 18 })
          setSimilar(matches.filter(item => item.id !== row.id).slice(0, 4))
        } catch {
          setSimilar([])
        }
      } else {
        setSimilar([])
      }
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [configured, slug])

  useEffect(() => {
    void reload()
  }, [reload])

  /* re-check registration after mount (busy state settles) */
  useEffect(() => {
    if (!detail) setAttending(null)
  }, [detail])

  const register = async (status: 'registered' | 'going' | 'interested') => {
    if (!detail) return
    if (!identity) { requireAuth('Sign in to join this event.', 'Events'); return }
    setSeatBusy(true)
    try {
      const result = await ev.registerEvent(detail.id, status)
      notify(result === 'registered'
        ? 'Registered — the organizer just got notified.'
        : result === 'waitlisted'
          ? 'The event was full — you joined the waitlist.'
          : result === 'going' ? 'RSVP: going.' : 'RSVP: interested.')
      void reload()
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setSeatBusy(false)
    }
  }

  const cancelSeat = async () => {
    if (!detail) return
    setSeatBusy(true)
    try {
      if (detail.reg_type === 'registration') {
        const result = await ev.cancelRegistration(detail.id)
        notify(result === 'promoted'
          ? 'Registration cancelled — the next waitlisted student was auto-promoted.'
          : result === 'left_waitlist' ? 'You left the waitlist.' : 'Registration cancelled.')
      } else {
        await ev.unrespondEvent(detail.id)
        notify('Response cleared.')
      }
      setAttending(null)
      void reload()
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setSeatBusy(false)
    }
  }

  const toggleSaved = async () => {
    if (!detail) return
    if (!identity) { requireAuth('Sign in to save events.', 'Events'); return }
    setSavedBusy(true)
    try {
      const saved = await ev.toggleSavedEvent(detail.id, !detail.saved)
      setDetail(current => current ? { ...current, saved } : current)
      notify(saved ? 'Event saved to your list.' : 'Removed from your saved events.')
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setSavedBusy(false)
    }
  }

  const share = async () => {
    const link = `${window.location.origin}${window.location.pathname}#e/${detail?.slug ?? slug}`
    try {
      if (navigator.share) await navigator.share({ url: link, title: detail?.title ?? 'CAMPUS event' })
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link)
      notify('Event link ready to share.')
    } catch {
      notify(link)
    }
  }

  const reportPanel = async (reason: string) => {
    if (!detail) return
    if (!identity) { requireAuth('Report events you find problematic.', 'Events'); return }
    try {
      await ev.reportEvent(detail.id, reason)
      notify('Reported — a school-safety review sees it first.')
    } catch (err) {
      setError(friendlyMessage(err))
    }
  }

  const organizerLifecycle = async (action: 'publish' | 'unpublish' | 'cancel') => {
    if (!detail) return
    setSeatBusy(true)
    try {
      if (action === 'publish') {
        await ev.publishEvent(detail.id, true)
        notify(`${detail.title} is live.`)
      } else if (action === 'unpublish') {
        await ev.publishEvent(detail.id, false)
        notify('Event unpublished — back to draft.')
      } else {
        await ev.cancelEvent(detail.id)
        notify('Event cancelled — attendees were notified.')
        setConfirmCancel(false)
      }
      void reload()
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setSeatBusy(false)
    }
  }

  const loadAttendees = useCallback(async () => {
    if (!detail?.can_manage) return
    try {
      setAttending(await ev.fetchAttendees(detail.id))
    } catch (err) {
      setError(friendlyMessage(err))
    }
  }, [detail?.can_manage, detail?.id])

  useEffect(() => {
    void loadAttendees()
  }, [loadAttendees])

  const markUser = async (row: ev.AttendeeRow, present: boolean) => {
    if (!detail) return
    setAttendBusy(row.user_id)
    try {
      await ev.markAttendance(detail.id, row.user_id, present)
      setAttending(current => (current ?? []).map(r =>
        r.user_id === row.user_id ? { ...r, attendance_status: present ? 'attended' : 'no_show' } : r))
      notify(`${row.display_name ?? 'Student'} marked ${present ? 'attended' : 'no-show'}.`)
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setAttendBusy(null)
    }
  }

  const exportCsv = () => {
    if (!attending) return
    const header = 'display_name,username,status,attendance,registered_at'
    const body = attending.map(row => [
      '"' + (row.display_name ?? '').split('"').join('""') + '"',
      row.username ?? '',
      row.status,
      row.attendance_status ?? '',
      row.registered_at,
    ].join(','))
    const blob = new Blob([[header, ...body].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${detail?.slug ?? 'event'}-attendees.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    notify('Attendee CSV downloaded.')
  }

  if (loading) {
    return (
      <div className="event-detail-page">
        <button className="ghost-button small" onClick={onBack}><ArrowLeft size={15}/> Events</button>
        <div className="event-detail skeleton-card">
          <div className="skeleton-block w60"/>
          <div className="skeleton-lines"><div className="skeleton-block w90"/><div className="skeleton-block w70"/></div>
        </div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="event-detail-page">
        <button className="ghost-button small" onClick={onBack} aria-label="Back to events"><ArrowLeft size={15}/> Events</button>
        <div className="empty-state">
          <CalendarDays size={28}/>
          <b>This event is not available</b>
          <span>It may be a draft, cancelled, or restricted to a college or community you don’t belong to.</span>
        </div>
      </div>
    )
  }

  const state = registrationState(detail)
  const isRsvp = detail.reg_type === 'rsvp'
  const past = new Date(detail.ends_at ?? detail.starts_at).getTime() < Date.now()
  const deadlineIn = detail.reg_deadline
  const seats = Number(detail.seats_taken ?? 0)
  const full = detail.capacity != null && seats >= detail.capacity
  const registered = detail.my_status === 'registered' || detail.my_status === 'going'
  const waitlisted = detail.my_status === 'waitlisted'
  const closedByDeadline = Boolean(deadlineIn && new Date(deadlineIn).getTime() < Date.now())
  const canJoin = detail.published && !detail.cancelled_at && !past

  return (
    <div className="event-detail-page">
      <button className="ghost-button small" onClick={onBack} aria-label="Back to events"><ArrowLeft size={15}/> Events</button>

      <header className="event-hero">
        <div className="event-hero-banner">
          {detail.cover_url
            ? <img src={detail.cover_url} alt="" loading="lazy"/>
            : <span className="community-card-banner-fallback"/>}
        </div>
        <div className="event-hero-body">
          <div className="event-chips">
            <span className="chip">{detail.category}</span>
            <span className={`chip state-${state.key}`}>{state.label}</span>
            <span className="chip">{detail.format === 'offline' ? 'In person' : detail.format === 'online' ? 'Online' : 'Hybrid'}</span>
            {detail.audience !== 'public' && (
              <span className="chip">{detail.audience === 'college' ? 'College-only' : 'Community-only'}</span>
            )}
            {detail.featured && <span className="chip featured-chip">Featured</span>}
          </div>
          <h1 className="page-title">{detail.title}</h1>
          {detail.summary && <p className="event-hero-summary">{detail.summary}</p>}
          <p className="event-hero-meta">
            <CalendarDays size={15}/> {ev.fmtLong(detail.starts_at)}
            {detail.ends_at && <> → {ev.fmtTime(detail.ends_at)}</>}
            <span className="muted-inline"> · {ev.tzBadge(detail.timezone_name)} · in your local time</span>
          </p>
          <p className="event-hero-meta">
            {detail.format !== 'online'
              ? <><MapPin size={15}/>{detail.venue ?? 'Venue in details'}{detail.city ? `, ${detail.city}` : ''}</>
              : <><Video size={15}/>Online</>}
            {detail.format === 'hybrid' && <> · <Video size={15}/> + online</>}
          </p>
          <p className="event-hero-meta">
            {detail.club_name
              ? <><Users size={15}/> <button className="link-button" onClick={() => detail.club_id && onOpenCommunity(detail.club_id)}>{detail.club_name}</button></>
              : detail.college_name
                ? <><Building2 size={15}/> {detail.college_name}</>
                : <><Globe2 size={15}/> Global — open to all colleges</>}
            {detail.organizer_name && <span className="muted-inline"> · organized by {detail.organizer_name}{detail.organizer_username ? ` (@${detail.organizer_username})` : ''}</span>}
          </p>
          <div className="event-hero-actions">
            {detail.saved ? (
              <button className="secondary-button" onClick={() => void toggleSaved()} disabled={savedBusy}>
                <BookmarkCheck size={15}/> Saved
              </button>
            ) : (
              <button className="secondary-button" onClick={() => void toggleSaved()} disabled={savedBusy}>
                <Bookmark size={15}/> Save
              </button>
            )}
            <button className="secondary-button" onClick={() => void share()}><Copy size={15}/> Share</button>
            {identity && (
              <div className="report-menu">
                <button className="ghost-button small" aria-haspopup="menu"><Flag size={14}/> Report</button>
                <span className="report-dropdown">
                  <button onClick={() => void reportPanel('Inappropriate content')}>Inappropriate content</button>
                  <button onClick={() => void reportPanel('Misleading information')}>Misleading information</button>
                  <button onClick={() => void reportPanel('Restricted venue or risky activity')}>Restricted venue or risky activity</button>
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div className="community-error" role="alert">
          <p>{error}</p>
          <button onClick={() => void reload()}><RefreshCw size={15}/> Refresh</button>
        </div>
      )}

      <section className="event-registration" aria-label="Registration">
        {detail.cancelled_at && (
          <div className="reg-banner cancelled"><CalendarDays size={15}/> This event was cancelled{detail.cancelled_at ? ` on ${ev.fmtDateOnly(detail.cancelled_at)}` : ''}.</div>
        )}
        {past && !detail.cancelled_at && (
          <div className="reg-banner done"><Clock3 size={15}/> This event has completed.</div>
        )}
        {detail.reg_type === 'registration' && (
          <div className="reg-stats">
            <span><Users size={14}/> {seats}{detail.capacity != null ? ` / ${detail.capacity}` : ''} registered</span>
            {detail.capacity != null && full && detail.waitlist_enabled && !past && !detail.cancelled_at && !waitlisted && !registered && (
              <span className="reg-waitlist-note">Full — new registrations join the waitlist.</span>
            )}
          </div>
        )}
        {isRsvp && (
          <div className="reg-stats">
            <span><Users size={14}/> {Number(detail.going_count ?? 0)} going · {Number(detail.interested_count ?? 0)} interested</span>
          </div>
        )}
        {closedByDeadline && canJoin && !registered && <div className="reg-banner closed">Registration closed — the deadline has passed.</div>}

        {detail.published !== false && (
          canJoin && detail.my_status ? (
            <div className="reg-action">
              {registered && <span className="reg-state-badge"><Check size={15}/> {isRsvp ? 'You’re going' : 'You’re registered'}.</span>}
              {waitlisted && <span className="reg-state-badge"><Clock3 size={15}/> You’re on the waitlist{full ? ' (event full)' : ''}.</span>}
              {detail.my_status === 'interested' && <span className="reg-state-badge"><Check size={15}/> You’re interested.</span>}
              {!past && (
                <button className="ghost-button" onClick={() => void cancelSeat()} disabled={seatBusy}>
                  <Undo2 size={15}/> {isRsvp ? 'Clear response' : 'Cancel registration'}
                </button>
              )}
            </div>
          ) : canJoin && !closedByDeadline ? (
            <div className="reg-action">
              {isRsvp ? (
                <>
                  <button className="primary-button" onClick={() => void register('going')} disabled={seatBusy}>
                    {seatBusy ? <Loader2 size={15} className="spin"/> : <Check size={15}/>} Going
                  </button>
                  <button className="secondary-button" onClick={() => void register('interested')} disabled={seatBusy}>
                    Interested
                  </button>
                  {detail.my_status === 'not_going' && <span className="reg-state-badge muted">You said not going.</span>}
                </>
              ) : (
                <button className="primary-button" onClick={() => void register('registered')} disabled={seatBusy}>
                  {seatBusy
                    ? <Loader2 size={15} className="spin"/>
                    : <><Users size={15}/>{full ? 'Join waitlist' : 'Register'}</>}
                </button>
              )}
            </div>
          ) : null
        )}

        {detail.registration_url && (
          <a className="secondary-button reg-external" href={detail.registration_url} target="_blank" rel="noreferrer">
            <Link2 size={15}/> Organizer’s own registration form
          </a>
        )}
        {detail.reg_deadline && !past && !closedByDeadline && (
          <p className="reg-note">Registration closes {ev.fmtLong(detail.reg_deadline)}.</p>
        )}
        {detail.reg_opens_at && new Date(detail.reg_opens_at).getTime() > Date.now() && (
          <p className="reg-note">Registration opens {ev.fmtLong(detail.reg_opens_at)}.</p>
        )}
        {canJoin && !registered && detail.online_url && (
          <p className="reg-note">Online access instructions are shared with registered attendees only.</p>
        )}
      </section>

      {detail.description && (
        <section className="event-section" aria-label="About this event">
          <h2>About this event</h2>
          <p className="event-text">{detail.description}</p>
        </section>
      )}

      {detail.tags && detail.tags.length > 0 && (
        <section className="event-section">
          <div className="event-chips">
            {detail.tags.map(tag => <span key={tag} className="chip">#{tag}</span>)}
          </div>
        </section>
      )}

      {detail.format !== 'online' && detail.venue_address && (
        <section className="event-section">
          <h2>Venue</h2>
          <p className="event-text">{detail.venue_address}{detail.city ? `, ${detail.city}` : ''}</p>
          {detail.map_url && (
            <a className="secondary-button" href={detail.map_url} target="_blank" rel="noreferrer"><MapPin size={15}/> Open map</a>
          )}
        </section>
      )}

      {detail.links_revealed && (detail.online_url || detail.access_notes) && (
        <section className="event-section" aria-label="Online access">
          <h2>Online access</h2>
          {detail.online_url && (
            <a className="primary-button" href={detail.online_url} target="_blank" rel="noreferrer">
              <Video size={15}/> Join online event
            </a>
          )}
          {detail.access_notes && <p className="event-text">{detail.access_notes}</p>}
        </section>
      )}
      {(detail.online_url || detail.access_notes) && !detail.links_revealed && (
        <section className="event-section">
          <p className="reg-note"><Lock size={13}/> Meeting link and access instructions are shared with registered attendees.</p>
        </section>
      )}

      {detail.can_manage && (
        <section className="organizer-panel" aria-label="Organizer tools">
          <h2>Organizer tools</h2>
          <div className="organizer-actions">
            <button className="secondary-button" onClick={() => setEditOpen(true)}><CalendarDays size={15}/> Edit event</button>
            {!detail.published && !detail.cancelled_at && !past && (
              <button className="primary-button" disabled={seatBusy} onClick={() => void organizerLifecycle('publish')}>
                <Play size={15}/> Publish
              </button>
            )}
            {detail.published && !past && (
              <button className="ghost-button" onClick={() => void organizerLifecycle('unpublish')} disabled={seatBusy}>
                <Square size={15}/> Unpublish
              </button>
            )}
            {!detail.cancelled_at && (
              confirmCancel
                ? (
                  <span className="confirm-row">
                    <button className="danger-button" disabled={seatBusy} onClick={() => void organizerLifecycle('cancel')}>Cancel event</button>
                    <button className="ghost-button" onClick={() => setConfirmCancel(false)}>Keep</button>
                  </span>
                )
                : (
                  <button className="ghost-button" onClick={() => setConfirmCancel(true)}>
                    <X size={15}/> Cancel event…
                  </button>
                )
            )}
          </div>
          <div className="attend-block">
            <div className="attend-head">
              <b><Users size={15}/> Attendees</b>
              <span className="muted-inline">{seats}{detail.capacity != null ? ` / ${detail.capacity}` : ''} registered</span>
              {attending && attending.length > 0 && (
                <button className="secondary-button small" onClick={exportCsv}><Download size={14}/> CSV</button>
              )}
            </div>
            {attending === null && <p className="reg-note"><Loader2 size={13} className="spin"/> Reading registrations…</p>}
            {attending?.length === 0 && <p className="reg-note">No registrations or RSVPs yet.</p>}
            {attending && attending.length > 0 && (
              <div className="attend-list">
                {/* registration + attendance are two different things here:
                    attendee seats come from event_rsvps (real records). */}
                {attending.map(row => (
                  <div key={row.user_id + row.status} className="attend-row">
                    <span className="attend-name">
                      {row.display_name ?? 'Student'}
                      {row.username && <span className="muted-inline"> @{row.username}</span>}
                    </span>
                    <span className={`chip role-${row.status}${row.status === 'registered' ? '' : ' soft-chip'}`}>{row.status}</span>
                    {(row.status === 'registered' || row.status === 'going') && (
                      <span className="attend-actions">
                        <button
                          className={`mini-action${row.attendance_status === 'attended' ? ' on' : ''}`}
                          disabled={attendBusy === row.user_id}
                          onClick={() => void markUser(row, true)}
                        ><Check size={13}/> Attended</button>
                        <button
                          className={`mini-action${row.attendance_status === 'no_show' ? ' on' : ''}`}
                          disabled={attendBusy === row.user_id}
                          onClick={() => void markUser(row, false)}
                        ><X size={13}/> No-show</button>
                      </span>
                    )}
                    {row.status === 'waitlisted' && <span className="muted-inline">waitlist</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          {reports && reports.length > 0 && (
            <div className="attend-block">
              <b><Flag size={15}/> Reports ({reports.length})</b>
              <ul className="report-list">
                {reports.map(row => (
                  <li key={row.id}><b>{row.reason}</b>{row.details ? ` — ${row.details}` : ''} <span className="muted-inline">· {row.reporter_name ?? 'member'}</span></li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {similar.length > 0 && (
        <section className="event-section" aria-label="Similar upcoming events">
          <h2>Similar upcoming events</h2>
          <div className="similar-list">
            {similar.map(row => (
              <button key={row.id} className="similar-row" onClick={() => onOpenOtherEvent(row.slug)}>
                <b>{row.title}</b>
                <span><CalendarDays size={12}/> {ev.fmtDateOnly(row.starts_at)} · {row.category}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {editOpen && (
        <CreateEventWizard
          key="edit-event"
          editing={detail}
          colleges={colleges}
          myCollegeId={myCollegeId}
          identityId={identity?.id ?? ''}
          notify={notify}
          onClose={() => setEditOpen(false)}
          onDone={() => {
            setEditOpen(false)
            notify('Event updated — attendees got one notice.')
            void reload()
          }}
        />
      )}
    </div>
  )
}
