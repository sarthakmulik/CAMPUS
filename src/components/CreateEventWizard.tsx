import { useEffect, useState } from 'react'
import {
  CalendarDays, Check, ChevronLeft, ChevronRight, Globe2, Image as ImageIcon,
  Loader2, Lock, MapPin, Users, X, Video,
} from 'lucide-react'
import * as ev from '../lib/events'
import * as db from '../lib/db'
import * as cm from '../lib/communities'
import { friendlyMessage, College } from '../lib/db'

type Props = {
  editing: ev.EventSummary | null
  colleges: College[]
  myCollegeId: string | null
  identityId: string
  notify: (message: string) => void
  onClose: () => void
  onDone: (slug: string | null, title: string, published: boolean) => void
}

type ManagedCommunity = { id: string; name: string }
type Snapshot = ev.SaveEventInput & { slug: string; eventId: string; published: boolean }

const STEPS = ['Basics', 'When', 'Where & how', 'Scope', 'Registration', 'Review'] as const

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDaysISO(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
}

/** Wall-clock pieces of an instant, in the event's own time zone
 *  (what the organizer originally picked). */
function instantToParts(iso: string, timeZone: string): { date: string; time: string } {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Kolkata',
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
    const pick = (type: string) => dtf.formatToParts(new Date(iso)).find(p => p.type === type)?.value ?? ''
    return { date: `${pick('year')}-${pick('month')}-${pick('day')}`, time: `${pick('hour')}:${pick('minute')}` }
  } catch {
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
  }
}

const emptyState = {
  title: '',
  summary: '',
  description: '',
  category: 'Workshops' as string,
  tags: '',
  coverUrl: '' as string | null,
  audience: 'public' as ev.EventAudience,
  regEligibility: 'everyone' as ev.EventEligibility,
  regType: 'registration' as ev.EventRegType,
  format: 'offline' as ev.EventFormat,
  clubId: '' as string,
  venue: '',
  venueAddress: '',
  city: '',
  mapUrl: '',
  onlineUrl: '',
  accessNotes: '',
  timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata') as string,
  startDate: addDaysISO(0),
  startTime: '17:00',
  endDate: '' as string,
  endTime: '',
  capacity: '',
  waitlist: true as boolean,
  regOpenDate: '' as string,
  regOpenTime: '',
  regDeadlineDate: '' as string,
  regDeadlineTime: '',
  registrationUrl: '',
  featured: false as boolean,
}

