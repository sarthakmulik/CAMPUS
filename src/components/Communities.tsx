import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Building2, Check, ChevronRight, EyeOff, Globe, Globe2, Lock, Plus, Search,
  Users, X, Loader2, RefreshCw, Sparkles, Clock, UserPlus,
} from 'lucide-react'
import * as db from '../lib/db'
import * as cm from '../lib/communities'
import CommunityDetail from './CommunityDetail'
import { initialsFor, friendlyMessage } from '../lib/db'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  colleges: db.College[]
  myCollegeId: string | null
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
  onOpenMention: (profileId: string) => void
  openCommunityId: string | null
  setOpenCommunityId: (id: string | null) => void
}

const COMMUNITY_TABS = ['Discover', 'My Communities', 'Global', 'My College', 'Popular', 'New'] as const
type CommunityTab = typeof COMMUNITY_TABS[number]

const PAGE_SIZE = 24

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function memberSinceLabel(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const months = Math.max(0, Math.round((Date.now() - then) / (1000 * 60 * 60 * 24 * 30.4)))
  if (months < 1) return 'new community'
  if (months === 1) return '1 month old'
  if (months < 12) return `${months} months old`
  return `${Math.round(months / 12)} year${months >= 24 ? 's' : ''} old`
}

export default function Communities({
  identity, configured, colleges, myCollegeId, requireAuth, notify,
  onOpenMention, openCommunityId, setOpenCommunityId,
}: Props) {
  const [tab, setTab] = useState<CommunityTab>('Discover')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [rows, setRows] = useState<cm.CommunitySummary[]>([])
  const [invites, setInvites] = useState<cm.InviteSummary[]>([])
  const [inviteBusy, setInviteBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [createdOpen, setCreatedOpen] = useState(false)
  const debounceRef = useRef<number | null>(null)

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

  const paramsFor = useCallback((activeTab: CommunityTab, activeQuery: string, activePage: number) => {
    const base: cm.ListCommunitiesParams = {
      query: activeTab === 'Popular' || activeTab === 'New' ? '' : activeQuery,
      category: category === 'All' ? 'any' : category,
      limit: PAGE_SIZE,
      offset: activePage * PAGE_SIZE,
    }
    if (activeTab === 'My Communities') return { ...base, membership: 'member' as const }
    if (activeTab === 'Global') return { ...base, scope: 'global' as const }
    if (activeTab === 'My College') return { ...base, scope: 'college' as const, collegeId: myCollegeId }
    if (activeTab === 'Popular') return { ...base, sort: 'popular' as const }
    if (activeTab === 'New') return { ...base, sort: 'new' as const }
    return { ...base }
  }, [category, myCollegeId])

  const load = useCallback(async (activePage: number, mode: 'replace' | 'append') => {
    if (!configured) return
    setLoading(mode === 'replace')
    setError(null)
    try {
      const data = await cm.listCommunities(paramsFor(tab, debouncedQuery, activePage))
      setRows(prev => mode === 'append' ? [...prev, ...data] : data)
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLoading(false)
    }
  }, [configured, paramsFor, tab, debouncedQuery])

  useEffect(() => {
    void load(0, 'replace')
  }, [load])

  /** Pending invitations for me — refreshed alongside the discovery grid and
   *  after any respond; answers go through respond_invite (definer RPC). */
  const loadInvites = useCallback(async () => {
    if (!configured || !identity) { setInvites([]); return }
    try {
      setInvites(await cm.fetchMyInvites())
    } catch {
      setInvites([]) // invitations stay invisible on failure — honest empty strip
    }
  }, [configured, identity])

  useEffect(() => {
    void loadInvites()
  }, [loadInvites])

  const respondToInvite = async (invite: cm.InviteSummary, accept: boolean) => {
    setInviteBusy(invite.invite_id)
    try {
      const result = await cm.respondInvite(invite.invite_id, accept)
      notify(result === 'accepted'
        ? `Welcome to ${invite.club_name}!`
        : `Invitation to ${invite.club_name} declined.`)
      setInvites(current => current.filter(i => i.invite_id !== invite.invite_id))
      refresh()
    } catch (err) {
      setError(friendlyMessage(err))
      void loadInvites()
    } finally {
      setInviteBusy(null)
    }
  }

  const refresh = useCallback(() => {
    void load(0, 'replace')
  }, [load])

  const openCommunity = (id: string) => {
    const allowed = requireAuth('Sign in to open community pages.', 'Communities')
    if (!allowed) return
    setOpenCommunityId(id)
  }

  const joinRow = async (row: cm.CommunitySummary) => {
    if (!identity) {
      requireAuth('Sign in to join communities.', 'Communities')
      return
    }
    try {
      const result = await cm.joinCommunity(row.id)
      if (result === 'requested') notify(`Request sent to ${row.name} — a moderator will review it.`)
      else notify(`Welcome to ${row.name}!`)
      refresh()
    } catch (err) {
      setError(friendlyMessage(err))
    }
  }

  const cancelRequest = async (row: cm.CommunitySummary) => {
    try {
      await cm.cancelJoinRequest(row.id)
      notify('Request cancelled.')
      refresh()
    } catch (err) {
      setError(friendlyMessage(err))
    }
  }

  if (openCommunityId) {
    return (
      <CommunityDetail
        communityId={openCommunityId}
        identity={identity}
        configured={configured}
        requireAuth={requireAuth}
        notify={notify}
        onOpenMention={onOpenMention}
        onBack={() => { setOpenCommunityId(null); refresh() }}
      />
    )
  }

  const emptyCopy: { icon: typeof Users; title: string; body: string } =
    tab === 'My Communities'
      ? { icon: Users, title: 'No communities yet', body: identity ? 'Join a community from Discover to find your people.' : 'Sign in to start or join communities.' }
      : tab === 'My College' && !myCollegeId
        ? { icon: Building2, title: 'Pick your college first', body: 'Add your college on your profile to see communities from your campus.' }
        : { icon: Search, title: 'No communities found', body: 'Try another search term, tab or category — or start the first one.' }

  return (
    <div className="communities-page">
      <header className="communities-head">
        <div>
          <h1 className="page-title">Communities</h1>
          <p className="page-subtitle">Spaces for your interests, branches, batches and dorm life — global or on your campus.</p>
        </div>
        <button className="primary-button" onClick={() => { if (!requireAuth('Sign in to create a community.', 'Communities')) return; setCreatedOpen(true) }}>
          <Plus size={18}/> Create community
        </button>
      </header>

      <div className="community-searchbar">
        <Search size={18}/>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search communities by name or description"
          aria-label="Search communities"
        />
        {query && <button className="icon-button" onClick={() => setQuery('')} aria-label="Clear search"><X size={16}/></button>}
      </div>

      {invites.length > 0 && (
        <div className="invite-strip" role="region" aria-label="Community invitations">
          {invites.map(invite => (
            <div key={invite.invite_id} className="invite-strip-row">
              <span className="invite-icon"><UserPlus size={16}/></span>
              <span className="invite-copy">
                <b>{invite.club_name}</b> invited you
                {invite.invited_by_username && (
                  <span className="muted-inline"> by @{invite.invited_by_username}</span>
                )}
                {invite.club_privacy === 'hidden' && (
                  <span className="muted-inline"> — {invite.club_name} stays hidden until you accept</span>
                )}
              </span>
              <span className="invite-actions">
                <button
                  className="primary-button small"
                  disabled={inviteBusy === invite.invite_id}
                  onClick={() => void respondToInvite(invite, true)}
                >Join</button>
                <button
                  className="secondary-button"
                  disabled={inviteBusy === invite.invite_id}
                  onClick={() => void respondToInvite(invite, false)}
                >Decline</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <nav className="community-tabs" aria-label="Community discovery tabs">
        {COMMUNITY_TABS.map(item => (
          <button
            key={item}
            className={item === tab ? 'on' : ''}
            onClick={() => { setTab(item); setPage(0) }}
          >
            {item}
          </button>
        ))}
      </nav>

      <div className="community-category-row">
        {['All', ...cm.COMMUNITY_CATEGORIES].map(item => (
          <button
            key={item}
            className={`community-chip${item === category ? ' on' : ''}`}
            onClick={() => { setCategory(item); setPage(0) }}
          >
            {item}
          </button>
        ))}
      </div>

      {error && (
        <div className="community-error" role="alert">
          <p>{error}</p>
          <button onClick={refresh}><RefreshCw size={15}/> Try again</button>
        </div>
      )}

      {loading && (
        <div className="community-grid" aria-label="Loading communities">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="community-card skeleton-card">
              <div className="community-card-banner skeleton-block"/>
              <div className="community-card-row"><div className="avatar skeleton-block"/><div className="skeleton-lines"><div className="skeleton-block w60"/><div className="skeleton-block w40"/></div></div>
              <div className="skeleton-lines">
                <div className="skeleton-block w90"/>
                <div className="skeleton-block w70"/>
              </div>
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
          <div className="community-grid">
            {rows.map(row => (
              <CommunityCard
                key={row.id}
                row={row}
                onOpen={() => openCommunity(row.id)}
                onJoin={() => void joinRow(row)}
                onCancel={() => void cancelRequest(row)}
              />
            ))}
          </div>
          {rows.length >= (page + 1) * PAGE_SIZE && (
            <div className="community-more">
              <button onClick={() => { const next = page + 1; setPage(next); void load(next, 'append') }}>
                {loading ? <Loader2 size={16} className="spin"/> : null}
                Load more communities
              </button>
            </div>
          )}
        </>
      )}

      {createdOpen && (
        <CreateCommunityModal
          identity={identity}
          colleges={colleges}
          myCollegeId={myCollegeId}
          onClose={() => setCreatedOpen(false)}
          onCreated={(id, name) => {
            setCreatedOpen(false)
            notify(`${name} is live — you are its first owner.`)
            setOpenCommunityId(id)
          }}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                       */
/* -------------------------------------------------------------------------- */

function CommunityCard({ row, onOpen, onJoin, onCancel }: {
  row: cm.CommunitySummary
  onOpen: () => void
  onJoin: () => void
  onCancel: () => void
}) {
  const member = row.my_status === 'active'
  const pending = row.my_status === 'pending'
  const banned = row.my_status === 'banned'
  const initials = initialsFor(row.name, row.slug)

  return (
    <article className="community-card">
      <button className="community-card-banner" onClick={member ? onOpen : undefined} tabIndex={member ? 0 : -1} aria-label={`Open ${row.name}`}>
        {row.cover_image_url
          ? <img src={row.cover_image_url} alt="" loading="lazy"/>
          : <span className="community-card-banner-fallback" style={{ background: bannerGradient(row.slug) }}/>}
      </button>
      <div className="community-card-row">
        <span className="avatar community-avatar">{row.logo_url
          ? <img src={row.logo_url} alt="" loading="lazy"/>
          : initials}</span>
        <button className="community-card-title" onClick={() => { if (member || row.privacy !== 'hidden') onOpen() }}>
          <b>{row.name}</b>
          <span className="community-card-scope">
            {row.scope === 'college'
              ? <><Building2 size={12}/>{row.college_short_name ?? 'College'}</>
              : <><Globe2 size={12}/>Global</>}
          </span>
        </button>
        {member && <span className="community-joined-chip"><Check size={12}/> Member</span>}
        {pending && <span className="community-pending-chip"><Clock size={12}/> Requested</span>}
        {banned && <span className="community-banned-chip">Removed</span>}
      </div>
      {row.privacy !== 'public' && (
        <div className="community-privacy-note">
          {row.privacy === 'private'
            ? <><Lock size={12}/> Private — content visible to members only</>
            : <><EyeOff size={12}/> Hidden — listed for members only</>}
        </div>
      )}
      <p className="community-card-desc">{row.description || 'No description yet.'}</p>
      <div className="community-card-meta">
        {row.category && <span className="community-card-category">{row.category}</span>}
        <span className="community-card-members"><Users size={13}/> {row.member_count} member{row.member_count === 1 ? '' : 's'}</span>
        <span className="community-card-age">{memberSinceLabel(row.created_at)}</span>
      </div>
      <div className="community-card-actions">
        {member && <button className="primary-button" onClick={onOpen}>Open community <ChevronRight size={15}/></button>}
        {pending && <button className="ghost-action" onClick={onCancel}>Cancel request</button>}
        {!member && !pending && !banned && row.privacy === 'public' && (
          <button className="primary-button" onClick={onJoin}>{row.scope === 'college' ? 'Join' : 'Join'}</button>
        )}
        {!member && !pending && !banned && row.privacy === 'private' && (
          <button className="primary-button" onClick={onJoin}><UserPlus size={15}/> Request to join</button>
        )}
        {!member && !pending && !banned && row.privacy === 'hidden' && (
          <span className="community-invite-note">Invitation only — ask a member to invite you.</span>
        )}
        {banned && <span className="community-invite-note">Moderators removed you from this community.</span>}
      </div>
    </article>
  )
}

function bannerGradient(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${hash} 70% 62%), hsl(${(hash + 48) % 360} 70% 52%))`
}

/* -------------------------------------------------------------------------- */
/* Create-flow wizard                                                          */
/* -------------------------------------------------------------------------- */

const WIZARD_STEPS = ['Basics', 'Scope', 'Privacy', 'Rules & review'] as const

function CreateCommunityModal({ identity, colleges, myCollegeId, onClose, onCreated }: {
  identity: Identity | null
  colleges: db.College[]
  myCollegeId: string | null
  onClose: () => void
  onCreated: (id: string, name: string) => void
}) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<typeof cm.COMMUNITY_CATEGORIES[number]>('Other')
  const [scope, setScope] = useState<cm.CommunityScope | null>(null)
  const [collegeId, setCollegeId] = useState<string>(myCollegeId ?? '')
  const [privacy, setPrivacy] = useState<cm.CommunityPrivacy | null>(null)
  const [rules, setRules] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [logoBusy, setLogoBusy] = useState(false)
  const [coverBusy, setCoverBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logoInputRef = useRef<HTMLInputElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  const effectiveSlug = slugTouched ? slugify(slug) : slugify(name)

  const localError = (): string | null => {
    const trimmedName = name.trim()
    if (trimmedName.length < 3 || trimmedName.length > 60) return 'Community name must be 3-60 characters.'
    if (effectiveSlug.length < 3) return 'The URL slug needs at least 3 characters.'
    if (scope === 'college') {
      if (!collegeId) return 'Pick the college this community belongs to.'
      if (myCollegeId && collegeId !== myCollegeId) return 'College communities belong to your own declared college.'
    }
    return null
  }

  const next = () => {
    const problem = step === 0 ? null : localError()
    if (step > 0 && problem) { setError(problem); return }
    // a step's required choice must exist before you can leave that step —
    // otherwise the gap only surfaces at submit, after the review said "Global"
    if (step === 0 && !name.trim()) { setError('Give the community a name.'); return }
    if (step === 1 && !scope) { setError('Choose the community scope.'); return }
    if (step === 2 && !privacy) { setError('Choose the community privacy.'); return }
    setError(null)
    setStep(current => Math.min(current + 1, WIZARD_STEPS.length - 1))
  }

  const pickLogo = async (file: File | undefined) => {
    if (!file || !identity) return
    const problem = db.validateAvatarFile(file)
    if (problem) { setError(problem); return }
    setLogoBusy(true)
    setError(null)
    try {
      const url = await db.uploadMedia(identity.id, file)
      setLogoUrl(url)
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setLogoBusy(false)
    }
  }

  const pickCover = async (file: File | undefined) => {
    if (!file || !identity) return
    const problem = db.validateAvatarFile(file)
    if (problem) { setError(problem); return }
    setCoverBusy(true)
    setError(null)
    try {
      const url = await db.uploadMedia(identity.id, file)
      setCoverUrl(url)
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setCoverBusy(false)
    }
  }

  const submit = async () => {
    if (!identity) return
    const problem = localError()
    if (problem) { setError(problem); return }
    if (!scope) { setError('Choose the community scope.'); return }
    if (!privacy) { setError('Choose the community privacy.'); return }
    setBusy(true)
    setError(null)
    try {
      const id = await cm.createCommunity({
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim(),
        category,
        scope,
        collegeId: scope === 'college' ? collegeId : null,
        privacy,
        rules: rules.trim(),
        logoUrl,
        coverUrl,
      })
      onCreated(id, name.trim())
    } catch (err) {
      setError(friendlyMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        className="community-create-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Create a community"
        onClick={event => event.stopPropagation()}
      >
        <header className="community-create-head">
          <div>
            <h2>Create a community</h2>
            <ol className="community-wizard-steps" aria-label="Steps">
              {WIZARD_STEPS.map((label, index) => (
                <li key={label} className={index === step ? 'on' : ''}>
                  <span className="wizard-dot">{index < step ? <Check size={12}/> : index + 1}</span>
                  {label}
                </li>
              ))}
            </ol>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18}/></button>
        </header>

        {error && <div className="form-error" role="alert">{error}</div>}

        {step === 0 && (
          <div className="community-create-body">
            <div className="community-create-images">
              <button className="community-avatar-picker" onClick={() => logoInputRef.current?.click()} disabled={logoBusy}>
                {logoBusy ? <Loader2 size={16} className="spin"/> : logoUrl ? <img src={logoUrl} alt=""/> : <Plus size={18}/>}
                <span>{logoUrl ? 'Change' : 'Avatar'}</span>
              </button>
              <button className="community-cover-picker" onClick={() => coverInputRef.current?.click()} disabled={coverBusy}>
                {coverBusy ? <Loader2 size={16} className="spin"/> : coverUrl ? <img src={coverUrl} alt=""/> : <><Plus size={18}/> <span>Cover image</span></>}
              </button>
              <input ref={logoInputRef} type="file" accept="image/*" hidden onChange={event => void pickLogo(event.target.files?.[0])}/>
              <input ref={coverInputRef} type="file" accept="image/*" hidden onChange={event => void pickCover(event.target.files?.[0])}/>
            </div>

            <label>
              Name
              <input value={name} onChange={event => { setName(event.target.value); setSlugTouched(false) }} maxLength={60} placeholder="e.g. Robotics & Makers"/>
            </label>
            <label>
              URL slug
              <span className="slug-preview">campus.app/communities/{effectiveSlug || '…'}</span>
              <input
                value={slug}
                onChange={event => { setSlug(event.target.value); setSlugTouched(true) }}
                placeholder="robotics-makers"
              />
            </label>
            <label>
              Description
              <textarea
                value={description}
                onChange={event => setDescription(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="What is this community about?"
              />
            </label>
            <div className="community-category-picker" role="group" aria-label="Category">
              {cm.COMMUNITY_CATEGORIES.map(item => (
                <button key={item} className={`community-chip${item === category ? ' on' : ''}`} onClick={() => setCategory(item)}>{item}</button>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="community-create-body">
            <button className={`scope-choice${scope === 'global' ? ' on' : ''}`} onClick={() => setScope('global')}>
              <Globe2 size={22}/>
              <div>
                <b>Global community</b>
                <p>Open to students of every college. Great for interests that go beyond one campus — hackathons, gaming, photography, careers.</p>
              </div>
            </button>
            <button className={`scope-choice${scope === 'college' ? ' on' : ''}`} onClick={() => setScope('college')} disabled={!myCollegeId}>
              <Building2 size={22}/>
              <div>
                <b>College community</b>
                <p>{myCollegeId
                  ? 'Belongs to your declared college. Classmates of that college join; other colleges cannot.'
                  : 'Add your college on your profile first — college communities belong to a declared college.'}</p>
                {colleges.length > 0 && myCollegeId && (
                  <select value={collegeId} onChange={event => setCollegeId(event.target.value)} aria-label="College">
                    {colleges.map(college => (
                      <option key={college.id} value={college.id} disabled={college.id !== myCollegeId}>
                        {college.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="community-create-body">
            <button className={`privacy-choice${privacy === 'public' ? ' on' : ''}`} onClick={() => setPrivacy('public')}>
              <Globe size={20}/>
              <div><b>Public</b><p>Anyone can find it and read its feed; membership is open (college communities still check your declared college).</p></div>
            </button>
            <button className={`privacy-choice${privacy === 'private' ? ' on' : ''}`} onClick={() => setPrivacy('private')}>
              <Lock size={20}/>
              <div><b>Private</b><p>Anyone may find it, but joining needs a moderator's approval — or an invitation.</p></div>
            </button>
            <button className={`privacy-choice${privacy === 'hidden' ? ' on' : ''}`} onClick={() => setPrivacy('hidden')}>
              <EyeOff size={20}/>
              <div><b>Hidden</b><p>Invisible outside the community. Only members — and people holding a link — can reach it; joining is by invitation only.</p></div>
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="community-create-body">
            <label>
              Community rules <span className="optional-mark">(optional)</span>
              <textarea
                value={rules}
                onChange={event => setRules(event.target.value)}
                maxLength={2000}
                rows={4}
                placeholder="One rule per line — they appear on the community's About tab."
              />
            </label>
            <dl className="community-review">
              <div><dt>Name</dt><dd>{name.trim()}</dd></div>
              <div><dt>Slug</dt><dd>/communities/{effectiveSlug}</dd></div>
              <div><dt>Category</dt><dd>{category}</dd></div>
              <div><dt>Scope</dt><dd>{scope === 'college' ? `College — ${colleges.find(c => c.id === collegeId)?.name ?? 'your college'}` : scope === 'global' ? 'Global' : 'Not chosen yet'}</dd></div>
              <div><dt>Privacy</dt><dd className="capitalize">{privacy ?? 'Not chosen yet'}</dd></div>
            </dl>
          </div>
        )}

        <footer className="community-create-foot">
          {step > 0 && <button className="ghost-action" onClick={() => { setStep(step - 1); setError(null) }}>Back</button>}
          <span className="wizard-flex"/>
          {step < WIZARD_STEPS.length - 1
            ? <button className="primary-button" onClick={next}>Continue <ChevronRight size={15}/></button>
            : <button className="primary-button" onClick={() => void submit()} disabled={busy}>
                {busy ? <><Loader2 size={16} className="spin"/> Creating…</> : <><Sparkles size={16}/> Create community</>}
              </button>}
        </footer>
      </div>
    </div>
  )
}
