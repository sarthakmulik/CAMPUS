import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import {
  ShieldCheck, LayoutDashboard, Users, Building2, Megaphone, ScrollText,
  Ban, RotateCcw, Crown, Search, UserCog, AlertCircle, Clock,
  Flag, AlertTriangle, EyeOff, Eye, Check, X, Sparkles,
} from 'lucide-react'
import { AdsAdmin } from './AdsAdmin'
import {
  StaffAccountRow, StaffAuditRow, Profile, ModerationReportRow,
  loadStaffRoster, loadStaffAudit, loadColleges, findStaffTargets, staffRpc,
  loadStaffReports, loadStaffReportCounts,
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
  { key: 'moderation', label: 'Moderation', icon: Flag },
  { key: 'advertising', label: 'Advertising', icon: Megaphone },
  { key: 'pulse', label: 'Pulse', icon: Sparkles },
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

type StaffOps = { ads: boolean; suspend: boolean; provision: boolean; warn: boolean; act: boolean; pulse: boolean }

export function StaffConsole({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<TabKey>('dashboard')
  const [roster, setRoster] = useState<StaffAccountRow[] | null>(null)
  const [audit, setAudit] = useState<StaffAuditRow[] | null>(null)
  const [ops, setOps] = useState<StaffOps | null>(null)
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
        const [rosterRows, auditRows, adsOp, suspendOp, provisionOp, warnOp, actOp, pulseOp] = await Promise.all([
          loadStaffRoster(),
          loadStaffAudit(80),
          staffRpc('has_op', { p_op: 'ads.view' }),
          staffRpc('has_op', { p_op: 'moderation.suspend' }),
          staffRpc('has_op', { p_op: 'staff.provision' }),
          staffRpc('has_op', { p_op: 'moderation.warn' }),
          staffRpc('has_op', { p_op: 'moderation.act' }),
          staffRpc('has_op', { p_op: 'pulse.admin' }),
        ])
        if (cancelled) return
        setRoster(rosterRows)
        setAudit(auditRows)
        setOps({ ads: adsOp === true, suspend: suspendOp === true, provision: provisionOp === true, warn: warnOp === true, act: actOp === true, pulse: pulseOp === true })
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
      {tab === 'moderation' && (
        <ModerationTab ops={ops} busy={busy} setBusy={setBusy} flash={flash} bump={() => setRefreshTick(t => t + 1)}/>
      )}
      {tab === 'advertising' && (ops?.ads
        ? <div className="staff-embed"><AdsAdmin flash={flash}/></div>
        : <div className="staff-empty">Your staff scopes do not include the advertising namespace.</div>)}
      {tab === 'pulse' && (ops?.pulse
        ? <div className="staff-embed"><PulseAdminTab busy={busy} setBusy={setBusy} flash={flash} bump={() => setRefreshTick(t => t + 1)}/></div>
        : <div className="staff-empty">Your staff scopes do not include the pulse namespace.</div>)}
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
        <p>Work the queue in the Moderation tab.</p>
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
          Colleges manager + platform settings (0045) · ads gates migrate from is_admin() to ads.* ops.
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

/* ---- moderation (0044) ---------------------------------------------------- */

const REPORT_FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'reviewing', label: 'Reviewing' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
] as const

const SUBJECT_LABEL: Record<string, string> = {
  'post': 'POST',
  'person': 'PERSON',
  'post+person': 'POST + PERSON',
}

function ModerationTab({ ops, busy, setBusy, flash, bump }: {
  ops: StaffOps | null
  busy: boolean
  setBusy: (b: boolean) => void
  flash: (message: string) => void
  bump: () => void
}) {
  const [filter, setFilter] = useState<(typeof REPORT_FILTERS)[number]['key']>('open')
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const [rows, setRows] = useState<ModerationReportRow[] | null>(null)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [tick, setTick] = useState(0)
  const [target, setTarget] = useState<
    { kind: 'warn' | 'suspend'; row: ModerationReportRow } | null
  >(null)
  const [warnNote, setWarnNote] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setRows(null)
      setRowsError(null)
      try {
        const result = await Promise.allSettled([
          loadStaffReportCounts(),
          loadStaffReports(filter),
        ])
        if (cancelled) return
        const c = result[0].status === 'fulfilled' ? result[0].value : null
        if (result[0].status === 'rejected') setRowsError(errText(result[0].reason))
        else setCounts(c as Record<string, number>)
        const r = result[1].status === 'fulfilled' ? result[1].value : null
        if (result[1].status === 'rejected') setRowsError(errText(result[1].reason))
        else setRows(r as ModerationReportRow[])
      } catch {
        if (!cancelled) { setRows([]); setCounts(null) }
      }
    })()
    return () => { cancelled = true }
  }, [filter, tick])

  const personOf = (row: ModerationReportRow) => row.reported_user_id ?? row.post_author_id

  const review = async (row: ModerationReportRow, status: string) => {
    if (!ops?.act) { flash('Your scopes do not include moderation.act.'); return }
    setBusy(true)
    try {
      await staffRpc('staff_report_review', {
        p_report: row.report_id, p_status: status, p_note: note || null,
      })
      flash(`Report filed as ${status} — audited.`)
      setNote('')
      setTick(t => t + 1)
      bump()
    } catch (err) {
      flash(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const moderatePost = async (row: ModerationReportRow, unpublish: boolean) => {
    if (!ops?.act) { flash('Your scopes do not include moderation.act.'); return }
    setBusy(true)
    try {
      const state = await staffRpc('staff_moderate_post', {
        p_post: row.post_id, p_unpublish: unpublish, p_note: note || null,
      })
      flash(`Post is now ${String(state)} — audited.`)
      setNote('')
      setTick(t => t + 1)
      bump()
    } catch (err) {
      flash(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmWarn = async () => {
    if (!target || target.kind !== 'warn') return
    if (!warnNote.trim()) { flash('A warning needs a note — tell the member why.'); return }
    setBusy(true)
    try {
      await staffRpc('staff_warn_user', { p_user: personOf(target.row), p_note: warnNote.trim() })
      flash(`Warning delivered to @${target.row.reported_username ?? target.row.post_author_username ?? 'member'} — audited.`)
      setWarnNote('')
      setTarget(null)
      setTick(t => t + 1)
      bump()
    } catch (err) {
      flash(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmSuspend = async () => {
    if (!target || target.kind !== 'suspend') return
    setBusy(true)
    try {
      await staffRpc('member_suspend', { p_user: personOf(target.row), p_reason: note || null })
      flash('Member suspended — their writes are now database-blocked.')
      setNote('')
      setTarget(null)
      setTick(t => t + 1)
      bump()
    } catch (err) {
      flash(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const open = filter === 'open' || filter === 'reviewing'

  return (
    <div className="staff-mod">
      <div className="staff-filterrow" role="tablist">
        {REPORT_FILTERS.map(f => (
          <button key={f.key} className={`staff-chip clickable ${filter === f.key ? 'selected' : ''}`}
            onClick={() => setFilter(f.key)}>
            {f.label}{counts?.[f.key] !== undefined ? ` · ${counts[f.key]}` : ''}
          </button>
        ))}
      </div>
      <label className="staff-reason">
        <span>Reviewer note (optional, recorded in the audit log):</span>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="context for the next reviewer…"/>
      </label>

      {rowsError && <div className="staff-error"><AlertCircle size={16}/><span>{rowsError}</span></div>}

      {rows === null ? <p className="staff-muted">Loading queue…</p>
        : rows.length === 0
          ? <div className="staff-empty">Nothing in the {filter} bucket{filter !== 'all' && counts?.[filter] === 0 ? ' — quiet in here' : ''}.</div>
          : <div className="staff-mod-list">
              {rows.map(row => {
                const personName = row.reported_username ?? row.post_author_username
                const personId = personOf(row)
                return (
                  <div key={row.report_id} className="staff-mod-card">
                    <div className="staff-mod-head">
                      <span className={`staff-subject ${row.subject_kind === 'person' ? 'soft' : ''}`}>{SUBJECT_LABEL[row.subject_kind]}</span>
                      <span className={`staff-status-pill s-${row.status}`}>{row.status}</span>
                      <small>{row.reporter_username ? `@${row.reporter_username}` : 'reporter gone'} · {timeAgo(row.created_at)}</small>
                    </div>
                    <b className="staff-mod-reason">{row.reason}</b>
                    {row.details ? <p className="staff-mod-details">“{row.details}”</p> : null}
                    {row.post_id && (
                      <div className="staff-mod-post">
                        <code>{row.post_excerpt}</code>
                        <small>
                          by {row.post_author_username ? `@${row.post_author_username}` : 'unknown author'}
                          {row.post_author_username ? ' · ' : ''}
                          {row.post_is_published ? 'live' : 'hidden'} · {timeAgo(row.post_created_at ?? row.created_at)}
                        </small>
                      </div>
                    )}
                    {row.reported_user_id && (
                      <small className="staff-mod-person">
                        {row.reported_name?.trim() || '@' + row.reported_username}
                        {row.reported_username ? ` (@${row.reported_username})` : ''}
                        {' · '}{row.reported_role}
                        {row.reported_account_status === 'suspended' ? ' · SUSPENDED' : ''}
                      </small>
                    )}
                    {row.reviewed_at && (
                      <small className="staff-mod-reviewed">
                        reviewed {timeAgo(row.reviewed_at)}{row.reviewed_by_username ? ` by @${row.reviewed_by_username}` : ''}
                      </small>
                    )}
                    <div className="staff-mod-actions">
                      {open ? (
                        <>
                          {ops?.act && (
                            <>
                              <button className="staff-btn" disabled={busy} onClick={() => void review(row, 'dismissed')}>
                                <X size={14}/> Dismiss
                              </button>
                              <button className="staff-btn" disabled={busy} onClick={() => void review(row, 'resolved')}>
                                <Check size={14}/> Resolve
                              </button>
                              <button className="staff-btn warning" disabled={busy} onClick={() => { setTarget({ kind: 'warn', row }); setWarnNote(note) }}>
                                <AlertTriangle size={14}/> Warn
                              </button>
                            </>
                          )}
                          {ops?.suspend && personId && (
                            <button className="staff-btn danger" disabled={busy} onClick={() => setTarget({ kind: 'suspend', row })}>
                              <Ban size={14}/> Suspend person
                            </button>
                          )}
                          {ops?.act && row.post_id && (
                            row.post_is_published
                              ? <button className="staff-btn warning" disabled={busy} onClick={() => void moderatePost(row, true)}>
                                  <EyeOff size={14}/> Hide post
                                </button>
                              : <button className="staff-btn" disabled={busy} onClick={() => void moderatePost(row, false)}>
                                  <Eye size={14}/> Restore post
                                </button>
                          )}
                        </>
                      ) : (
                        ops?.act && (
                          <button className="staff-btn" disabled={busy} onClick={() => void review(row, 'open')}>
                            <RotateCcw size={14}/> Re-open
                          </button>
                        )
                      )}
                    </div>
                  </div>
                )
              })}
            </div>}

      {target?.kind === 'warn' && (
        <div className="staff-confirm">
          <b>Warn @{target.row.reported_username ?? target.row.post_author_username}?</b>
          <p>A ‘staff_warning’ notification lands in their inbox with your note — nobody else sees the copy.</p>
          <label className="staff-warn-note">
            <span>Warning note (required):</span>
            <input value={warnNote} onChange={e => setWarnNote(e.target.value)} placeholder="what the member must change…"/>
          </label>
          <div>
            <button className="staff-btn warning" disabled={busy} onClick={() => void confirmWarn()}>Send warning</button>
            <button className="staff-btn" onClick={() => setTarget(null)}>Cancel</button>
          </div>
        </div>
      )}

      {target?.kind === 'suspend' && (
        <div className="staff-confirm">
          <b>Suspend @{target.row.reported_username ?? target.row.post_author_username}?</b>
          <p>Writes (posts, comments, follows, chats, listings) become database-blocked. Reversible from the People tab.</p>
          <div>
            <button className="staff-btn danger" disabled={busy} onClick={() => void confirmSuspend()}>Confirm suspend</button>
            <button className="staff-btn" onClick={() => setTarget(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : 'The request failed.'
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

/* -------------------------------------------------------------------------- */
/* ---- Pulse admin (migration 0048 · has_op('pulse.admin')) ----------------- */

type PulseAdminItem = {
  id: string; kind: string; category: string; body: string
  version: number; status: string; evergreen: boolean
  validUntil: string | null; createdAt: string
}
type PulseAdminJob = {
  jobKey: string; idemKey: string; ok: boolean
  detail: Record<string, unknown>; ranAt: string
}
type PulseConfigMap = Record<string, unknown>

const PULSE_STATUSES = ['draft', 'approved', 'paused', 'rejected'] as const
const PULSE_CONFIG_KEYS = [
  'pulse.weight.relevance', 'pulse.weight.quality', 'pulse.weight.freshness',
  'pulse.weight.engagement', 'pulse.weight.diversity', 'pulse.minSample',
  'pulse.trendMinLiftPts', 'pulse.freshnessDays',
  'pulse.engagementPriorStrength', 'pulse.engagementBaseline', 'pulse.statementDeck',
] as const

function PulseAdminTab({ busy, setBusy, flash, bump }: {
  busy: boolean; setBusy: (b: boolean) => void; flash: (message: string) => void; bump: () => void
}) {
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null)
  const [items, setItems] = useState<PulseAdminItem[] | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [config, setConfig] = useState<PulseConfigMap | null>(null)
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({})
  const [jobs, setJobs] = useState<PulseAdminJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setError(null)
      try {
        const [o, i, c, j] = await Promise.all([
          staffRpc('pulse_admin_overview'),
          staffRpc('pulse_admin_list', { p_status: statusFilter }),
          staffRpc('pulse_admin_config_get'),
          staffRpc('pulse_admin_jobs'),
        ])
        if (cancelled) return
        setOverview(o as Record<string, unknown>)
        setItems(i as PulseAdminItem[])
        const cfg = (c ?? {}) as PulseConfigMap
        setConfig(cfg)
        const drafts: Record<string, string> = {}
        for (const key of PULSE_CONFIG_KEYS) {
          const value = cfg[key]
          if (typeof value === 'number') drafts[key] = String(value)
          else if (typeof value === 'string') drafts[key] = value
        }
        setConfigDraft(drafts)
        setJobs(j as PulseAdminJob[])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Pulse admin data failed to load.')
      }
    })()
    return () => { cancelled = true }
  }, [statusFilter])

  const setStatus = async (item: PulseAdminItem, status: string) => {
    if (busy) return
    setBusy(true)
    try {
      await staffRpc('pulse_admin_set_status', { v_item: item.id, p_status: status, p_reason: null })
      flash(`Pulse ${item.kind} set to ${status}.`)
      bump()
      const i = await staffRpc('pulse_admin_list', { p_status: statusFilter })
      setItems(i as PulseAdminItem[])
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Status change failed.')
    } finally {
      setBusy(false)
    }
  }

  const saveConfig = async (key: string) => {
    if (busy) return
    const raw = configDraft[key] ?? ''
    const value = Number(raw)
    if (raw === '' || !Number.isFinite(value)) {
      flash('Configuration values must be numbers.')
      return
    }
    setBusy(true)
    try {
      await staffRpc('pulse_admin_config_set', { p_key: key, p_value: value })
      flash(`${key} saved — the engine reads it live.`)
      bump()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Configuration save failed.')
    } finally {
      setBusy(false)
    }
  }

  if (error && overview === null && items === null) {
    return <div className="staff-error"><AlertCircle size={16}/><span>{error}</span></div>
  }

  const byStatus = (overview?.itemsByStatus ?? {}) as Record<string, number>
  const num = (key: string) => {
    const v = overview?.[key]
    return typeof v === 'number' ? v : '—'
  }

  return (
    <div className="staff-grid">
      <div className="staff-card"><small>VOTES · 7 DAYS</small><b>{num('votes7')}</b><p>Genuine pulse responses.</p></div>
      <div className="staff-card"><small>VOTES TODAY</small><b>{num('votesToday')}</b><p>Skip data is below.</p></div>
      <div className="staff-card"><small>REACTIONS · 7 DAYS</small><b>{num('reactions7')}</b><p>Am I the Only One? activity.</p></div>
      <div className="staff-card"><small>QUIZ ATTEMPTS · 7 DAYS</small><b>{num('attempts7')}</b><p>Server-scored completions.</p></div>
      <div className="staff-card"><small>SKIPS TODAY</small><b>{num('skipsToday')}</b><p>Skipped questions — skips are never participation.</p></div>
      <div className="staff-card"><small>LIBRARY</small><b>{Number.isFinite(byStatus['approved']) ? byStatus['approved'] : '—'} approved</b><p>{JSON.stringify(byStatus)}</p></div>

      <div className="staff-card wide">
        <small>CONTENT LIBRARY</small>
        <div className="staff-filter-row" role="tablist" aria-label="Filter by status">
          {['', ...PULSE_STATUSES].map(s => (
            <button key={s || 'all'} className={`staff-chip ${statusFilter === s ? 'selected' : ''}`}
              onClick={() => setStatusFilter(s)}>{s === '' ? 'all' : s}</button>
          ))}
        </div>
        {items === null
          ? <p className="staff-muted">Loading the library…</p>
          : items.length === 0
            ? <p className="staff-muted">No items in this status yet.</p>
            : (
              <ul className="staff-mini-audit">
                {items.map(item => (
                  <li key={item.id}>
                    <span className={`staff-audit-badge ${item.status}`} title={item.id}>{item.kind} · {item.status}</span>
                    <div className="staff-audit-copy">
                      <b>{item.body.length > 90 ? item.body.slice(0, 90) + '…' : item.body}</b>
                      <span>{item.category} · v{item.version}{item.evergreen ? ' · evergreen' : ''}</span>
                    </div>
                    <span className="staff-status-select">
                      {PULSE_STATUSES.map(s => (
                        <button key={s} disabled={busy || s === item.status}
                          className={s === item.status ? 'selected' : ''}
                          onClick={() => void setStatus(item, s)} title={`Set ${s}`} aria-label={`Set ${s}`}>
                          {s.slice(0, 2)}
                        </button>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
      </div>

      <div className="staff-card wide">
        <small>ENGINE CONFIGURATION</small>
        <p className="staff-muted">Weights drive the selection score; thresholds drive privacy and trend gating. Versioned by author on save.</p>
        {config === null
          ? <p className="staff-muted">Loading configuration…</p>
          : (
            <div className="pulse-config-grid">
              {PULSE_CONFIG_KEYS.map(key => (
                <label key={key} className="pulse-config-row">
                  <span>{key}</span>
                  <span className="pulse-config-controls">
                    <input
                      inputMode="decimal"
                      value={configDraft[key] ?? ''}
                      onChange={e => setConfigDraft(d => ({ ...d, [key]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') void saveConfig(key) }}
                    />
                    <button className="staff-ghost" disabled={busy} onClick={() => void saveConfig(key)}>Save</button>
                  </span>
                </label>
              ))}
            </div>
          )}
      </div>

      <div className="staff-card wide">
        <small>SCHEDULED-JOB RUNS</small>
        {jobs === null
          ? <p className="staff-muted">Loading job runs…</p>
          : jobs.length === 0
            ? <p className="staff-muted">No Pulse jobs have run yet — they log on first daily view.</p>
            : (
              <ul className="staff-mini-audit">
                {jobs.slice(0, 20).map((job, i) => (
                  <li key={`${job.jobKey}:${job.idemKey}:${i}`}>
                    <span className={`staff-audit-badge ${job.ok ? 'approved' : 'rejected'}`}>{job.ok ? 'ok' : 'fail'}</span>
                    <div className="staff-audit-copy">
                      <b>{job.jobKey}</b>
                      <span>{job.idemKey} · {timeAgo(job.ranAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        <p className="staff-muted staff-clock"><Clock size={11}/> The publisher is idempotent: one instance per campus per day, materialized on first read.</p>
      </div>
    </div>
  )
}
