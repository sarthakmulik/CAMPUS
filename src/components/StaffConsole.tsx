import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import {
  ShieldCheck, LayoutDashboard, Users, Building2, Megaphone, ScrollText,
  Ban, RotateCcw, Crown, Search, UserCog, AlertCircle, Clock,
} from 'lucide-react'
import { AdsAdmin } from './AdsAdmin'
import {
  StaffAccountRow, StaffAuditRow, Profile,
  loadStaffRoster, loadStaffAudit, loadColleges, findStaffTargets, staffRpc,
} from '../lib/db'

/**
 * Staff Console (0043 phase 2) — the platform back-office shell.
 *
 * Staff live here, not in the social feed: the console owns its own nav and
 * keeps the same CAMPUS design language. Anything a caller lacks the op for
 * is hidden; anything attempted that still fails is surfaced verbatim — no
 * silent successes, no fake numbers.
 */

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'people', label: 'People', icon: Users },
  { key: 'advertising', label: 'Advertising', icon: Megaphone },
  { key: 'colleges', label: 'Colleges', icon: Building2 },
  { key: 'staff', label: 'Staff & Audit', icon: ScrollText },
] as const

type TabKey = typeof TABS[number]['key']

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function initialsFor(name: string | null, fallback: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return fallback.slice(0, 2).toUpperCase() || 'CM'
}

export function StaffConsole({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<TabKey>('dashboard')
  const [roster, setRoster] = useState<StaffAccountRow[] | null>(null)
  const [audit, setAudit] = useState<StaffAuditRow[] | null>(null)
  const [ops, setOps] = useState<{ ads: boolean; suspend: boolean; provision: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)

  const auth = useAuth()
  const isSuper = auth.profile?.role === 'super_admin'

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setError(null)
      try {
        const [rosterRows, auditRows, adsOp, suspendOp, provisionOp] = await Promise.all([
          loadStaffRoster(),
          loadStaffAudit(80),
          staffRpc('has_op', { p_op: 'ads.view' }),
          staffRpc('has_op', { p_op: 'moderation.suspend' }),
          staffRpc('has_op', { p_op: 'staff.provision' }),
        ])
        if (cancelled) return
        setRoster(rosterRows)
        setAudit(auditRows)
        setOps({ ads: adsOp === true, suspend: suspendOp === true, provision: provisionOp === true })
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Staff console data failed to load.')
        setRoster([])
        setAudit([])
      }
    }
    void run()
    return () => { cancelled = true }
  }, [refreshTick])

  return (
    <section className="staff-wrap">
      <div className="staff-hero">
        <span className="staff-hero-seal"><ShieldCheck size={22}/></span>
        <div className="staff-hero-copy">
          <b>Staff Console</b>
          <small>CAMPUS HQ · platform back-office — {isSuper ? 'owner' : 'admin'} session</small>
        </div>
        <button className="staff-ghost" onClick={() => setRefreshTick(t => t + 1)} disabled={busy}>Refresh</button>
      </div>

      <div className="staff-tabs" role="tablist">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} role="tab" aria-selected={tab === key}
            className={`staff-tab ${tab === key ? 'selected' : ''}`}
            onClick={() => setTab(key)}>
            <Icon size={16}/><span>{label}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="staff-error"><AlertCircle size={16}/><span>{error}</span></div>
      )}

      {tab === 'dashboard' && (
        <DashboardTab roster={roster} audit={audit}/>
      )}
      {tab === 'people' && (
        <PeopleTab ops={ops} busy={busy} setBusy={setBusy} flash={flash} bump={() => setRefreshTick(t => t + 1)}/>
      )}
      {tab === 'advertising' && (ops?.ads
        ? <div className="staff-embed"><AdsAdmin flash={flash}/></div>
        : <div className="staff-empty">Your staff scopes do not include the advertising namespace.</div>)}
      {tab === 'colleges' && <CollegesTab/>}
      {tab === 'staff' && (ops?.provision || ops
        ? <StaffTab
            isSuper={isSuper}
            canProvision={Boolean(ops?.provision)}
            roster={roster}
            busy={busy}
            setBusy={setBusy}
            flash={flash}
            bump={() => setRefreshTick(t => t + 1)}
          />
        : null)}
      {audit && tab === 'staff' && ops?.provision && (
        <AuditPanel audit={audit}/>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

/* ---- dashboard ----------------------------------------------------------- */

function DashboardTab({ roster, audit }: { roster: StaffAccountRow[] | null; audit: StaffAuditRow[] | null }) {
  const [suspended, setSuspended] = useState<number | null>(null)
  const [opens, setOpens] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (!supabase) return
        const [{ count: sCount, error: sErr }, { count: rCount, error: rErr }] = await Promise.all([
          supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('account_status', 'suspended'),
          supabase.from('reports').select('id', { count: 'exact', head: true }),
        ])
        if (cancelled) return
        setSuspended(sErr ? -1 : (sCount ?? 0))
        setOpens(rErr ? -1 : (rCount ?? 0))
      } catch { if (!cancelled) { setSuspended(-1); setOpens(-1) } }
    })()
    return () => { cancelled = true }
  }, [])

  const activeStaff = roster?.filter(r => r.is_active).length ?? null
  const recent = audit?.slice(0, 5) ?? []

  return (
    <div className="staff-grid">
      <div className="staff-card">
        <small>ACTIVE STAFF</small>
        <b>{activeStaff ?? '…'}</b>
        <p>Accounts with a live staff row.</p>
      </div>
      <div className="staff-card">
        <small>SUSPENDED MEMBERS</small>
        <b>{suspended === null ? '…' : suspended < 0 ? 'n/a' : suspended}</b>
        <p>RLS write-blocked across the platform.</p>
      </div>
      <div className="staff-card">
        <small>REPORTS ON FILE</small>
        <b>{opens === null ? '…' : opens < 0 ? 'n/a' : opens}</b>
        <p>The Moderation Center queue works these in 0044.</p>
      </div>
      <div className="staff-card wide">
        <small>LATEST STAFF ACTIONS</small>
        {recent.length === 0
          ? <p className="staff-muted">No staff actions recorded yet.</p>
          : <ul className="staff-mini-audit">
              {recent.map(row => (
                <li key={row.id}>
                  <span className="staff-audit-badge">{row.action}</span>
                  <span>{row.actor_username ? `@${row.actor_username}` : 'system'} · {timeAgo(row.created_at)}</span>
                </li>
              ))}
            </ul>}
      </div>
      <div className="staff-card wide">
        <small>SHIPPING NEXT</small>
        <p className="staff-muted">
          Moderation Center queue UI (0044) · colleges manager + platform settings (0045).
        </p>
      </div>
    </div>
  )
}