export default function CreateEventWizard({
  editing, colleges, myCollegeId, identityId, notify, onClose, onDone,
}: Props) {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState({ ...emptyState })
  const [detailSnapshot, setDetailSnapshot] = useState<Snapshot | null>(null)
  const [managed, setManaged] = useState<ManagedCommunity[]>([])
  const [coverBusy, setCoverBusy] = useState(false)

  /* Editing: the summary rows lack the description/restricted fields, so the
     full detail is loaded (the viewer manages this event — fields unhide). */
  useEffect(() => {
    if (!editing) return
    let cancelled = false
    void (async () => {
      try {
        const detail = await ev.eventDetail(editing.slug)
        if (cancelled) return
        if (!detail) { setError('That event could not be loaded for editing.'); return }
        const snap: Snapshot = {
          slug: detail.slug,
          eventId: detail.id,
          published: detail.published,
          title: detail.title,
          summary: detail.summary ?? '',
          description: detail.description ?? '',
          category: detail.category,
          tags: detail.tags ?? [],
          coverUrl: detail.cover_url,
          collegeId: detail.audience === 'college' ? detail.college_id : null,
          clubId: detail.club_id,
          audience: detail.audience,
          regEligibility: detail.reg_eligibility,
          regType: detail.reg_type,
          format: detail.format,
          venue: detail.venue ?? '',
          venueAddress: detail.venue_address ?? '',
          city: detail.city ?? '',
          mapUrl: detail.map_url ?? '',
          onlineUrl: detail.online_url ?? '',
          accessNotes: detail.access_notes ?? '',
          timezone: detail.timezone_name,
          startsAt: detail.starts_at,
          endsAt: detail.ends_at,
          capacity: detail.capacity,
          regOpensAt: detail.reg_opens_at,
          regDeadline: detail.reg_deadline,
          registrationUrl: detail.registration_url ?? '',
          featured: detail.featured,
          publish: detail.published,
        }
        setDetailSnapshot(snap)
        const startParts = instantToParts(detail.starts_at, detail.timezone_name)
        const endParts = detail.ends_at ? instantToParts(detail.ends_at, detail.timezone_name) : { date: '', time: '' }
        const opens = detail.reg_opens_at ? instantToParts(detail.reg_opens_at, detail.timezone_name) : { date: '', time: '' }
        const deadline = detail.reg_deadline ? instantToParts(detail.reg_deadline, detail.timezone_name) : { date: '', time: '' }
        setState({
          ...emptyState,
          title: snap.title,
          summary: snap.summary ?? '',
          description: snap.description ?? '',
          category: snap.category,
          tags: (snap.tags ?? []).join(', '),
          coverUrl: snap.coverUrl ?? null,
          audience: snap.audience,
          regEligibility: snap.regEligibility,
          regType: snap.regType,
          format: snap.format,
          clubId: snap.clubId ?? '',
          venue: snap.venue ?? '',
          venueAddress: snap.venueAddress ?? '',
          city: snap.city ?? '',
          mapUrl: snap.mapUrl ?? '',
          onlineUrl: snap.onlineUrl ?? '',
          accessNotes: snap.accessNotes ?? '',
          timezone: snap.timezone ?? '',
          startDate: startParts.date,
          startTime: startParts.time,
          endDate: endParts.date,
          endTime: endParts.time,
          capacity: snap.capacity == null ? '' : String(snap.capacity),
          regOpenDate: opens.date,
          regOpenTime: opens.time,
          regDeadlineDate: deadline.date,
          regDeadlineTime: deadline.time,
          registrationUrl: snap.registrationUrl ?? '',
          featured: Boolean(snap.featured),
        })
      } catch (err) {
        if (!cancelled) setError(friendlyMessage(err))
      }
    })()
    return () => { cancelled = true }
  }, [editing])

  /* Communities the organizer may act for — real membership roles only. */
  useEffect(() => {
    if (!identityId) return
    let cancelled = false
    void (async () => {
      try {
        const rows = await cm.listCommunities({ membership: 'member', limit: 60 })
        if (cancelled) return
        setManaged(rows
          .filter(c => c.my_role === 'owner' || c.my_role === 'moderator')
          .map(c => ({ id: c.id, name: c.name })))
      } catch {
        if (!cancelled) setManaged([])
      }
    })()
    return () => { cancelled = true }
  }, [identityId])

  const set = <K extends keyof typeof emptyState>(key: K, value: (typeof emptyState)[K]) => {
    setState(prev => ({ ...prev, [key]: value }))
  }

  const validateStep = (index: number): string | null => {
    if (index === 0) {
      if (state.title.trim().length < 3) return 'Give the event a title (3+ characters).'
      if (state.summary.trim().length > 280) return 'Keep the summary under 280 characters.'
      if (!state.description.trim()) return 'Add a full description so people know what to expect.'
      return null
    }
    if (index === 1) {
      if (!state.startDate || !state.startTime) return 'Pick a start date and time.'
      if (state.endDate && state.endTime && `${state.endDate}T${state.endTime}` <= `${state.startDate}T${state.startTime}`) {
        return 'The end time must come after the start.'
      }
      return null
    }
    if (index === 2) {
      if (state.format !== 'online' && !state.venue.trim()) return 'Add a venue for an in-person event.'
      if (state.format !== 'offline' && !state.onlineUrl.trim()) return 'Add a meeting or streaming link for online access.'
      return null
    }
    if (index === 3) {
      if (state.audience === 'community' && !state.clubId) return 'Choose the community this event belongs to — only ones you own or moderate can host.'
      if (state.audience === 'college' && !myCollegeId) return 'Add your college on your profile first — college events need a declared college.'
      return null
    }
    if (index === 4) {
      if (state.regType === 'registration' && state.capacity.trim() !== '' && Number(state.capacity) <= 0) {
        return 'Capacity must be a positive number.'
      }
      if (state.regDeadlineDate && !state.regDeadlineTime) return 'Pick a deadline time too.'
      if (state.regOpenDate && !state.regOpenTime) return 'Pick an opening time too.'
      if (state.regDeadlineDate && state.regDeadlineTime) {
        const deadline = ev.localInstant(state.regDeadlineDate, state.regDeadlineTime, state.timezone)
        if (deadline > buildStartsAt()) return 'The registration deadline must fall before the event starts.'
      }
      if (state.regOpenDate && state.regOpenTime && state.regDeadlineDate && state.regDeadlineTime) {
        if (ev.localInstant(state.regOpenDate, state.regOpenTime, state.timezone)
            > ev.localInstant(state.regDeadlineDate, state.regDeadlineTime, state.timezone)) {
          return 'Registration cannot open after its deadline.'
        }
      }
      return null
    }
    return null
  }

  const buildStartsAt = (): string =>
    ev.localInstant(state.startDate, state.startTime, state.timezone)

  const buildEndsAt = (): string | null =>
    state.endDate && state.endTime ? ev.localInstant(state.endDate, state.endTime, state.timezone) : null

  const buildRegOpensAt = (): string | null =>
    state.regOpenDate && state.regOpenTime
      ? ev.localInstant(state.regOpenDate, state.regOpenTime, state.timezone)
      : null

  const buildRegDeadline = (): string | null =>
    state.regDeadlineDate && state.regDeadlineTime
      ? ev.localInstant(state.regDeadlineDate, state.regDeadlineTime, state.timezone)
      : null

  const payload = (publish: boolean): ev.SaveEventInput => ({
    title: state.title.trim(),
    summary: state.summary.trim(),
    description: state.description.trim(),
    category: state.category,
    tags: state.tags.split(',').map(tag => tag.trim()).filter(Boolean),
    coverUrl: state.coverUrl || null,
    collegeId: state.audience === 'college' ? myCollegeId : null,
    clubId: state.audience === 'community' ? state.clubId : null,
    audience: state.audience,
    regEligibility: state.audience === 'community' ? 'community' : state.regEligibility,
    regType: state.regType,
    format: state.format,
    venue: state.venue.trim() || '',
    venueAddress: state.venueAddress.trim(),
    city: state.city.trim(),
    mapUrl: state.mapUrl.trim(),
    onlineUrl: state.onlineUrl.trim(),
    accessNotes: state.accessNotes.trim(),
    timezone: state.timezone,
    startsAt: buildStartsAt(),
    endsAt: buildEndsAt(),
    capacity: state.regType === 'registration' && state.capacity.trim() !== '' ? Number(state.capacity) : null,
    regOpensAt: buildRegOpensAt(),
    regDeadline: buildRegDeadline(),
    registrationUrl: state.registrationUrl.trim(),
    featured: state.featured,
    publish,
  })

  const submit = async (publish: boolean) => {
    setBusy(true)
    setError(null)
    try {
      if (detailSnapshot) {
        await ev.updateEvent(detailSnapshot.eventId, payload(publish))
        onDone(detailSnapshot.slug, state.title.trim(), detailSnapshot.published)
      } else {
        const slug = await ev.createEvent({ ...payload(publish), publish })
        onDone(slug, state.title.trim(), publish)
      }
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const uploadCover = async (file: File | null) => {
    if (!file) return
    setCoverBusy(true)
    setError(null)
    try {
      const url = await db.uploadMedia(identityId, file)
      set('coverUrl', url)
      notify('Cover image uploaded.')
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setCoverBusy(false)
    }
  }

  const next = () => {
    const problem = validateStep(step)
    if (problem) { setError(problem); return }
    setError(null)
    setStep(value => Math.min(5, value + 1))
  }
  const back = () => {
    setError(null)
    setStep(value => Math.max(0, value - 1))
  }

  /* for step-4 audience switch: eligibility follows sensible defaults */
  useEffect(() => {
    if (state.audience === 'community') {
      set('regEligibility', 'community')
    } else if (state.audience === 'college' && state.regEligibility === 'community') {
      set('regEligibility', 'college')
    }
  }, [state.audience]) // eslint-disable-line react-hooks/exhaustive-deps

  const editingMode = Boolean(detailSnapshot)

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={editingMode ? 'Edit event' : 'Create event'}>
      <div className="wizard community-detail">
        <header className="wizard-head">
          <div>
            <h2>{editingMode ? 'Edit event' : 'Create event'}</h2>
            <p>{STEPS[step]} · step {step + 1} of 6</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18}/></button>
        </header>

        <div className="wizard-track" aria-hidden>
          {[0, 1, 2, 3, 4, 5].map(index => (
            <span key={index} className={index <= step ? 'on' : ''}/>
          ))}
        </div>

        {error && (
          <div className="community-error" role="alert">
            <p>{error}</p>
            <button onClick={() => setError(null)} aria-label="Dismiss"><X size={14}/> Dismiss</button>
          </div>
        )}

        <div className="wizard-body">
          {step === 0 && (
            <div className="form-stack">
              <label className="form-field">
                <span>Event title *</span>
                <input value={state.title} onChange={e => set('title', e.target.value)} maxLength={120} placeholder="e.g. Inter-College Hackathon 2026"/>
              </label>
              <label className="form-field">
                <span>Short summary ({cardCount(state.summary)}/280)</span>
                <input value={state.summary} onChange={e => set('summary', e.target.value)} maxLength={280} placeholder="One line shown on event cards"/>
              </label>
              <label className="form-field">
                <span>Full description *</span>
                <textarea value={state.description} onChange={e => set('description', e.target.value)} rows={5} placeholder="Agenda, prizes, schedule, entry rules…"/>
              </label>
              <div className="form-field">
                <span>Category *</span>
                <div className="community-category-row wrap-chips">
                  {ev.EVENT_CATEGORIES.map(item => (
                    <button key={item} className={`community-chip${item === state.category ? ' on' : ''}`} onClick={() => set('category', item)}>
                      {item}
                    </button>
                  ))}
                </div>
              </div>
              <label className="form-field">
                <span>Tags (comma separated, up to 8)</span>
                <input value={state.tags} onChange={e => set('tags', e.target.value)} placeholder="ai, resume, inter-college"/>
              </label>
              <div className="form-field">
                <span>Cover image</span>
                <div className="cover-row">
                  {state.coverUrl
                    ? <img className="cover-preview" src={state.coverUrl} alt="Event cover"/>
                    : <span className="cover-preview placeholder"><ImageIcon size={20}/></span>}
                  <label className="secondary-button file-label">
                    {coverBusy ? <Loader2 size={15} className="spin"/> : <ImageIcon size={15}/>}
                    {coverBusy ? 'Uploading…' : 'Upload cover'}
                    <input
                      type="file"
                      accept="image/*"
                      disabled={coverBusy}
                      onChange={event => void uploadCover(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  {state.coverUrl && (
                    <button className="ghost-button" onClick={() => set('coverUrl', null)}>Remove</button>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="form-stack">
              <p className="form-note"><CalendarDays size={14}/> Times are entered in one time zone and shown to every student in <em>their</em> local time.</p>
              <div className="form-two">
                <label className="form-field">
                  <span>Start date *</span>
                  <input type="date" min={todayISO()} value={state.startDate} onChange={e => set('startDate', e.target.value)}/>
                </label>
                <label className="form-field">
                  <span>Start time *</span>
                  <input type="time" value={state.startTime} onChange={e => set('startTime', e.target.value)}/>
                </label>
              </div>
              <div className="form-two">
                <label className="form-field">
                  <span>End date</span>
                  <input type="date" min={state.startDate || todayISO()} value={state.endDate} onChange={e => set('endDate', e.target.value)}/>
                </label>
                <label className="form-field">
                  <span>End time</span>
                  <input type="time" value={state.endTime} onChange={e => set('endTime', e.target.value)}/>
                </label>
              </div>
              <label className="form-field">
                <span>Event time zone</span>
                <select value={state.timezone} onChange={e => set('timezone', e.target.value)}>
                  {ev.supportedTimezones().map(zone => (
                    <option key={zone} value={zone}>{zone}</option>
                  ))}
                </select>
              </label>
              {!state.endDate && (
                <button className="ghost-button" onClick={() => {
                  set('endDate', state.startDate)
                  if (!state.endTime) set('endTime', `${String(Math.min(23, Number(state.startTime.slice(0, 2)) + 2)).padStart(2, '0')}${state.startTime.slice(2)}`)
                }}>+ Add end time (2 hours)</button>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="form-stack">
              <div className="form-field">
                <span>Format *</span>
                <div className="community-category-row wrap-chips">
                  <button className={`scope-card${state.format === 'offline' ? ' on' : ''}`} onClick={() => set('format', 'offline')}>
                    <MapPin size={13}/> In person
                  </button>
                  <button className={`scope-card${state.format === 'online' ? ' on' : ''}`} onClick={() => set('format', 'online')}>
                    <Video size={13}/> Online
                  </button>
                  <button className={`scope-card${state.format === 'hybrid' ? ' on' : ''}`} onClick={() => set('format', 'hybrid')}>
                    <Users size={13}/> Hybrid
                  </button>
                </div>
              </div>
              {state.format !== 'online' && (
                <>
                  <label className="form-field">
                    <span>Venue *</span>
                    <input value={state.venue} onChange={e => set('venue', e.target.value)} placeholder="e.g. Convocation Hall"/>
                  </label>
                  <label className="form-field">
                    <span>Address</span>
                    <input value={state.venueAddress} onChange={e => set('venueAddress', e.target.value)} placeholder="Street / campus location"/>
                  </label>
                  <div className="form-two">
                    <label className="form-field">
                      <span>City</span>
                      <input value={state.city} onChange={e => set('city', e.target.value)} placeholder="Pune"/>
                    </label>
                    <label className="form-field">
                      <span>Map link</span>
                      <input value={state.mapUrl} onChange={e => set('mapUrl', e.target.value)} placeholder="https://maps…"/>
                    </label>
                  </div>
                </>
              )}
              {state.format !== 'offline' && (
                <>
                  <label className="form-field">
                    <span>Meeting / streaming link *</span>
                    <input value={state.onlineUrl} onChange={e => set('onlineUrl', e.target.value)} placeholder="You own this link — CAMPUS never invents one"/>
                  </label>
                  <label className="form-field">
                    <span>Access instructions (shown to registered attendees)</span>
                    <textarea value={state.accessNotes} onChange={e => set('accessNotes', e.target.value)} rows={3} placeholder="Join 10 minutes early; mute on entry…"/>
                  </label>
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="form-stack">
              <div className="form-field">
                <span>Audience — who can discover it *</span>
                <div className="scope-grid">
                  <button className={`scope-card${state.audience === 'public' ? ' on' : ''}`} onClick={() => set('audience', 'public')}>
                    <Globe2 size={16}/><b>Public</b>
                    <span>Eligible CAMPUS students everywhere can discover this event.</span>
                  </button>
                  <button className={`scope-card${state.audience === 'college' ? ' on' : ''}`} onClick={() => set('audience', 'college')}>
                    <Lock size={16}/><b>My college</b>
                    <span>{myCollegeId
                      ? `Only students of ${colleges.find(c => c.id === myCollegeId)?.short_name ?? 'your college'}.`
                      : 'Set your college on your profile first.'}</span>
                  </button>
                  <button className={`scope-card${state.audience === 'community' ? ' on' : ''}`} onClick={() => set('audience', 'community')}>
                    <Users size={16}/><b>Community</b>
                    <span>Members of one of your communities only.</span>
                  </button>
                </div>
              </div>
              {state.audience === 'community' && (
                <label className="form-field">
                  <span>Hosting community * (owner or moderator access required)</span>
                  {managed.length > 0 ? (
                    <select value={state.clubId} onChange={e => set('clubId', e.target.value)}>
                      <option value="">Choose a community…</option>
                      {managed.map(community => (
                        <option key={community.id} value={community.id}>{community.name}</option>
                      ))}
                    </select>
                  ) : (
                    <p className="form-note">You do not own or moderate any community yet — create one, or choose a public / college audience.</p>
                  )}
                </label>
              )}
              {state.audience === 'college' && myCollegeId && (
                <p className="form-note">
                  <Lock size={13}/> Students of {colleges.find(c => c.id === myCollegeId)?.name ?? myCollegeId} will discover this event; registration eligibility stays a separate choice on the next step.
                </p>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="form-stack">
              <div className="form-field">
                <span>Participation *</span>
                <div className="scope-grid">
                  <button className={`scope-card${state.regType === 'registration' ? ' on' : ''}`} onClick={() => set('regType', 'registration')}>
                    <b>Registration</b>
                    <span>Closed seat list: capacity, deadline and automatic waitlist.</span>
                  </button>
                  <button className={`scope-card${state.regType === 'rsvp' ? ' on' : ''}`} onClick={() => set('regType', 'rsvp')}>
                    <b>RSVP</b>
                    <span>Free responses (going / interested) — lighter-weight.</span>
                  </button>
                </div>
              </div>
              {state.regType === 'registration' ? (
                <>
                  <div className="form-two">
                    <label className="form-field">
                      <span>Capacity (blank = unlimited)</span>
                      <input type="number" min={1} value={state.capacity} onChange={e => set('capacity', e.target.value)} placeholder="e.g. 100"/>
                    </label>
                    <div className="form-field pick-row">
                      <span>Waitlist when full?</span>
                      <button
                        className={`toggle${state.waitlist ? ' on' : ''}`}
                        onClick={() => set('waitlist', !state.waitlist)}
                        aria-pressed={state.waitlist}
                      >{state.waitlist ? 'On' : 'Off'}</button>
                    </div>
                  </div>
                  <div className="form-two">
                    <label className="form-field">
                      <span>Registration opens</span>
                      <input type="date" value={state.regOpenDate} onChange={e => set('regOpenDate', e.target.value)}/>
                    </label>
                    <label className="form-field">
                      <span>Opening time</span>
                      <input type="time" value={state.regOpenTime} onChange={e => set('regOpenTime', e.target.value)}/>
                    </label>
                  </div>
                  <div className="form-two">
                    <label className="form-field">
                      <span>Registration deadline</span>
                      <input
                        type="date"
                        min={todayISO()}
                        max={state.startDate}
                        value={state.regDeadlineDate}
                        onChange={e => set('regDeadlineDate', e.target.value)}
                      />
                    </label>
                    <label className="form-field">
                      <span>Deadline time</span>
                      <input type="time" value={state.regDeadlineTime} onChange={e => set('regDeadlineTime', e.target.value)}/>
                    </label>
                  </div>
                  <p className="form-note">Everything is free today — CAMPUS has no payment rails, so paid events are not offered (honestly).</p>
                </>
              ) : (
                <p className="form-note"><Check size={13}/> RSVP events reuse the same responses as community events (going / interested). Capacity-locking RSVPs with waitlists needs fixed seats, so use Registration for capped events.</p>
              )}
              <label className="form-field">
                <span>External registration URL (optional)</span>
                <input value={state.registrationUrl} onChange={e => set('registrationUrl', e.target.value)} placeholder="An external form or site you run yourself"/>
              </label>
              <label className="form-field check-field">
                <input type="checkbox" checked={state.featured} onChange={e => set('featured', e.target.checked)}/>
                <span>Feature this event (shows it in the Featured strip at the top of Discover)</span>
              </label>
            </div>
          )}

          {step === 5 && (
            <div className="form-stack review-stack">
              <h3 className="review-title">
                {state.title || 'Untitled event'}
                {editingMode && <span className="muted-inline"> (editing an existing event)</span>}
              </h3>
              {state.summary && <p className="review-line">{state.summary}</p>}
              <p className="review-line">
                <CalendarDays size={13}/> {state.startDate} {state.startTime}
                {state.endDate && state.endTime ? ` → ${state.endDate} ${state.endTime}` : ''}
                {' ('}<em>{state.timezone}</em>{')'} — shown to students in their own local time.
              </p>
              <p className="review-line">
                {state.format === 'online' ? <Video size={13}/> : <MapPin size={13}/>} {' '}
                {state.format === 'online' ? `Online — ${state.onlineUrl.replace(/^https?:\/\/[^ ]+/, 'link set')}` : `${state.venue}${state.city ? `, ${state.city}` : ''}`
                }{state.format === 'hybrid' ? ' + online' : ''}
              </p>
              <p className="review-line">
                {state.audience === 'public'
                  ? <><Globe2 size={13}/> Public — everyone can discover it.</>
                  : state.audience === 'college'
                    ? <><Lock size={13}/> College-only — {colleges.find(c => c.id === myCollegeId)?.short_name ?? 'your college'} students can discover it.</>
                    : <><Users size={13}/> Community-only — {managed.find(c => c.id === state.clubId)?.name ?? 'the chosen community'} members.</>}
              </p>
              <p className="review-line">
                {state.regType === 'registration'
                  ? `Registration${state.capacity ? ` · capacity ${state.capacity}` : ' · unlimited'}${state.waitlist ? ' · waitlist on' : ''}${state.regDeadlineDate && state.regDeadlineTime ? ` · closes ${state.regDeadlineDate} ${state.regDeadlineTime}` : ''}`
                  : 'RSVP-style responses.'}
              </p>
              {state.regDeadlineDate && state.regDeadlineTime && (
                <p className="review-line warn-line">
                  In the event time zone the deadline must fall before the event starts — the server double-checks this.
                </p>
              )}
              {!editingMode && (
                <div className="publish-row">
                  <button className="primary-button" disabled={busy} onClick={() => void submit(true)}>
                    {busy ? <Loader2 size={15} className="spin"/> : <CalendarDays size={15}/>} Publish event
                  </button>
                  <button className="secondary-button" disabled={busy} onClick={() => void submit(false)}>
                    Save as draft
                  </button>
                </div>
              )}
              {editingMode && detailSnapshot && (
                <div className="publish-row">
                  <button className="primary-button" disabled={busy} onClick={() => void submit(detailSnapshot.published)}>
                    {busy ? <Loader2 size={15} className="spin"/> : <Check size={15}/>} Save changes
                  </button>
                  <p className="form-note">Publishing and cancelling are managed from the event card and detail page.</p>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="wizard-foot">
          <button className="ghost-button" onClick={back} disabled={step === 0 || busy}>
            <ChevronLeft size={15}/> Back
          </button>
          <button className="primary-button" onClick={next} disabled={step === 5 || busy}>
            Next <ChevronRight size={15}/>
          </button>
        </footer>
      </div>
    </div>
  )
}

function cardCount(value: string): number {
  return value.length
}