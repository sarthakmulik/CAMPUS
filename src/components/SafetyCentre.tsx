import { useEffect, useState } from 'react'
import { AlertCircle, Ban, EyeOff, Flag, RotateCcw, Shield, ShieldCheck } from 'lucide-react'
import { useAuth } from '../lib/auth'
import * as db from '../lib/db'

const GUIDELINES = [
  { title: 'No threats or calls for violence', copy: 'Credible or even joking threats are removed and reported.' },
  { title: 'No targeted harassment', copy: 'Dogpiling, slurs and repeated unwanted contact get accounts restricted.' },
  { title: 'No doxxing', copy: 'Never post someone else’s phone number, address, photos or documents.' },
  { title: 'Anonymous does not mean lawless', copy: 'Confessions are separated from your account, but still subject to moderation.' },
  { title: 'No spam, scams or impersonation', copy: 'Repeated posting, fake giveaways and duplicate accounts are removed.' },
  { title: 'Respect privacy', copy: 'Screenshots of private chats and private profiles are not allowed.' },
]

/**
 * Safety Centre: community guidelines, privacy controls, blocked accounts and
 * the member's own report history. Everything here reads and writes real
 * Supabase rows — empty, loading and error states are all handled.
 */
export default function SafetyCentre() {
  const { user, profile, patchProfile, notify, requireAuth } = useAuth()
  const [blocked, setBlocked] = useState<db.BlockedRow[]>([])
  const [reports, setReports] = useState<db.ReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [privacyBusy, setPrivacyBusy] = useState(false)
  const [privacyError, setPrivacyError] = useState<string | null>(null)
  const [unblocking, setUnblocking] = useState<string | null>(null)

  const load = async () => {
    if (!user) return
    setLoading(true)
    setLoadError(null)
    const [blockedRows, reportRows] = await Promise.all([
      db.loadBlocked(user.id),
      db.loadMyReports(),
    ])
    setBlocked(blockedRows)
    setReports(reportRows)
    setLoading(false)
  }

  useEffect(() => {
    if (user && requireAuth('open the Safety Centre', 'Safety Centre')) void load()
    else setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const togglePrivacy = async () => {
    if (!user || !profile) return
    const next = !profile.is_private
    setPrivacyBusy(true)
    setPrivacyError(null)
    const message = await patchProfile({ is_private: next })
    if (message) setPrivacyError(message)
    else notify(next ? 'Your profile is now private.' : 'Your profile is now public.')
    setPrivacyBusy(false)
  }

  const unblock = async (targetId: string) => {
    if (!user) return
    setUnblocking(targetId)
    try {
      await db.unblockUser(user.id, targetId)
      setBlocked(current => current.filter(row => row.blocked_id !== targetId))
      notify('Account unblocked.')
    } catch (error) {
      notify(db.friendlyMessage(error))
    } finally {
      setUnblocking(null)
    }
  }

  return (
    <div className="page-stack safety-centre">
      <header className="section-hero">
        <span className="section-hero-icon"><ShieldCheck size={26} /></span>
        <div>
          <h1>Safety Centre</h1>
          <p>Community guidelines, your privacy, and the controls you own.</p>
        </div>
      </header>

      <section className="settings-card">
        <h2><Shield size={17} /> Community guidelines</h2>
        <p className="card-lead">
          CAMPUS is built for open student discussion. Posts publish without college-staff approval — moderation
          happens through platform rules, member reports and safety controls, never institutional censorship.
        </p>
        <ul className="guideline-list">
          {GUIDELINES.map(item => (
            <li key={item.title}>
              <b>{item.title}</b>
              <small>{item.copy}</small>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-card">
        <h2><EyeOff size={17} /> Privacy</h2>
        <div className="settings-row">
          <div>
            <b>Private profile</b>
            <small>Only you (and CAMPUS admins) can read your profile. Your posts stay subject to normal privacy rules.</small>
          </div>
          <button
            className={`toggle ${profile?.is_private ? 'on' : ''}`}
            role="switch"
            aria-checked={Boolean(profile?.is_private)}
            aria-label="Private profile"
            disabled={privacyBusy || !profile}
            onClick={() => void togglePrivacy()}
          >
            <span />
          </button>
        </div>
        {privacyError && <p className="form-error" role="alert"><AlertCircle size={15} /> {privacyError}</p>}
      </section>

      <section className="settings-card">
        <h2><Ban size={17} /> Blocked accounts</h2>
        {loading ? (
          <p className="empty-state">Loading…</p>
        ) : loadError ? (
          <p className="form-error" role="alert"><AlertCircle size={15} /> {loadError}</p>
        ) : blocked.length === 0 ? (
          <p className="empty-state">You haven’t blocked anyone. Blocking appears in post menus and profiles.</p>
        ) : (
          <ul className="blocked-list">
            {blocked.map(row => (
              <li key={row.blocked_id}>
                <span className="avatar">{(row.display_name ?? row.username ?? '?').slice(0, 2).toUpperCase()}</span>
                <span className="blocked-copy">
                  <b>{row.display_name ?? 'CAMPUS member'}</b>
                  <small>{row.username ? `@${row.username}` : 'Account hidden'}</small>
                </span>
                <button
                  className="secondary-button small"
                  disabled={unblocking === row.blocked_id}
                  onClick={() => void unblock(row.blocked_id)}
                >
                  <RotateCcw size={14} /> Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-card">
        <h2><Flag size={17} /> Reports you sent</h2>
        {loading ? (
          <p className="empty-state">Loading…</p>
        ) : reports.length === 0 ? (
          <p className="empty-state">
            Nothing reported yet. Use the report action on any post, comment or profile — reports stay between you
            and CAMPUS moderators.
          </p>
        ) : (
          <ul className="report-list">
            {reports.map(report => (
              <li key={report.id}>
                <b>{report.reason}</b>
                <span className={`status-badge ${report.status}`}>{report.status}</span>
                <small>{new Date(report.created_at).toLocaleDateString()}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
