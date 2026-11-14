import { useEffect, useState } from 'react'
import {
  ArrowLeft, BadgeCheck, Camera, Eye, FileText, KeyRound, Loader2, Lock, LogOut,
  Search, ShieldAlert, UserCog, VolumeX, X,
} from 'lucide-react'
import * as db from '../lib/db'
import type { Caps, Profile as DbProfile, RelationRow, ReportRow, UsernameCheck } from '../lib/db'
import type { BlockedRow } from '../lib/db'

type View = 'menu' | 'privacy' | 'account' | 'password' | 'data'

type Props = {
  profile: DbProfile
  userId: string
  caps: Caps
  patchProfile: (patch: db.ProfilePatch) => Promise<string | null>
  reloadProfile: () => void
  onSignOut: () => void
  onClose: () => void
}

/** Instagram-style full-page settings: privacy, account, password, data —
 *  every item is wired to the real schema; whoever chooses it sees truth. */
export default function ProfileSettings({ profile, userId, caps, patchProfile, reloadProfile, onSignOut, onClose }: Props) {
  const [view, setView] = useState<View>('menu')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // privacy
  const [privateMode, setPrivateMode] = useState(Boolean(profile.is_private))
  const [blocked, setBlocked] = useState<BlockedRow[] | null>(null)
  const [muted, setMuted] = useState<RelationRow[] | null>(null)

  // account
  const [name, setName] = useState(profile.display_name ?? '')
  const [username, setUsername] = useState(profile.username ?? '')
  const [bio, setBio] = useState(profile.bio ?? '')
  const [usernameState, setUsernameState] = useState<UsernameCheck>(profile.username ? 'available' : 'idle')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [email, setEmail] = useState<string | null>(null)

  // password
  const [password, setPassword] = useState('')
  const [passwordAgain, setPasswordAgain] = useState('')

  // data
  const [reports, setReports] = useState<ReportRow[] | null>(null)

  // 0057: institute & class editing (existing users can change institution)
  const [instQuery, setInstQuery] = useState('')
  const [instHits, setInstHits] = useState<db.InstitutionHit[]>([])
  const [pendingCollegeId, setPendingCollegeId] = useState<string | null>(null)
  const [pendingCampusId, setPendingCampusId] = useState<string | null>(null)
  const [deptOptions, setDeptOptions] = useState<db.InstitutionDept[]>([])
  const [pendingDepartmentId, setPendingDepartmentId] = useState<string | null>(null)
  const [pendingProgramId, setPendingProgramId] = useState<string | null>(null)
  const [pendingPrograms, setPendingPrograms] = useState<db.InstitutionProgram[]>([])
  const [pendingCourse, setPendingCourse] = useState(profile.course ?? '')
  const [pendingYear, setPendingYear] = useState(profile.year_of_study ? String(profile.year_of_study) : '')
  const [pendingSemester, setPendingSemester] = useState(profile.semester ? String(profile.semester) : '')

  const effectiveCollegeId = pendingCollegeId ?? profile.college_id ?? ''

  function note(ok: boolean, text: string) {
    setMessage({ ok, text })
    if (typeof window !== 'undefined') window.scrollTo?.({ top: 0, behavior: 'smooth' })
  }

  async function loadRelationLists() {
    setBlocked(null)
    setMuted(null)
    try {
      const [blocks, mutes] = await Promise.all([
        db.loadBlocked(userId),
        db.loadUserRelation('user_mutes', userId),
      ])
      setBlocked(blocks)
      setMuted(mutes)
    } catch {
      setBlocked([])
      setMuted([])
    }
  }

  useEffect(() => {
    if (view === 'privacy') void loadRelationLists()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, userId])

  useEffect(() => {
    if (view === 'data') {
      setReports(null)
      void db.loadMyReports().then(setReports).catch(() => setReports([]))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  useEffect(() => {
    if (view === 'account' && email === null) void db.currentEmail().then(address => setEmail(address ?? 'unavailable')).catch(() => setEmail('unavailable'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // 0057: debounced directory search while the account view is open
  useEffect(() => {
    if (view !== 'account') return
    let cancelled = false
    const handle = window.setTimeout(() => {
      void db.searchInstitutions(instQuery, caps, 12)
        .then(hits => { if (!cancelled) setInstHits(hits) })
        .catch(() => { if (!cancelled) setInstHits([]) })
    }, instQuery.trim() ? 250 : 0)
    return () => { cancelled = true; window.clearTimeout(handle) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instQuery, view])

  // 0057: departments + programs of the effective (pending or current) college
  useEffect(() => {
    if (!effectiveCollegeId) { setDeptOptions([]); setPendingPrograms([]); return }
    let cancelled = false
    void Promise.all([db.listDepartments(effectiveCollegeId), db.listPrograms(effectiveCollegeId)])
      .then(([depts, programs]) => {
        if (!cancelled) { setDeptOptions(depts); setPendingPrograms(programs) }
      })
      .catch(() => { if (!cancelled) { setDeptOptions([]); setPendingPrograms([]) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCollegeId])

  async function saveInstitute() {
    const chosenDept = deptOptions.find(option => option.id === pendingDepartmentId) ?? null
    const chosenProgram = pendingPrograms.find(option => option.id === pendingProgramId) ?? null
    setBusy(true)
    setMessage(null)
    try {
      const failure = await patchProfile({
        college_id: pendingCollegeId ?? profile.college_id ?? null,
        campus_id: pendingCampusId,
        department_id: chosenDept?.id ?? null,
        department: chosenDept ? chosenDept.name : profile.department ?? null,
        academic_program_id: chosenProgram?.id ?? null,
        course: chosenProgram ? chosenProgram.name : (pendingCourse.trim() || null),
        year_of_study: pendingYear ? Number(pendingYear) : null,
        semester: pendingSemester ? Number(pendingSemester) : null,
      })
      reloadProfile()
      if (failure) note(false, failure)
      else {
        setPendingCollegeId(null)
        setPendingCampusId(null)
        setPendingDepartmentId(null)
        setPendingProgramId(null)
        note(true, 'Institute details saved.')
      }
    } finally {
      setBusy(false)
    }
  }

  // username live check
  useEffect(() => {
    const value = username.trim().toLowerCase()
    if (!value || value === (profile.username ?? '')) { setUsernameState(value ? 'available' : 'idle'); return }
    let cancelled = false
    void db.checkUsername(value, caps, profile.username)
      .then(result => { if (!cancelled) setUsernameState(result.state) })
      .catch(() => { if (!cancelled) setUsernameState('idle') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username])

  async function togglePrivate(value: boolean) {
    setBusy(true)
    setMessage(null)
    try {
      await db.setPrivateProfile(userId, value)
      setPrivateMode(value)
      reloadProfile()
      note(true, value ? 'Your account is now private.' : 'Your account is public again.')
    } catch (error) {
      note(false, db.friendlyMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function unblock(targetId: string) {
    setBusy(true)
    try {
      await db.unblockUser(userId, targetId)
      await loadRelationLists()
    } catch (error) {
      note(false, db.friendlyMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function unmute(targetId: string) {
    setBusy(true)
    try {
      await db.unsetUserRelation('user_mutes', userId, targetId)
      await loadRelationLists()
    } catch (error) {
      note(false, db.friendlyMessage(error))
    } finally {
      setBusy(false)
    }
  }

  // username cooldown (0009): one change per 30 days, enforced server-side too
  const lastUsernameChange = profile.username_changed_at
  const cooldownMs = lastUsernameChange ? new Date(lastUsernameChange).getTime() + 30 * 24 * 60 * 60 * 1000 : 0
  const usernameLocked = Boolean(profile.username) && cooldownMs > Date.now()
  const cooldownDate = usernameLocked ? new Date(cooldownMs).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null

  async function saveAccount() {
    if (!name.trim()) { note(false, 'Your name cannot be empty.'); return }
    if (username.trim() && usernameState === 'taken') { note(false, 'That username belongs to someone else.'); return }
    setBusy(true)
    setMessage(null)
    try {
      if (avatarFile) await db.uploadAvatar(userId, avatarFile)
      const failure = await patchProfile({
        display_name: name.trim(),
        ...(username.trim() && username.trim() !== (profile.username ?? '') ? { username: username.trim() } : {}),
        bio: bio.trim(),
      })
      reloadProfile()
      if (failure) note(false, failure)
      else { note(true, 'Profile saved.'); setAvatarFile(null) }
    } catch (error) {
      note(false, db.friendlyMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function savePassword() {
    if (password.length < 8) { note(false, 'Passwords need at least 8 characters.'); return }
    if (password !== passwordAgain) { note(false, 'The two passwords do not match.'); return }
    setBusy(true)
    setMessage(null)
    try {
      await db.changePassword(password)
      setPassword('')
      setPasswordAgain('')
      note(true, 'Password changed — use it the next time you sign in.')
    } catch (error) {
      note(false, db.friendlyMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const menuView = (
    <div className="settings-list">
      <button className="settings-item" onClick={() => { setView('privacy'); setMessage(null) }}>
        <Lock size={17}/><span><b>Privacy</b><small>Private account, blocked and muted classmates</small></span>
      </button>
      <button className="settings-item" onClick={() => { setView('account'); setMessage(null) }}>
        <UserCog size={17}/><span><b>Account</b><small>Name, @username, bio, profile photo</small></span>
      </button>
      <button className="settings-item" onClick={() => { setView('password'); setMessage(null) }}>
        <KeyRound size={17}/><span><b>Password</b><small>Change the password you sign in with</small></span>
      </button>
      <button className="settings-item" onClick={() => { setView('data'); setMessage(null) }}>
        <FileText size={17}/><span><b>Data</b><small>The reports you filed and how your data works</small></span>
      </button>
      <button className="settings-item danger" onClick={onSignOut}>
        <LogOut size={17}/><span><b>Sign out</b><small>End this session on CAMPUS</small></span>
      </button>
    </div>
  )

  const privacyView = (
    <div className="settings-list">
      <button className="settings-row" disabled={busy} onClick={() => void togglePrivate(!privateMode)}>
        <Lock size={16}/>
        <span><b>Private account</b><small>{privateMode ? 'Only people you approve see your posts' : 'Anyone on CAMPUS sees your posts'}</small></span>
        <i className={`settings-switch ${privateMode ? 'on' : ''}`} aria-hidden="true"><u/></i>
      </button>

      <div className="settings-section-title">Blocked accounts</div>
      {blocked === null && <div className="settings-note"><Loader2 size={14} className="spinner-ic"/>Loading…</div>}
      {blocked !== null && blocked.length === 0 && <div className="settings-note">You have not blocked anyone.</div>}
      {blocked?.map(row => (
        <div key={row.blocked_id} className="settings-person">
          <span>{row.display_name ?? 'Classmate'}{row.username ? <small> @{row.username}</small> : null}</span>
          <button className="settings-small-action" disabled={busy} onClick={() => void unblock(row.blocked_id)}>Unblock</button>
        </div>
      ))}

      <div className="settings-section-title">Muted accounts</div>
      {muted === null && <div className="settings-note"><Loader2 size={14} className="spinner-ic"/>Loading…</div>}
      {muted !== null && muted.length === 0 && <div className="settings-note">You have not muted anyone. Mute keeps their posts out of your feed without them knowing.</div>}
      {muted?.map(row => (
        <div key={row.id} className="settings-person">
          <VolumeX size={13}/>
          <span>{row.display_name ?? 'Classmate'}{row.username ? <small> @{row.username}</small> : null}</span>
          <button className="settings-small-action" disabled={busy} onClick={() => void unmute(row.id)}>Unmute</button>
        </div>
      ))}
    </div>
  )

  const accountView = (
    <div className="settings-list">
      <div className="settings-person plain">
        <small>Signed in as</small>
        <b>{email ?? '…'}</b>
      </div>
      <div className="settings-section-title">Institute &amp; class</div>
      <label className="settings-field">
        <span>Change institute</span>
        <span className="input-with-action">
          <Search size={15} />
          <input
            value={instQuery}
            maxLength={80}
            autoComplete="off"
            placeholder={profile.college_id ? 'Search to switch, or leave as is' : 'Search your college'}
            onChange={event => { setInstQuery(event.target.value); setPendingCollegeId(null); setPendingCampusId(null) }}
          />
        </span>
      </label>
      {instHits.length > 0 && instQuery.trim() && (
        <ul className="college-list" role="listbox" aria-label="Institution results">
          {instHits.map(hit => (
            <li key={hit.id}>
              <button
                type="button"
                className={`college-option ${effectiveCollegeId === hit.id ? 'selected' : ''}`}
                onClick={() => { setPendingCollegeId(hit.id); setPendingCampusId(hit.campus_id); setInstQuery(hit.name) }}
              >
                <span className="college-option-copy">
                  <b>{hit.name}</b>
                  <small>
                    {hit.short_name} · {hit.campus_locality || hit.locality || 'Pune'}
                    {hit.institution_type ? ` · ${hit.institution_type.replace('_', ' ')}` : ''}
                  </small>
                </span>
                {effectiveCollegeId === hit.id && <BadgeCheck size={16} />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {deptOptions.length > 0 && (
        <label className="settings-field">
          <span>Department</span>
          <select value={pendingDepartmentId ?? ''} onChange={event => setPendingDepartmentId(event.target.value || null)}>
            <option value="">Not set</option>
            {deptOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </label>
      )}
      <label className="settings-field">
        <span>Course</span>
        <input value={pendingCourse} maxLength={60} placeholder="B.Tech" onChange={event => setPendingCourse(event.target.value)}/>
      </label>
      <label className="settings-field">
        <span>Year</span>
        <select value={pendingYear} onChange={event => setPendingYear(event.target.value)}>
          <option value="">Not set</option>
          {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>Year {value}</option>)}
          <option value="6">Postgraduate</option>
        </select>
      </label>
      <label className="settings-field">
        <span>Semester</span>
        <select value={pendingSemester} onChange={event => setPendingSemester(event.target.value)}>
          <option value="">Not set</option>
          {[1, 2, 3, 4, 5, 6, 7, 8].map(value => <option key={value} value={value}>Semester {value}</option>)}
        </select>
      </label>
      <button className="settings-primary" disabled={busy} onClick={() => void saveInstitute()}>
        {busy ? <Loader2 size={15} className="spinner-ic"/> : <BadgeCheck size={15}/>} Save institute details
      </button>

      <div className="settings-section-title">Your profile</div>
      <label className="settings-field">
        <span>Name</span>
        <input value={name} maxLength={60} onChange={event => setName(event.target.value)}/>
      </label>
      <label className="settings-field">
        <span>Username</span>
        <input
          value={username}
          maxLength={24}
          disabled={usernameLocked}
          onChange={event => setUsername(event.target.value)}
        />
        {usernameLocked ? (
          <em>Usernames can be changed once every 30 days — yours unlocks on {cooldownDate}.</em>
        ) : (
          <>
            {username.trim() && username.trim() !== (profile.username ?? '') && (
              <em className={usernameState === 'taken' ? 'bad' : usernameState === 'available' ? 'ok' : ''}>
                {usernameState === 'taken'
                  ? 'That username belongs to someone else — pick another.'
                  : usernameState === 'available'
                    ? `@${username.trim().toLowerCase()} is free.`
                    : usernameState === 'invalid'
                      ? '3–20 characters — lowercase letters, numbers and underscores only.'
                      : 'Checking…'}
              </em>
            )}
            <em className="dim">Changing it starts a 30-day cooldown — one change per month.</em>
          </>
        )}
      </label>
      <label className="settings-field">
        <span>Bio</span>
        <textarea value={bio} maxLength={220} rows={3} onChange={event => setBio(event.target.value)}/>
      </label>
      <label className="settings-field">
        <span>Profile photo</span>
        <input type="file" accept="image/*" onChange={event => {
          const file = event.target.files?.[0] ?? null
          const problem = file ? db.validateAvatarFile(file) : null
          if (problem) { note(false, problem); setAvatarFile(null); return }
          setAvatarFile(file)
        }}/>
        {avatarFile && <em className="ok">{avatarFile.name} — saves when you tap Save.</em>}
      </label>
      <button className="settings-primary" disabled={busy} onClick={() => void saveAccount()}>
        {busy ? <Loader2 size={15} className="spinner-ic"/> : <BadgeCheck size={15}/>} Save
      </button>
    </div>
  )

  const passwordView = (
    <div className="settings-list">
      <label className="settings-field">
        <span>New password</span>
        <input type="password" value={password} maxLength={72} autoComplete="new-password" onChange={event => setPassword(event.target.value)}/>
      </label>
      <label className="settings-field">
        <span>Repeat new password</span>
        <input type="password" value={passwordAgain} maxLength={72} autoComplete="new-password" onChange={event => setPasswordAgain(event.target.value)}/>
        {passwordAgain && password !== passwordAgain && <em className="bad">The two passwords do not match.</em>}
      </label>
      <button className="settings-primary" disabled={busy || !password || !passwordAgain} onClick={() => void savePassword()}>
        {busy ? <Loader2 size={15} className="spinner-ic"/> : <KeyRound size={15}/>} Change password
      </button>
    </div>
  )

  const dataView = (
    <div className="settings-list">
      <div className="settings-section-title"><ShieldAlert size={13}/> Reports you filed</div>
      {reports === null && <div className="settings-note"><Loader2 size={14} className="spinner-ic"/>Loading…</div>}
      {reports !== null && reports.length === 0 && (
        <div className="settings-note">None yet — ⋯ → Report on any post records the report here.</div>
      )}
      {reports?.map(report => (
        <div key={report.id} className="settings-person">
          <span>{report.reason}<small> · {new Date(report.created_at).toLocaleDateString()} · {report.status}</small></span>
        </div>
      ))}
      <div className="settings-note low">
        <Camera size={13}/> Your posts, chats and reports live on CAMPUS's own database. A downloadable data archive does not exist yet — when it ships, it appears here.
      </div>
      <div className="settings-note low">
        <Eye size={13}/> Private accounts keep posts from everyone except approved followers — enforced by row-level security on the server, not a UI promise.
      </div>
    </div>
  )

  const title = view === 'menu' ? 'Settings' : view[0].toUpperCase() + view.slice(1)
  const body = view === 'menu' ? menuView : view === 'privacy' ? privacyView : view === 'account' ? accountView : view === 'password' ? passwordView : dataView

  return (
    <section className="settings-page">
      <div className="settings-head">
        {view !== 'menu'
          ? <button className="icon-button" aria-label="Back" onClick={() => { setView('menu'); setMessage(null) }}><ArrowLeft size={19}/></button>
          : <button className="icon-button" aria-label="Back to profile" onClick={onClose}><X size={19}/></button>}
        <b>{title}</b>
        <span className="settings-head-spacer"/>
      </div>
      {message && <div className={`settings-message ${message.ok ? 'good' : ''}`}>{message.text}</div>}
      {body}
    </section>
  )
}
