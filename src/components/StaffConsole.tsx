import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import {
  ShieldCheck, LayoutDashboard, Users, Building2, Megaphone, ScrollText,
  Ban, RotateCcw, Crown, Search, UserCog, AlertCircle, Clock,
  Flag, AlertTriangle, EyeOff, Eye, Check, X, Sparkles,
  FileSearch, Image as ImageIcon,
} from 'lucide-react'
import { AdsAdmin } from './AdsAdmin'
import { useSignedMedia } from '../lib/signedMedia'
import {
  StaffAccountRow, StaffAuditRow, Profile, ModerationReportRow,
  loadStaffRoster, loadStaffAudit, findStaffTargets, staffRpc,
  loadStaffReports, loadStaffReportCounts, fetchStaffPostContent, StaffPostContent,
  DirectoryStats, CollegeRequest, fetchDirectoryStats, listCollegeRequests, reviewCollegeRequest,
  pulseAdminAiGet, pulseAdminAiSet, pulseAdminEventsStats, pulseAdminMaintenance,
  pulseAdminPushQuiz, pulseGenerateQuiz,
  type PulseAdminAiSettings, type PulseAdminEventsStats as PulseEventsStats,
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
      {tab === 'colleges' && <CollegesTab flash={flash}/>}
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

/**
 * Full-content inspector (0053): renders exactly what a reporter saw — full
 * body plus media through the signed layer. Each opened view debits an
 * `moderation.view_content` audit row server-side, so this only mounts on an
 * explicit toggle, never ambently.
 */
function StaffPostInspector({ postId }: { postId: string }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; post: StaffPostContent }
  >({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const post = await fetchStaffPostContent(postId)
        if (!cancelled) setState({ kind: 'ready', post })
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', message: errText(err) })
      }
    })()
    return () => { cancelled = true }
  }, [postId])

  if (state.kind === 'loading') return <p className="staff-muted">Fetching full content…</p>
  if (state.kind === 'error') return <p className="staff-inspect-err"><AlertCircle size={14}/>{state.message}</p>

  const post = state.post
  return (
    <div className="staff-inspect">
      <code>{post.body}</code>
      <StaffPostMedia urls={post.media_urls}/>
      <small>
        {post.is_anonymous
          ? 'anonymous post — author identity not shown, by design'
          : `by ${post.author_name?.trim() || '@' + (post.author_username ?? '?')}${post.author_username ? ` (@${post.author_username})` : ''}`}
        {' · '}{post.is_published ? 'live' : 'hidden'}
        {post.edited_at ? ' · edited' : ''}
        {' · '}{timeAgo(post.created_at)}
      </small>
    </div>
  )
}

