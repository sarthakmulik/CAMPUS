import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  AlertCircle, ArrowLeft, ArrowRight, BookOpen, Building2, Check,
  Search, Sparkles, Upload, UserRound, Users,
} from 'lucide-react'
import { useAuth } from '../lib/auth'
import * as db from '../lib/db'
import { supabase } from '../lib/supabase'

type StepKey = 'name' | 'username' | 'college' | 'academics' | 'profile' | 'welcome'

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'name', label: 'Your name' },
  { key: 'username', label: 'Username' },
  { key: 'college', label: 'College' },
  { key: 'academics', label: 'Academics' },
  { key: 'profile', label: 'Profile' },
  { key: 'welcome', label: 'Welcome' },
]

const COURSES = ['B.Tech', 'B.E.', 'B.Sc', 'B.Com', 'BBA', 'BCA', 'BA', 'M.Tech', 'M.Sc', 'MBA', 'MCA', 'MA', 'Ph.D.']
const DEPARTMENTS = [
  'Computer Science', 'Information Technology', 'Electronics & Telecommunication', 'Electrical',
  'Mechanical', 'Civil', 'Chemical', 'Biotechnology', 'Artificial Intelligence & Data Science', 'Other',
]
const YEARS = [
  { value: '1', label: 'First year' },
  { value: '2', label: 'Second year' },
  { value: '3', label: 'Third year' },
  { value: '4', label: 'Fourth year' },
  { value: '5', label: 'Fifth year' },
  { value: '6', label: 'Postgraduate' },
]

const clean = (value: string) => value.trim().normalize('NFC')

/**
 * Six-step onboarding wizard shown to a signed in member whose profile is not
 * finished yet. Steps 1-4 are required (name, username, college, academics can
 * be skipped per field), step 5 is optional personalisation, step 6 confirms.
 *
 * Every save goes to Supabase through `patchProfile`; failures are shown, never
 * swallowed, and the wizard stays on the step so nothing is silently lost.
 */