/* ---- people -------------------------------------------------------------- */

function PeopleTab({ ops, busy, setBusy, flash, bump }: {
  ops: { ads: boolean; suspend: boolean; provision: boolean } | null
  busy: boolean
  setBusy: (b: boolean) => void
  flash: (message: string) => void
  bump: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Profile[] | null>(null)
  const [reason, setReason] = useState('')
  const [target, setTarget] = useState<Profile | null>(null)

  const search = async () => {
    setResults(null)
    try {
      setResults(await findStaffTargets(query))
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Lookup failed.')
    }
  }

  const act = async (row: Profile, action: 'suspend' | 'unsuspend') => {
    if (!ops?.suspend) { flash('Your scopes do not include moderation.suspend.'); return }
    setBusy(true)
    try {
      await staffRpc(action === 'suspend' ? 'member_suspend' : 'member_unsuspend',
        action === 'suspend' ? { p_user: row.id, p_reason: reason } : { p_user: row.id })
      flash(`@${row.username ?? 'profile'} ${action === 'suspend' ? 'suspended' : 'restored'} — audited.`)
      setReason('')
      setTarget(null)
      bump()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'The action was rejected.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="staff-people">
      <div className="staff-searchbar">
        <Search size={16}/>
        <input
          value={query}
          placeholder="Find a person by username or name…"
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void search() }}
        />
        <button className="staff-btn" onClick={() => void search()} disabled={busy}>Search</button>
      </div>
      <label className="staff-reason">
        <span>Suspend reason (optional, audited):</span>
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. repeated guideline breaches"/>
      </label>

      {results === null ? null : results.length === 0
        ? <div className="staff-empty">No matching profiles.</div>
        : <div className="staff-people-list">
            {results.map(row => (
              <div key={row.id} className="staff-person">
                <span className="avatar small">{initialsFor(row.display_name, '@' + (row.username ?? 'cm'))}</span>
                <div className="staff-person-copy">
                  <b>{row.display_name?.trim() || (row.username ? `@${row.username}` : 'CAMPUS member')}</b>
                  <small>
                    {row.username ? `@${row.username}` : 'no username'} · {row.role}
                    {row.account_status === 'suspended' ? ' · SUSPENDED' : ''}
                  </small>
                </div>
                {row.role === 'member' && (row.account_status === 'suspended'
                  ? <button className="staff-btn" disabled={busy} onClick={() => void act(row, 'unsuspend')}>
                      <RotateCcw size={14}/> Unsuspend
                    </button>
                  : <button className="staff-btn danger" disabled={busy} onClick={() => { setTarget(row) }}>
                      <Ban size={14}/> Suspend…
                    </button>)}
              </div>
            ))}
          </div>}

      {target && (
        <div className="staff-confirm">
          <b>Suspend @<span>{target.username}</span>?</b>
          <p>Writes (posts, comments, follows, chats, listings) become database-blocked. Reversible anytime.</p>
          <div>
            <button className="staff-btn danger" disabled={busy} onClick={() => void act(target, 'suspend')}>Confirm suspend</button>
            <button className="staff-btn" onClick={() => setTarget(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---- colleges ------------------------------------------------------------ */

function CollegesTab() {
  const [colleges, setColleges] = useState<Array<{ id: string; name: string; short_name: string; city: string; verified: boolean }> | null>(null)
  useEffect(() => {
    void (async () => {
      try { setColleges(await loadColleges()) }
      catch { setColleges([]) }
    })()
  }, [])
  const verified = colleges?.filter(c => c.verified).length ?? 0
  return (
    <div className="staff-colleges">
      <div className="staff-card wide">
        <small>DIRECTORY SNAPSHOT</small>
        <p className="staff-muted">
          {colleges === null ? 'Loading…' : `${colleges.length} colleges · ${verified} verified`}
        </p>
        <p className="staff-muted">The colleges manager (create / edit / verify / merge) ships with 0045 — the data is live, the console surface is next.</p>
      </div>
      {colleges?.slice(0, 12).map(c => (
        <div key={c.id} className="staff-person">
          <span className="avatar small"><Building2 size={14}/></span>
          <div className="staff-person-copy">
            <b>{c.name}</b>
            <small>{c.short_name} · {c.city || '—'}{c.verified ? ' · verified' : ''}</small>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---- staff & audit -------------------------------------------------------- */

function StaffTab({ isSuper, canProvision, roster, busy, setBusy, flash, bump }: {
  isSuper: boolean
  canProvision: boolean
  roster: StaffAccountRow[] | null
  busy: boolean
  setBusy: (b: boolean) => void
  flash: (message: string) => void
  bump: () => void
}) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Profile[]>([])
  const [tier, setTier] = useState<'admin' | 'super_admin'>('admin')
  const [title, setTitle] = useState('')
  const [scopesText, setScopesText] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try { setMatches(await findStaffTargets(query)) }
      catch { setMatches([]) }
    })()
  }, [query])

  const provision = async (row: Profile) => {
    setBusy(true)
    try {
      await staffRpc('staff_provision', { p_user: row.id, p_tier: tier, p_title: title || null })
      flash(`@${row.username ?? 'profile'} provisioned as ${tier} — audited.`)
      setQuery('')
      setMatches([])
      bump()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Provisioning was rejected.')
    } finally {
      setBusy(false)
    }
  }

  const saveScopes = async (row: StaffAccountRow) => {
    setBusy(true)
    try {
      const list = scopesText.split(',').map(s => s.trim()).filter(Boolean)
      await staffRpc('staff_scopes_set', { p_user: row.user_id, p_scopes: list })
      flash(`Scopes updated for @${row.username ?? 'profile'} — audited.`)
      setEditing(null)
      bump()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Scope change was rejected.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (row: StaffAccountRow) => {
    setBusy(true)
    try {
      await staffRpc('staff_remove', { p_user: row.user_id })
      flash(`@${row.username ?? 'profile'} revoked back to member — audited.`)
      bump()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Revoke was rejected.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="staff-manage">
      {!isSuper && (
        <div className="staff-note">Only the owner tier provisions staff or edits scopes — you have read access.</div>
      )}
      {isSuper && (
        <div className="staff-provision">
          <div className="staff-searchbar">
            <Search size={16}/>
            <input
              value={query}
              placeholder="Find a member to provision (username or name)…"
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          {matches.filter(m => m.role === 'member').map(m => (
            <div key={m.id} className="staff-person">
              <span className="avatar small">{initialsFor(m.display_name, '@' + (m.username ?? 'cm'))}</span>
              <div className="staff-person-copy">
                <b>{m.display_name?.trim() || (m.username ? `@${m.username}` : 'CAMPUS member')}</b>
                <small>{m.username ? `@${m.username}` : 'no username'}</small>
              </div>
              <button className="staff-btn" disabled={busy} onClick={() => void provision(m)}>
                <UserCog size={14}/> Provision…
              </button>
            </div>
          ))}
          {(matches.length > 0 || exists(matches.filter(m => m.role === 'member'))) && (
            <div className="staff-provision-form">
              <label><span>Tier</span>
                <select value={tier} onChange={e => setTier(e.target.value as 'admin' | 'super_admin')}>
                  <option value="admin">admin</option>
                  <option value="super_admin">super_admin</option>
                </select>
              </label>
              <label><span>Title</span>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Platform moderator"/>
              </label>
              <p className="staff-muted">Scopes default by tier (super_admin: *, admin: moderation + people + colleges + ads.*) — tighten per-account below after provisioning.</p>
            </div>
          )}
        </div>
      )}

      <div className="staff-roster">
        <small>ROSTER</small>
        {roster === null ? <p className="staff-muted">Loading…</p>
          : roster.length === 0 ? <p className="staff-muted">No staff rows readable.</p>
          : roster.map(row => {
            const editMode = editing === row.user_id && isSuper && row.tier !== 'super_admin' && row.is_active
            return (
              <div key={row.user_id} className={`staff-person ${row.is_active ? '' : 'revoked'}`}>
                <span className="avatar small">{initialsFor(row.display_name, '@' + (row.username ?? 'cm'))}</span>
                <div className="staff-person-copy">
                  <b>{row.display_name?.trim() || (row.username ? `@${row.username}` : 'CAMPUS member')}</b>
                  <small>
                    {row.tier === 'super_admin' && <Crown size={11}/>}
                    {' '}{row.tier} · {row.username ? `@${row.username}` : 'no username'}
                    {row.is_active ? '' : ` · revoked ${row.revoked_at ? timeAgo(row.revoked_at) : ''}`}
                    {row.account_status === 'suspended' ? ' · SUSPENDED' : ''}
                  </small>
                  <div className="staff-scopes">
                    {(row.tier === 'super_admin' ? ['*'] : row.scopes).map(s => (
                      <span key={s} className="staff-chip">{s}</span>
                    ))}
                  </div>
                </div>
                {row.is_active && isSuper ? (
                  editMode ? (
                    <div className="staff-person-actions">
                      <input value={scopesText} onChange={e => setScopesText(e.target.value)}
                        placeholder="comma-separated scopes"/>
                      <button className="staff-btn" disabled={busy} onClick={() => void saveScopes(row)}>Save</button>
                      <button className="staff-btn" disabled={busy} onClick={() => { setEditing(null); setScopesText('') }}>Cancel</button>
                    </div>
                  ) : (
                    <div className="staff-person-actions">
                      <button className="staff-btn" disabled={busy} onClick={() => { setEditing(row.user_id); setScopesText(row.scopes.join(', ')) }}>Scopes</button>
                      <button className="staff-btn danger" disabled={busy} onClick={() => void remove(row)}>Revoke</button>
                    </div>
                  )
                ) : null}
              </div>
            )
          })}
      </div>
    </div>
  )
}

function exists(list: Profile[]): boolean { return list.length > 0 }

function AuditPanel({ audit }: { audit: StaffAuditRow[] }) {
  return (
    <div className="staff-audit">
      <small>AUDIT TRAIL — latest {audit.length}</small>
      {audit.length === 0
        ? <p className="staff-muted">Nothing recorded yet — every staff mutation will land here.</p>
        : <ul>
            {audit.map(row => (
              <li key={row.id}>
                <span className="staff-audit-badge">{row.action}</span>
                <div className="staff-audit-copy">
                  <b>{row.actor_username ? `@${row.actor_username}` : 'system'} · {timeAgo(row.created_at)}</b>
                  {row.target_id ? <code>{row.target_id.slice(0, 8)}…</code> : null}
                  {row.metadata?.reason ? <span className="staff-audit-note">{String(row.metadata.reason)}</span> : null}
                  {row.metadata?.tier ? <span className="staff-audit-note">tier: {String(row.metadata.tier)}</span> : null}
                </div>
              </li>
            ))}
          </ul>}
      <p className="staff-muted staff-clock"><Clock size={11}/> Read-only history — audit rows are writable only by trusted database code.</p>
    </div>
  )
}