/** Inspector media: signed-minted tiles, with the honest "denied" fallback. */
function StaffPostMedia({ urls }: { urls: string[] }) {
  const signed = useSignedMedia(urls.length ? urls : null)
  if (!urls.length) return null
  return (
    <div className="staff-mod-media">
      {signed.urls.map((u, i) => <img key={i} src={u} alt="" loading="lazy"/>)}
      {signed.blocked ? <small className="staff-mod-media-note">media not viewable right now</small> : null}
    </div>
  )
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
  const [inspectId, setInspectId] = useState<string | null>(null)

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
            onClick={() => { setFilter(f.key); setInspectId(null) }}>
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
                          by {row.post_author_username
                            ? `@${row.post_author_username}`
                            : 'author not shown'}
                          {row.post_author_username ? ' · ' : ''}
                          {row.post_is_published ? 'live' : 'hidden'} · {timeAgo(row.post_created_at ?? row.created_at)}
                        </small>
                        {row.post_id && (
                          <div className="staff-mod-scope">
                            {row.post_community_name && (
                              <span className="staff-scope-pill community">{row.post_community_name}</span>
                            )}
                            {!row.post_community_name && (row.post_audience === 'college'
                              ? <span className="staff-scope-pill college">My College only</span>
                              : <span className="staff-scope-pill public">Everyone</span>)}
                            {row.post_has_media && (
                              <span className="staff-scope-pill media"><ImageIcon size={11}/> media</span>
                            )}
                            <button
                              type="button"
                              className="staff-scope-toggle"
                              onClick={() => setInspectId(inspectId === row.post_id ? null : row.post_id)}
                            >
                              <FileSearch size={12}/>{inspectId === row.post_id ? 'close' : 'full content'}
                            </button>
                          </div>
                        )}
                        {inspectId === row.post_id && <StaffPostInspector postId={row.post_id}/>}
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

function CollegesTab({ flash }: { flash: (message: string) => void }) {
  const [stats, setStats] = useState<DirectoryStats | null>(null)
  const [requests, setRequests] = useState<CollegeRequest[] | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try { const row = await fetchDirectoryStats(); if (!cancelled) setStats(row) }
      catch { if (!cancelled) setStats(null) }
      try {
        const rows = await listCollegeRequests(filter, 50)
        if (!cancelled) { setRequests(rows); setRequestError(null) }
      } catch (error) {
        if (!cancelled) { setRequests([]); setRequestError(errText(error)) }
      }
    })()
    return () => { cancelled = true }
  }, [filter, tick])

  async function decide(request: CollegeRequest, publish: boolean) {
    setBusyId(request.id)
    setRequestError(null)
    try {
      await reviewCollegeRequest(request.id, 'approved', { publish })
      flash(publish
        ? `${request.name} added to the directory and published.`
        : `${request.name} added as pending review.`)
      setTick(value => value + 1)
    } catch (error) {
      setRequestError(errText(error))
    } finally {
      setBusyId(null)
    }
  }

  async function reject(request: CollegeRequest) {
    setBusyId(request.id)
    setRequestError(null)
    try {
      await reviewCollegeRequest(request.id, 'rejected')
      flash(`${request.name} request rejected.`)
      setTick(value => value + 1)
    } catch (error) {
      setRequestError(errText(error))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="staff-colleges">
      <div className="staff-card wide">
        <small>DIRECTORY SNAPSHOT</small>
        <p className="staff-muted">
          {stats
            ? `${stats.collegesTotal} institutions · ${stats.verified} listed · ${stats.pendingReview} pending review`
            : 'Exact counts need supabase/migrations/0061_directory_flow_repairs.sql applied.'}
        </p>
        {stats && (
          <p className="staff-muted">
            {stats.groups} groups · {stats.campuses} campuses · {stats.departments} departments · {stats.programs} programs
          </p>
        )}
        <p className="staff-muted">
          Approving a request only ADDS the institution — it stays pending review until someone publishes it,
          so an unverified college never becomes publicly selectable by accident.
        </p>
      </div>

      <div className="staff-card wide">
        <small>COLLEGE REQUESTS FROM STUDENTS</small>
        <div className="staff-filterrow" role="tablist" aria-label="Request status">
          {(['pending', 'approved', 'rejected'] as const).map(value => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              className={`staff-chip clickable ${filter === value ? 'selected' : ''}`}
              onClick={() => setFilter(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        {requestError && <div className="staff-error" role="alert"><span>{requestError}</span></div>}
        {requests === null && <p className="staff-muted">Loading…</p>}
        {requests?.length === 0 && <p className="staff-muted">Nothing {filter} right now.</p>}
        {requests?.map(request => (
          <div key={request.id} className="staff-person">
            <span className="avatar small"><Building2 size={14}/></span>
            <div className="staff-person-copy">
              <b>{request.name}</b>
              <small>
                {[request.locality, request.city, request.institutionType?.replace('_', ' '),
                  request.collegeShortName ? `listed as ${request.collegeShortName}` : null]
                  .filter(Boolean).join(' · ') || 'No location given'}
              </small>
              <small>
                {request.requesterName
                  ? `${request.requesterName}${request.requesterHandle ? ` (@${request.requesterHandle})` : ''}`
                  : 'Unknown member'}
                {request.createdAt ? ` · ${timeAgo(request.createdAt)}` : ''}
              </small>
              {request.website && <small>{request.website}</small>}
              {request.statusNote && <small>Note: {request.statusNote}</small>}
            </div>
            {filter === 'pending' && (
              <span className="staff-person-actions staff-request-actions">
                <button className="secondary-button" disabled={busyId === request.id} onClick={() => void decide(request, false)}>
                  Approve
                </button>
                <button className="secondary-button" disabled={busyId === request.id} onClick={() => void decide(request, true)}>
                  Approve &amp; publish
                </button>
                <button className="secondary-button" disabled={busyId === request.id} onClick={() => void reject(request)}>
                  Reject
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
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
  // 2.0 recommendation weights (0072) — presentation-order ranking, mirrors src/lib/pulse/config.ts
  'pulse.recommend.interest', 'pulse.recommend.quality', 'pulse.recommend.freshness',
  'pulse.recommend.diversity', 'pulse.recommend.satisfaction', 'pulse.recommend.campus',
  'pulse.recommend.exploration',
  // 2.0 AI knobs (numeric ones only — the model name rides pulse_admin_ai_set)
  'pulse.ai.dailyBudget', 'pulse.ai.maxRetries',
  // 2.1 autonomy thresholds (0073) — toggles are separate checkboxes below
  'pulse.notify.cohortMinScore', 'pulse.notify.cohortCap',
  'pulse.nudge.idleDays', 'pulse.nudge.cap',
] as const

/** topics offered to the AI generator (mirrors pulse_topics in 0072) */
const PULSE_AI_TOPICS = [
  ['campus_life', '🎓 Campus life'], ['exams', '📚 Exams & study'], ['food', '🍜 Food & mess'],
  ['hostel', '🛏️ Hostel life'], ['commute', '🚌 Commute'], ['fests', '🎉 Fests & events'],
  ['technology', '💻 Technology'], ['placements', '🧭 Placements & career'],
  ['sports', '🏏 Sports & fitness'], ['entertainment', '🎬 Entertainment'],
  ['entrepreneurship', '🚀 Startups & ideas'],
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
  /* 2.0: AI generation + analytics */
  const [ai, setAi] = useState<PulseAdminAiSettings | null>(null)
  const [aiDraft, setAiDraft] = useState<{ model: string; dailyBudget: string; maxRetries: string }>({ model: '', dailyBudget: '12', maxRetries: '2' })
  const [events, setEvents] = useState<PulseEventsStats | null>(null)
  const [genTopic, setGenTopic] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setError(null)
      try {
        const [o, i, c, j, a, e] = await Promise.all([
          staffRpc('pulse_admin_overview'),
          staffRpc('pulse_admin_list', { p_status: statusFilter }),
          staffRpc('pulse_admin_config_get'),
          staffRpc('pulse_admin_jobs'),
          pulseAdminAiGet().catch(() => null),   // pre-0072 DB: show the card, honestly empty
          pulseAdminEventsStats().catch(() => null),
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
        if (a) {
          setAi(a)
          setAiDraft({ model: a.model, dailyBudget: String(a.dailyBudget), maxRetries: String(a.maxRetries) })
        }
        setEvents(e)
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

  /* ---- 2.0: AI settings, generation, maintenance ---- */
  const saveAi = async () => {
    if (busy || !ai) return
    const model = aiDraft.model.trim()
    const dailyBudget = Number(aiDraft.dailyBudget)
    const maxRetries = Number(aiDraft.maxRetries)
    if (model.length < 3) { flash('Enter an OpenRouter model name, e.g. "openai/gpt-4o-mini".'); return }
    if (!Number.isInteger(dailyBudget) || dailyBudget < 0 || dailyBudget > 500) { flash('Daily budget must be a whole number between 0 and 500.'); return }
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) { flash('Max retries must be a whole number between 0 and 5.'); return }
    setBusy(true)
    try {
      await pulseAdminAiSet({ enabled: ai.enabled, model, dailyBudget, maxRetries })
      setAi({ ...ai, model, dailyBudget, maxRetries })
      flash(`AI settings saved — the model is "${model}". The key itself stays in server secrets.`)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'AI settings save failed.')
    } finally {
      setBusy(false)
    }
  }

  const generateAi = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await pulseGenerateQuiz(genTopic || undefined)
      if (res.error) flash(`Generation refused: ${res.error}`)
      else if (res.ok && res.status === 'approved') flash(`Quiz "${res.title}" published automatically — the interest cohort was notified.`)
      else if (res.ok) flash(`Draft quiz "${res.title}" inserted — approve it in the content library above.`)
      else flash('Generation returned nothing usable — check the job runs below.')
      bump()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'AI generation is unavailable.')
    } finally {
      setBusy(false)
    }
  }

  /* ---- 2.1 autonomy toggles (pulse.ai.autoPublish / pulse.notify.auto) ---- */
  const setFlag = async (key: string, value: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      await staffRpc('pulse_admin_config_set', { p_key: key, p_value: value ? 1 : 0 })
      setConfig(d => ({ ...(d ?? {}), [key]: value ? 1 : 0 }))
      flash(`${key} ${value ? 'ON' : 'OFF'} — the engine reads it live.`)
      bump()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Toggle failed.')
    } finally {
      setBusy(false)
    }
  }

  /* ---- 2.1 manual push (admin override; server enforces the 3-day cooldown) ---- */
  const pushQuiz = async (item: PulseAdminItem, scope: 'cohort' | 'all') => {
    if (busy) return
    setBusy(true)
    try {
      const res = await pulseAdminPushQuiz(item.id, scope)
      flash(res.reason === 'recently-notified'
        ? 'That quiz was already pushed in the last 3 days — cooldown active.'
        : `Pushed to ${res.queued} student(s) (${scope === 'all' ? 'whole campus' : 'interest cohort'}).`)
      bump()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Push failed.')
    } finally {
      setBusy(false)
    }
  }

  const runMaintenance = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await pulseAdminMaintenance()
      flash(`Maintenance done — ${res.eventsPruned} old event row(s) pruned.`)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Maintenance failed.')
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
                    {item.kind === 'quiz' && item.status === 'approved' && (
                      <span className="staff-status-select pulse-push-select">
                        <button disabled={busy}
                          onClick={() => void pushQuiz(item, 'cohort')}
                          title="Notify the interest cohort for this quiz (3-day cooldown)"
                          aria-label="Push to interest cohort">📣 cohort</button>
                        <button disabled={busy}
                          onClick={() => void pushQuiz(item, 'all')}
                          title="Notify every member (3-day cooldown)"
                          aria-label="Push to everyone">📣 all</button>
                      </span>
                    )}
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
        <small>AI GENERATION · OPENROUTER</small>
        {ai === null ? (
          <p className="staff-muted">
            AI settings are unavailable — migration 0072 may not be applied yet.
            Everything else on this tab keeps working without it.
          </p>
        ) : (
          <>
            <p className="staff-muted">
              {ai.enabled ? 'Enabled' : 'Disabled'} · model <b>{ai.model || '(none set)'}</b> · budget {ai.dailyBudget}/day · {ai.maxRetries} retr{ai.maxRetries === 1 ? 'y' : 'ies'}.
              {config?.['pulse.ai.autoPublish'] === 1
                ? ' Autonomy is ON — validated quizzes publish straight to their interest cohort.'
                : ' Generated quizzes land as draft — nothing publishes without your approval above.'}
            </p>
            <div className="pulse-ai-row">
              <button className="staff-ghost" disabled={busy} onClick={() => void (async () => {
                try {
                  await pulseAdminAiSet({ enabled: !ai.enabled, model: ai.model || 'openai/gpt-4o-mini', dailyBudget: ai.dailyBudget, maxRetries: ai.maxRetries })
                  setAi({ ...ai, enabled: !ai.enabled })
                  flash(`AI generation ${!ai.enabled ? 'enabled' : 'disabled'}.`)
                } catch (err) { flash(err instanceof Error ? err.message : 'Toggle failed.') }
              })()}>
                {ai.enabled ? 'Disable generation' : 'Enable generation'}
              </button>
              <input
                aria-label="OpenRouter model"
                placeholder='e.g. openai/gpt-4o-mini'
                value={aiDraft.model}
                onChange={e => setAiDraft(d => ({ ...d, model: e.target.value }))}
              />
              <input
                aria-label="Daily generation budget" inputMode="numeric" className="pulse-ai-num"
                value={aiDraft.dailyBudget}
                onChange={e => setAiDraft(d => ({ ...d, dailyBudget: e.target.value }))}
              />
              <input
                aria-label="Max retries" inputMode="numeric" className="pulse-ai-num"
                value={aiDraft.maxRetries}
                onChange={e => setAiDraft(d => ({ ...d, maxRetries: e.target.value }))}
              />
              <button className="staff-ghost" disabled={busy} onClick={() => void saveAi()}>Save</button>
            </div>
            <div className="pulse-ai-row pulse-autonomy-row">
              <label className="pulse-autonomy-toggle">
                <input
                  type="checkbox"
                  checked={config?.['pulse.ai.autoPublish'] === 1}
                  disabled={busy}
                  onChange={e => void setFlag('pulse.ai.autoPublish', e.target.checked)}
                />
                <span>Auto-publish generated quizzes (no manual approval)</span>
              </label>
              <label className="pulse-autonomy-toggle">
                <input
                  type="checkbox"
                  checked={config?.['pulse.notify.auto'] !== 0}
                  disabled={busy}
                  onChange={e => void setFlag('pulse.notify.auto', e.target.checked)}
                />
                <span>Notify interest cohorts when a quiz goes live</span>
              </label>
            </div>
            <div className="pulse-ai-row">
              <select
                aria-label="Topic for the generated quiz"
                value={genTopic}
                onChange={e => setGenTopic(e.target.value)}
              >
                <option value="">Auto-pick topic</option>
                {PULSE_AI_TOPICS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <button className="staff-ghost" disabled={busy} onClick={() => void generateAi()}>Generate AI quiz</button>
            </div>
            <p className="staff-muted">
              Requires the pulse-generate edge function deployed and the OPENROUTER_API_KEY secret set —
              the key never touches this page or the browser.
            </p>
          </>
        )}
      </div>

      <div className="staff-card wide">
        <small>PERSONALIZATION & ANALYTICS · 7 DAYS</small>
        {events === null ? (
          <p className="staff-muted">Analytics are unavailable — migration 0072 may not be applied yet.</p>
        ) : (
          <>
            <div className="staff-grid">
              <div className="staff-card"><small>PROFILES LEARNED</small><b>{events.profilesLearned}</b><p>Interest profiles touched this week.</p></div>
              <div className="staff-card"><small>PERSONALIZATION ON</small><b>{events.personalizationOn}</b><p>Students who opted in (default on).</p></div>
            </div>
            <p className="staff-muted">Events (7 days):</p>
            {events.events7.length === 0
              ? <p className="staff-muted">No analytics events yet — they log as students use Pulse 2.0.</p>
              : (
                <ul className="staff-mini-audit">
                  {events.events7.map(ev => (
                    <li key={ev.key}>
                      <span className="staff-audit-badge approved">{ev.n}</span>
                      <div className="staff-audit-copy"><b>{ev.key}</b></div>
                    </li>
                  ))}
                </ul>
              )}
            <p className="staff-muted">Topic signals (7 days):</p>
            {events.topicSignals7.length === 0
              ? <p className="staff-muted">No topic signals yet.</p>
              : (
                <ul className="staff-mini-audit">
                  {events.topicSignals7.map(t => (
                    <li key={t.topic}>
                      <span className="staff-audit-badge approved">{t.positive}↑ {t.negative}↓</span>
                      <div className="staff-audit-copy"><b>{t.topic}</b></div>
                    </li>
                  ))}
                </ul>
              )}
            <div className="pulse-ai-row">
              <button className="staff-ghost" disabled={busy} onClick={() => void runMaintenance()}>Run retention maintenance</button>
              <span className="staff-muted">Prunes pulse_events past the 90-day window.</span>
            </div>
          </>
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