export default function OnboardingWizard() {
  const auth = useAuth()
  const { profile, user, caps, colleges, topics, clubs, patchProfile, setStep: persistStep, notify } = auth

  const [step, setLocalStep] = useState(() => Math.min(Math.max(auth.step, 0), 5))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [first, setFirst] = useState(() => profile?.first_name ?? '')
  const [last, setLast] = useState(() => profile?.last_name ?? '')
  const [username, setUsername] = useState(() => profile?.username ?? '')
  const [usernameState, setUsernameState] = useState<db.UsernameCheck>('idle')
  const [usernameMessage, setUsernameMessage] = useState<string | null>(null)

  const [collegeQuery, setCollegeQuery] = useState('')
  const [collegeId, setCollegeId] = useState(() => profile?.college_id ?? '')
  const [showSuggest, setShowSuggest] = useState(false)
  const [suggestName, setSuggestName] = useState('')
  const [suggestCity, setSuggestCity] = useState('')
  const [suggested, setSuggested] = useState<string | null>(null)

  const [course, setCourse] = useState(() => profile?.course ?? '')
  const [department, setDepartment] = useState(() => profile?.department ?? '')
  const [year, setYear] = useState(() => (profile?.year_of_study ? String(profile.year_of_study) : ''))

  const [avatarPreview, setAvatarPreview] = useState<string | null>(() => profile?.avatar_url ?? null)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [bio, setBio] = useState(() => profile?.bio ?? '')
  const [interests, setInterests] = useState<string[]>([])
  const [selectedClubs, setSelectedClubs] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement | null>(null)

  // Load saved interests once.
  useEffect(() => {
    if (!user) return
    void db.loadInterests(user.id).then(setInterests)
  }, [user])

  const selectedCollege = useMemo(
    () => colleges.find(college => college.id === collegeId) ?? null,
    [colleges, collegeId],
  )

  // Debounced username availability.
  useEffect(() => {
    const value = db.normalizeUsername(username)
    if (!value) {
      setUsernameState('idle')
      setUsernameMessage(null)
      return
    }
    // Re-running the wizard keeps your existing handle: it is still valid and
    // still yours, so treat it as available instead of blocking Continue.
    if (value === (profile?.username ?? '')) {
      setUsernameState('available')
      setUsernameMessage('That is your current username.')
      return
    }
    if (db.usernameError(value)) {
      setUsernameState('invalid')
      setUsernameMessage(db.usernameError(value))
      return
    }
    setUsernameState('checking')
    setUsernameMessage(null)
    const handle = window.setTimeout(() => {
      void db.checkUsername(value, caps, profile?.username).then(result => {
        setUsernameState(result.state)
        setUsernameMessage(result.message ?? null)
      })
    }, 450)
    return () => window.clearTimeout(handle)
  }, [username, caps, profile?.username])

  const collegeMatches = useMemo(() => {
    const query = collegeQuery.trim().toLowerCase()
    if (!query) return colleges.slice(0, 8)
    return colleges
      .filter(college =>
        `${college.name} ${college.short_name} ${college.city}`.toLowerCase().includes(query),
      )
      .slice(0, 8)
  }, [colleges, collegeQuery])

  const goTo = (next: number) => {
    setError(null)
    setLocalStep(next)
    persistStep(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const validateStep = (): string | null => {
    if (step === 0) {
      if (!clean(first)) return 'Enter your first name.'
      if (!clean(last)) return 'Enter your last name.'
      if (clean(first).length > 40 || clean(last).length > 40) return 'Names are limited to 40 characters.'
      return null
    }
    if (step === 1) {
      const value = db.normalizeUsername(username)
      const message = db.usernameError(value)
      if (message) return message
      if (usernameState === 'checking') return 'Wait for the username check to finish.'
      if (usernameState === 'taken') return 'That username is taken. Try another.'
      if (usernameState === 'invalid') return usernameMessage ?? 'Choose a different username.'
      if (usernameState === 'idle') return 'Check that this username is available.'
      return null
    }
    // Admins are platform-level and are never assigned a college (0042) —
    // let them continue past the college step without choosing one.
    if (step === 2 && !collegeId && !suggested && profile?.role !== 'admin') {
      return 'Choose your college, or request that we add it.'
    }
    if (step === 3) {
      if (year) {
        const value = Number(year)
        if (!Number.isFinite(value) || value < 1 || value > 6) return 'Choose a valid academic year.'
      }
      return null
    }
    if (step === 4) {
      if (bio.length > 160) return 'Keep your bio under 160 characters.'
      return null
    }
    return null
  }

  const saveStep = async (): Promise<boolean> => {
    if (step === 0) {
      const message = await patchProfile({
        first_name: clean(first),
        last_name: clean(last),
        display_name: `${clean(first)} ${clean(last)}`,
      })
      if (message) return fail(message)
    }
    if (step === 1) {
      const message = await patchProfile({ username: db.normalizeUsername(username) })
      if (message) return fail(message)
    }
    if (step === 2) {
      const now = new Date().toISOString()
      const message = await patchProfile({ college_id: collegeId || null, college_declared_at: now })
      if (message) return fail(message)
    }
    if (step === 3) {
      const message = await patchProfile({
        course: clean(course) || null,
        department: clean(department) || null,
        year_of_study: year ? Number(year) : null,
      })
      if (message) return fail(message)
    }
    if (step === 4) {
      const message = await patchProfile({ bio: clean(bio), avatar_url: avatarPreview })
      if (message) return fail(message)
      if (user && caps.interests) {
        try {
          await db.saveInterests(user.id, interests, caps)
        } catch (interestError) {
          notify(db.friendlyMessage(interestError))
        }
      }
    }
    if (step === 5) {
      const message = await patchProfile({
        onboarding_step: 6,
        onboarding_completed_at: new Date().toISOString(),
      })
      if (message) return fail(message)
    }
    return true
  }

  const fail = (message: string): false => {
    setError(message)
    return false
  }

  const onContinue = async () => {
    const validation = validateStep()
    if (validation) {
      setError(validation)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await saveStep()
      // The final step already completed onboarding (account state flips to
      // member and this wizard unmounts) — advancing again would rewrite the
      // saved step backwards.
      if (saved && step < STEPS.length - 1) goTo(step + 1)
    } finally {
      setBusy(false)
    }
  }

  const onSkipOptional = async () => {
    setBusy(true)
    setError(null)
    try {
      const saved = await saveStep()
      if (saved && step < STEPS.length - 1) goTo(step + 1)
    } finally {
      setBusy(false)
    }
  }

  const onPickAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const problem = db.validateAvatarFile(file)
    if (problem) {
      setAvatarError(problem)
      return
    }
    if (!user) return
    setAvatarError(null)
    setBusy(true)
    try {
      const url = await db.uploadAvatar(user.id, file)
      setAvatarPreview(url)
    } catch (uploadError) {
      setAvatarError(
        `${db.friendlyMessage(uploadError)} You can continue with the initials avatar and add a photo later.`,
      )
    } finally {
      setBusy(false)
    }
  }

  const submitSuggestion = async () => {
    setBusy(true)
    setError(null)
    try {
      await db.submitCollegeSuggestion(suggestName, suggestCity, caps)
      setSuggested(clean(suggestName))
      setShowSuggest(false)
      setSuggestName('')
      setSuggestCity('')
    } catch (suggestionError) {
      setError(db.friendlyMessage(suggestionError))
    } finally {
      setBusy(false)
    }
  }

  const toggleClub = async (clubId: string) => {
    if (!user) return
    const joining = !selectedClubs.includes(clubId)
    setSelectedClubs(current => (joining ? [...current, clubId] : current.filter(id => id !== clubId)))
    try {
      if (!supabase) throw new Error('CAMPUS is not connected.')
      const query = joining
        ? supabase.from('club_members').insert({ club_id: clubId, user_id: user.id })
        : supabase.from('club_members').delete().eq('club_id', clubId).eq('user_id', user.id)
      const { error } = await query
      if (error) throw new Error(db.friendlyMessage(error))
    } catch (clubError) {
      setSelectedClubs(current => (joining ? current.filter(id => id !== clubId) : [...current, clubId]))
      notify(db.friendlyMessage(clubError))
    }
  }

  const current = STEPS[step]

  return (
    <div className="wizard-shell">
      <header className="wizard-topbar">
        <span className="brand"><span className="brand-mark">C</span><span>CAMPUS</span></span>
        <span className="wizard-progress-label">Step {step + 1} of {STEPS.length} · {current.label}</span>
        <button className="text-button" onClick={() => void auth.signOut()} title="Sign out and finish later">Sign out</button>
      </header>

      <div className="wizard-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-label="Onboarding progress">
        {STEPS.map((item, index) => (
          <span key={item.key} className={`progress-segment ${index < step ? 'done' : ''} ${index === step ? 'current' : ''}`}>
            <button
              type="button"
              disabled={index > step || busy}
              onClick={() => index < step && goTo(index)}
              title={index <= step ? `Back to ${item.label}` : item.label}
            >
              <i>{index < step ? <Check size={13} /> : index + 1}</i>
              <b>{item.label}</b>
            </button>
          </span>
        ))}
      </div>

      <main className="wizard-card">
        {!caps.profileExtras && step < 5 && (
          <p className="wizard-note">
            <AlertCircle size={14} /> Your answers are saved as you go. Apply
            <code> supabase/migrations/0001_explore_first_onboarding.sql </code>
            to store every field permanently in your profile.
          </p>
        )}

        {error && (
          <p className="form-error" role="alert"><AlertCircle size={15} /> {error}</p>
        )}

        {step === 0 && (
          <section className="wizard-step">
            <span className="section-hero-icon"><UserRound size={24} /></span>
            <h2>What should we call you?</h2>
            <p className="wizard-lead">Your name shows on your posts and profile. You can change it later.</p>
            <div className="field-row">
              <label className="field-label">First name
                <input value={first} onChange={event => setFirst(event.target.value)} placeholder="Aarav" maxLength={40} autoFocus />
              </label>
              <label className="field-label">Last name
                <input value={last} onChange={event => setLast(event.target.value)} placeholder="Kulkarni" maxLength={40} />
              </label>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="wizard-step">
            <span className="section-hero-icon">@</span>
            <h2>Pick your username</h2>
            <p className="wizard-lead">Letters, numbers and underscores, 3–20 characters. It has to be unique across CAMPUS.</p>
            <label className="field-label">Username
              <span className="input-with-action">
                <input
                  value={username}
                  onChange={event => setUsername(db.normalizeUsername(event.target.value))}
                  placeholder="aarav_k"
                  maxLength={20}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="username-status"
                />
                <span id="username-status" className={`username-status ${usernameState}`}>
                  {usernameState === 'checking' && 'Checking…'}
                  {usernameState === 'available' && 'Available'}
                  {usernameState === 'taken' && 'Taken'}
                  {usernameState === 'invalid' && 'Invalid'}
                </span>
              </span>
            </label>
            {usernameMessage && <p className="field-hint">{usernameMessage}</p>}
            {usernameState === 'available' && !usernameMessage && <p className="field-hint success">@{db.normalizeUsername(username)} is all yours.</p>}
          </section>
        )}

        {step === 2 && (
          <section className="wizard-step">
            <span className="section-hero-icon"><Building2 size={24} /></span>
            <h2>Which college is yours?</h2>
            <p className="wizard-lead">
              This is a self-declared affiliation — CAMPUS does not verify enrolment and never asks for a student ID.
            </p>
            <label className="field-label">Search colleges
              <span className="input-with-action">
                <Search size={16} />
                <input
                  value={collegeQuery}
                  onChange={event => { setCollegeQuery(event.target.value); setShowSuggest(false) }}
                  placeholder="College name or city"
                  autoComplete="off"
                />
              </span>
            </label>

            <ul className="college-list">
              {collegeMatches.map(college => (
                <li key={college.id}>
                  <button
                    type="button"
                    className={`college-option ${collegeId === college.id ? 'selected' : ''}`}
                    onClick={() => { setCollegeId(college.id); setSuggested(null); setError(null) }}
                  >
                    <span className="college-seal"><Building2 size={17} /></span>
                    <span className="college-option-copy">
                      <b>{college.name}</b>
                      <small>{college.short_name} · {college.city}{college.verified ? ' · listed' : ''}</small>
                    </span>
                    {collegeId === college.id && <Check size={17} />}
                  </button>
                </li>
              ))}
              {collegeMatches.length === 0 && !showSuggest && (
                <li className="college-empty">No college matched “{collegeQuery}”. You can request it below.</li>
              )}
            </ul>

            {suggested && (
              <p className="field-hint success">
                “{suggested}” was sent to the CAMPUS team for review. You can continue now and it will appear in
                search once it is added.
              </p>
            )}

            {!showSuggest ? (
              <button className="text-button" onClick={() => setShowSuggest(true)}>My college is not listed — request it</button>
            ) : (
              <div className="suggest-box">
                <h3>Request a college</h3>
                <label className="field-label">College name
                  <input value={suggestName} onChange={event => setSuggestName(event.target.value)} placeholder="For example, Symbiosis Institute of Technology" maxLength={120} />
                </label>
                <label className="field-label">City <span className="optional">optional</span>
                  <input value={suggestCity} onChange={event => setSuggestCity(event.target.value)} placeholder="Pune" maxLength={60} />
                </label>
                <div className="wizard-actions inline">
                  <button className="secondary-button" onClick={() => setShowSuggest(false)} disabled={busy}>Cancel</button>
                  <button className="primary-button" onClick={() => void submitSuggestion()} disabled={busy || clean(suggestName).length < 2}>
                    {busy ? 'Sending…' : 'Send request'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {step === 3 && (
          <section className="wizard-step">
            <span className="section-hero-icon"><BookOpen size={24} /></span>
            <h2>Your course and year</h2>
            <p className="wizard-lead">All optional. These help CAMPUS suggest relevant clubs, events and placements.</p>
            <label className="field-label">Course or degree <span className="optional">optional</span>
              <input value={course} onChange={event => setCourse(event.target.value)} list="course-options" placeholder="B.Tech" maxLength={60} />
              <datalist id="course-options">{COURSES.map(item => <option key={item} value={item} />)}</datalist>
            </label>
            <label className="field-label">Department or branch <span className="optional">optional</span>
              <input value={department} onChange={event => setDepartment(event.target.value)} list="dept-options" placeholder="Computer Science" maxLength={80} />
              <datalist id="dept-options">{DEPARTMENTS.map(item => <option key={item} value={item} />)}</datalist>
            </label>
            <label className="field-label">Academic year <span className="optional">optional</span>
              <select value={year} onChange={event => setYear(event.target.value)}>
                <option value="">Prefer not to say</option>
                {YEARS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
          </section>
        )}

        {step === 4 && (
          <section className="wizard-step">
            <span className="section-hero-icon"><Sparkles size={24} /></span>
            <h2>Personalise your profile</h2>
            <p className="wizard-lead">Everything here is optional — skip it and set it up later from your profile.</p>

            <div className="avatar-picker">
              <span className="avatar avatar-large">
                {avatarPreview ? <img src={avatarPreview} alt="" /> : `${(first[0] ?? 'C').toUpperCase()}${(last[0] ?? '').toUpperCase()}`}
              </span>
              <div className="avatar-picker-actions">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="visually-hidden"
                  onChange={event => void onPickAvatar(event)}
                />
                <button className="secondary-button" onClick={() => fileInput.current?.click()} disabled={busy}>
                  <Upload size={15} /> {avatarPreview ? 'Change photo' : 'Upload photo'}
                </button>
                {avatarPreview && (
                  <button
                    className="text-button"
                    onClick={() => { setAvatarPreview(null); setAvatarError(null) }}
                    disabled={busy}
                  >
                    Use initials instead
                  </button>
                )}
                <small>JPG, PNG or WebP, up to 2 MB. Stored in your own private folder.</small>
              </div>
            </div>
            {avatarError && <p className="form-error" role="alert"><AlertCircle size={15} /> {avatarError}</p>}

            <label className="field-label">Short bio <span className="optional">{bio.length}/160</span>
              <textarea value={bio} onChange={event => setBio(event.target.value)} rows={3} maxLength={160} placeholder="Robotics club, hostels, and unreasonable amounts of chai." />
            </label>

            <fieldset className="chip-fieldset">
              <legend>Topics you care about</legend>
              <div className="chip-row">
                {topics.map(topic => {
                  const active = interests.includes(topic.id)
                  return (
                    <button
                      key={topic.id}
                      type="button"
                      className={`chip ${active ? 'active' : ''}`}
                      aria-pressed={active}
                      onClick={() => setInterests(current => (active ? current.filter(id => id !== topic.id) : [...current, topic.id]))}
                    >
                      {topic.name}
                    </button>
                  )
                })}
              </div>
              {topics.length === 0 && <p className="field-hint">Topics will appear here once the topics table has content.</p>}
            </fieldset>

            <fieldset className="chip-fieldset">
              <legend>Clubs and communities to explore</legend>
              {clubs.length > 0 ? (
                <div className="chip-row">
                  {clubs.map(club => {
                    const active = selectedClubs.includes(club.id)
                    return (
                      <button
                        key={club.id}
                        type="button"
                        className={`chip ${active ? 'active' : ''}`}
                        aria-pressed={active}
                        onClick={() => void toggleClub(club.id)}
                      >
                        <Users size={13} /> {club.name}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="field-hint">No clubs are published on CAMPUS yet. You can join clubs any time from the Clubs page.</p>
              )}
            </fieldset>
          </section>
        )}

        {step === 5 && (
          <section className="wizard-step welcome-step">
            <span className="brand-mark large">C</span>
            <h2>Welcome to CAMPUS, {clean(first) || profile?.display_name || 'student'}!</h2>
            <p className="wizard-lead">
              Your campus space is ready. Post, react, join clubs, and stay close to everything happening at your college.
            </p>
            <ul className="welcome-summary">
              <li><b>Username</b><span>@{db.normalizeUsername(username) || profile?.username || '—'}</span></li>
              <li><b>College</b><span>{selectedCollege ? `${selectedCollege.name} (${selectedCollege.short_name})` : suggested ? `${suggested} — requested` : 'Not set'}</span></li>
              {(clean(course) || department || year) && (
                <li><b>Course</b><span>{[clean(course), clean(department), YEARS.find(item => item.value === year)?.label].filter(Boolean).join(' · ')}</span></li>
              )}
              {bio && <li><b>Bio</b><span>{clean(bio)}</span></li>}
            </ul>
            <p className="field-hint">
              Your college is a self-declared affiliation. Keep it kind: CAMPUS removes content that breaks our
              community guidelines.
            </p>
          </section>
        )}

        <div className="wizard-actions">
          {step > 0 ? (
            <button className="secondary-button" onClick={() => goTo(step - 1)} disabled={busy}>
              <ArrowLeft size={16} /> Back
            </button>
          ) : <span />}
          {step === 4 ? (
            <div className="wizard-actions-group">
              <button className="text-button" onClick={() => void onSkipOptional()} disabled={busy}>Skip for now</button>
              <button className="primary-button" onClick={() => void onContinue()} disabled={busy}>
                {busy ? 'Saving…' : <>Continue <ArrowRight size={16} /></>}
              </button>
            </div>
          ) : (
            <button className="primary-button" onClick={() => void onContinue()} disabled={busy}>
              {busy ? 'Saving…' : step === 5 ? <>Explore my campus <Sparkles size={16} /></> : <>Continue <ArrowRight size={16} /></>}
            </button>
          )}
        </div>

        {step === 4 && !caps.interests && (
          <p className="field-hint centered">
            <AlertCircle size={13} /> Your topic picks are kept on this device until the database migration is applied.
          </p>
        )}
      </main>
    </div>
  )
}
