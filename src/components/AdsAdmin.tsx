import { useCallback, useEffect, useMemo, useState } from 'react'
import { Building2, ChartLine, FilePlus2, LayoutGrid, Search, Megaphone } from 'lucide-react'
import type {
  AdAnalytics,
  AdCampaignDetail,
  AdCampaignRow,
  AdCollegeChip,
  AdCollegeHit,
  AdOverview,
  CampaignStatus,
} from '../lib/ads'
import {
  CTA_LABELS,
  STATUS_LABELS,
  adMediaUrl,
  duplicateAdCampaign,
  fetchAdCampaign,
  fetchAdCampaigns,
  fetchAdOverview,
  searchAdColleges,
  setAdCampaignStatus,
} from '../lib/ads'
import CampaignWizard from './CampaignWizard'

type Tab = 'overview' | 'campaigns' | 'colleges'

const fmtDate = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
const fmtInt = (n: number | null | undefined) => (n ?? 0).toLocaleString()
const ctrOf = (clicks: number, impressions: number) =>
  impressions > 0 ? `${(Math.round((clicks / impressions) * 10000) / 100).toFixed(2)}%` : '—'

/** Ads CAMPUS admins can review CTA labels without guessing keys. */
function ctaLabel(key: string) {
  return CTA_LABELS[key as keyof typeof CTA_LABELS] ?? key
}

/**
 * The admin advertising dashboard (single new admin page, reusing CAMPUS nav
 * + design tokens). Everything shown comes from real records via the admin
 * RPCs; loading / empty / error states are honest and there is no hardcoded
 * statistic anywhere.
 */
export function AdsAdmin({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [overview, setOverview] = useState<AdOverview | null>(null)
  const [campaigns, setCampaigns] = useState<AdCampaignRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [wizard, setWizard] = useState<{ mode: 'create' | 'edit'; campaignId: string | null; initial: AdCampaignDetail | null } | null>(null)
  const [detail, setDetail] = useState<AdCampaignDetail | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoadError(null)
    try {
      const [ov, rows] = await Promise.all([
        fetchAdOverview(),
        fetchAdCampaigns(),
      ])
      setOverview(ov)
      setCampaigns(rows)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load advertising data.')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const openEdit = async (campaignId: string) => {
    try {
      const initial = await fetchAdCampaign(campaignId)
      setWizard({ mode: 'edit', campaignId, initial })
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not open that campaign.')
    }
  }

  const openDetail = async (campaignId: string) => {
    try {
      const d = await fetchAdCampaign(campaignId)
      setDetail(d)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not open that campaign.')
    }
  }

  const applyStatus = async (campaignId: string, status: CampaignStatus, label: string) => {
    setActionBusy(`${campaignId}:${status}`)
    try {
      await setAdCampaignStatus(campaignId, status)
      flash(`Campaign ${label}.`)
      if (detail?.campaign.id === campaignId) await openDetail(campaignId)
      await refresh()
    } catch (err) {
      flash(err instanceof Error ? err.message : `Could not ${label} the campaign.`)
    } finally {
      setActionBusy(null)
    }
  }

  const doDuplicate = async (campaignId: string) => {
    setActionBusy(`${campaignId}:duplicate`)
    try {
      await duplicateAdCampaign(campaignId)
      flash('Copy created as a draft — re-attach the creative to publish.')
      await refresh()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not duplicate the campaign.')
    } finally {
      setActionBusy(null)
    }
  }

  /** Actions genuinely permitted for each status (mirrors the server machine). */
  const actionsFor = (row: AdCampaignRow) => {
    const busy = (suffix: string) => actionBusy === `${row.id}:${suffix}`
    const btn = (key: string, label: string, status: CampaignStatus, klass = '') => (
      <button key={key} className={`ad-action ${klass}`} disabled={actionBusy !== null} onClick={() => void applyStatus(row.id, status, label.toLowerCase())}>
        {busy(key) ? '…' : label}
      </button>
    )
    const edit = (
      <button key="edit" className="ad-action" disabled={actionBusy !== null} onClick={() => void openEdit(row.id)}>Edit</button>
    )
    const view = <button key="view" className="ad-action" onClick={() => void openDetail(row.id)}>View</button>
    const dup = <button key="dup" className="ad-action" disabled={actionBusy !== null} onClick={() => void doDuplicate(row.id)}>Duplicate</button>
    const list: React.ReactNode[] = [view]
    switch (row.status) {
      case 'draft': list.push(edit); break
      case 'scheduled': list.push(edit, btn('pause', 'Pause', 'paused'), btn('draft', 'Back to draft', 'draft')); break
      case 'active': list.push(btn('pause', 'Pause', 'paused'), btn('complete', 'End now', 'completed')); break
      case 'paused': list.push(edit, btn('active', 'Resume', 'active'), btn('complete', 'End now', 'completed'), btn('draft', 'Back to draft', 'draft')); break
      case 'completed': list.push(dup); break
      case 'archived': list.push(dup); break
    }
    return list
  }

  if (wizard) {
    return (
      <section className="ads-page">
        <CampaignWizard
          mode={wizard.mode}
          campaignId={wizard.campaignId}
          initial={wizard.initial}
          onSaved={() => { setWizard(null); void refresh() }}
          onCancel={() => setWizard(null)}
          flash={flash}
        />
      </section>
    )
  }

  if (detail) {
    return <CampaignDetail detail={detail} onClose={() => setDetail(null)} flash={flash} />
  }

  return (
    <section className="ads-page">
      <header className="ads-head">
        <div>
          <p className="ad-eyebrow">CAMPUS ADMIN</p>
          <h2 className="ads-title"><Megaphone size={22} aria-hidden="true"/> Advertising</h2>
          <p className="ads-sub">Sponsored campaigns targeted at colleges · first-party placements only</p>
        </div>
        <button className="ads-create-button" onClick={() => setWizard({ mode: 'create', campaignId: null, initial: null })}>
          <FilePlus2 size={17}/> Create campaign
        </button>
      </header>

      <nav className="ads-tabs" aria-label="Advertising sections">
        <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}><LayoutGrid size={15}/> Overview</button>
        <button className={tab === 'campaigns' ? 'on' : ''} onClick={() => setTab('campaigns')}><Megaphone size={15}/> Campaigns</button>
        <button className={tab === 'colleges' ? 'on' : ''} onClick={() => setTab('colleges')}><Building2 size={15}/> Colleges</button>
      </nav>

      {loadError && (
        <p className="ad-error" role="alert">{loadError}
          <button className="ad-action" onClick={() => void refresh()}>Retry</button>
        </p>
      )}

      {tab === 'overview' && (
        <OverviewPanel overview={overview} campaigns={campaigns} onOpenDetail={openDetail} onOpenCreate={() => setTab('campaigns')}/>
      )}

      {tab === 'campaigns' && (
        <CampaignsPanel campaigns={campaigns} actionsFor={actionsFor} onOpenDetail={openDetail}/>
      )}

      {tab === 'colleges' && <CollegesPanel/>}
    </section>
  )
}

/* ------------------------------------------------------------- overview -- */

function OverviewPanel({
  overview,
  campaigns,
  onOpenDetail,
  onOpenCreate,
}: {
  overview: AdOverview | null
  campaigns: AdCampaignRow[] | null
  onOpenDetail: (id: string) => void
  onOpenCreate: () => void
}) {
  if (!overview) return <p className="ads-state" role="status">Loading real advertising metrics…</p>
  const tiles: Array<{ label: string; value: string | number; hint?: string }> = [
    { label: 'Total campaigns', value: overview.total },
    { label: 'Draft', value: overview.draft },
    { label: 'Scheduled', value: overview.scheduled },
    { label: 'Active', value: overview.active },
    { label: 'Paused', value: overview.paused },
    { label: 'Completed', value: overview.completed },
    { label: 'Impressions', value: fmtInt(overview.impressions) },
    { label: 'Clicks', value: fmtInt(overview.clicks) },
    { label: 'Aggregate CTR', value: ctrOf(overview.clicks, overview.impressions) },
    { label: 'Ending within 3 days', value: overview.ending_soon, hint: 'active campaigns approaching their end date' },
  ]
  const endingSoon = (campaigns ?? [])
    .filter(row => row.status === 'active' && new Date(row.end_at).getTime() <= Date.now() + 3 * 24 * 60 * 60 * 1000)
    .sort((a, b) => new Date(a.end_at).getTime() - new Date(b.end_at).getTime())

  return (
    <>
      <div className="ads-tiles">
        {tiles.map(tile => (
          <div key={tile.label} className="ads-tile">
            <span className="ads-tile-value">{tile.value}</span>
            <span className="ads-tile-label">{tile.label}</span>
            {tile.hint && <span className="ads-tile-hint">{tile.hint}</span>}
          </div>
        ))}
      </div>

      <div className="ads-section-head">
        <h3><ChartLine size={16} aria-hidden="true"/> Approaching their end date</h3>
      </div>
      {endingSoon.length === 0
        ? <p className="ads-state">No active campaign ends within the next 3 days.</p>
        : (
          <ul className="ads-mini-list">
            {endingSoon.map(row => (
              <li key={row.id}>
                <button onClick={() => onOpenDetail(row.id)}>
                  <b>{row.name}</b>
                  <span>{row.advertiser_name}</span>
                  <span className="ads-enddate">ends {fmtDate(row.end_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

      {(campaigns ?? []).length === 0 && !campaigns && null}
      <div className="ads-section-head"><h3>Campaign status breakdown</h3></div>
      {campaigns != null && campaigns.length === 0 && (
        <p className="ads-state">No campaigns yet — your first sponsored campaign appears here once you <button className="ad-action inline" onClick={onOpenCreate}>create one</button>.</p>
      )}
      {campaigns != null && campaigns.length > 0 && (
        <ul className="ads-campaign-grid">
          {campaigns.slice(0, 6).map(row => (
            <li key={row.id}>
              <button className="ads-campaign-tile" onClick={() => onOpenDetail(row.id)}>
                <span className={`ads-status st-${row.status}`}>{STATUS_LABELS[row.status]}</span>
                <b>{row.name}</b>
                <span>{row.advertiser_name} · {row.colleges.length} college{row.colleges.length === 1 ? '' : 's'} · {fmtInt(row.impressions_count)} impr · {fmtInt(row.clicks_count)} clicks</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/* ------------------------------------------------------------ campaigns -- */

function CampaignsPanel({
  campaigns,
  actionsFor,
  onOpenDetail,
}: {
  campaigns: AdCampaignRow[] | null
  actionsFor: (row: AdCampaignRow) => React.ReactNode[]
  onOpenDetail: (id: string) => void
}) {
  if (campaigns == null) return <p className="ads-state" role="status">Loading campaigns…</p>
  if (campaigns.length === 0) {
    return <p className="ads-state">No advertising campaigns exist yet. Use “Create campaign” to launch the first one — nothing here is mocked.</p>
  }
  return (
    <ul className="ads-campaign-cards">
      {campaigns.map(row => {
        const thumb = adMediaUrl(row.creative_thumb_path ?? row.creative_path)
        return (
          <li key={row.id} className="ads-campaign-card">
            <div className="ads-campaign-top">
              <span className="ads-creative-thumb">
                {thumb
                  ? (row.creative_kind === 'video' && !row.creative_thumb_path
                      ? <video src={thumb ?? undefined} muted playsInline preload="metadata"/>
                      : <img src={thumb ?? ''} alt="" loading="lazy"/>)
                  : <i className="ads-creative-empty">no creative</i>}
              </span>
              <div className="ads-campaign-id">
                <span className={`ads-status st-${row.status}`}>{STATUS_LABELS[row.status]}</span>
                <b>{row.name}</b>
                <span className="ads-advertiser">{row.advertiser_name}</span>
              </div>
            </div>

            <div className="ads-campaign-metrics">
              <span><i>Impressions</i><b>{fmtInt(row.impressions_count)}</b></span>
              <span><i>Clicks</i><b>{fmtInt(row.clicks_count)}</b></span>
              <span><i>CTR</i><b>{ctrOf(row.clicks_count, row.impressions_count)}</b></span>
              <span><i>Budget</i><b>{row.budget != null ? `₹${row.budget.toLocaleString()} (planning)` : '—'}</b></span>
            </div>

            <div className="ads-campaign-meta">
              <span>{fmtDate(row.start_at)} → {fmtDate(row.end_at)}</span>
              <div className="college-chips">
                {row.colleges.map(chip => (
                  <span key={`${row.id}-${chip.id}`} className="college-chip static">{chip.short_name || chip.name}</span>
                ))}
              </div>
            </div>

            <div className="ads-campaign-actions">{actionsFor(row)}</div>
            <button hidden onClick={() => onOpenDetail(row.id)} aria-hidden="true"/>
          </li>
        )
      })}
    </ul>
  )
}

/* ------------------------------------------------------------- colleges -- */

function CollegesPanel() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<AdCollegeHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (query: string) => {
    setLoading(true)
    setError(null)
    try {
      setRows(await searchAdColleges(query, 30, 0))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the college directory.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load('') }, [load])

  return (
    <div className="ads-colleges">
      <label className="college-picker-search">
        <Search size={16} aria-hidden="true"/>
        <input type="search" value={q} placeholder="Search the college directory…" onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void load(q) }}/>
      </label>
      <button className="ad-secondary" onClick={() => void load(q)}>Search</button>
      {loading && <p className="ads-state" role="status">Searching…</p>}
      {error && <p className="ad-error" role="alert">{error}</p>}
      {rows != null && !loading && (
        <ul className="ads-college-list">
          {rows.map(hit => (
            <li key={hit.id}>
              <b>{hit.short_name || hit.name}</b>
              <span>{hit.name}</span>
              <span>{[hit.city, hit.state].filter(Boolean).join(', ') || '—'}</span>
              <span><i>{fmtInt(hit.member_count)} student{hit.member_count === 1 ? '' : 's'}</i>{hit.verified && <i className="college-verified">✓ verified</i>}</span>
            </li>
          ))}
          {rows.length === 0 && <li className="ads-state">No colleges match “{q}”.</li>}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- detail --- */

function CampaignDetail({
  detail,
  onClose,
  flash,
}: {
  detail: AdCampaignDetail
  onClose: () => void
  flash: (message: string) => void
}) {
  const c = detail.campaign
  const a = detail.analytics
  const [busy, setBusy] = useState<string | null>(null)

  const statusAction = async (status: CampaignStatus, label: string) => {
    setBusy(status)
    try {
      await setAdCampaignStatus(c.id, status)
      flash(`Campaign ${label.toLowerCase()}.`)
      onClose()
    } catch (err) {
      flash(err instanceof Error ? err.message : `Could not ${label.toLowerCase()} the campaign.`)
    } finally {
      setBusy(null)
    }
  }

  const creativeUrl = adMediaUrl(c.creative_path)
  const thumbUrl = adMediaUrl(c.creative_thumb_path)
  const maxDayImp = Math.max(1, ...a.by_day.map(d => d.impressions))

  return (
    <section className="ads-page">
      <header className="ads-head">
        <div>
          <p className="ad-eyebrow">CAMPAIGN DETAILS</p>
          <h2 className="ads-title">{c.name}</h2>
          <p className="ads-sub">
            <span className={`ads-status st-${c.status}`}>{STATUS_LABELS[c.status]}</span>
            {'  '}<span>{c.advertiser_name}</span>
          </p>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Back to the campaigns list">✕</button>
      </header>

      <div className="ads-detail-grid">
        <div className="ads-detail-col">
          <div className="ads-detail-block">
            <b>Creative</b>
            {creativeUrl
              ? (c.creative_kind === 'video'
                  ? <video className="ads-detail-media" src={creativeUrl} poster={thumbUrl ?? undefined} controls muted playsInline preload="metadata"/>
                  : <img className="ads-detail-media" src={thumbUrl ?? creativeUrl} alt="Creative preview"/>)
              : <p className="ads-state">No creative attached yet.</p>}
            <p className="ads-fineprint">
              {c.creative_kind} · {c.creative_mime ?? '—'} · {c.creative_size_bytes ? `${Math.round(c.creative_size_bytes / 1024)} KB` : '—'}
              {c.creative_duration_seconds ? ` · ${Number(c.creative_duration_seconds).toFixed(1)}s` : ''}
            </p>
          </div>
          <div className="ads-detail-block">
            <b>Copy</b>
            <p><i>Headline</i><br/>{c.headline}</p>
            <p><i>Description</i><br/>{c.description}</p>
            <p><i>CTA</i> {ctaLabel(c.cta)} → <span className="ad-url">{c.destination_url}</span></p>
          </div>
          <div className="ads-detail-block">
            <b>Target colleges ({detail.targets.length})</b>
            <div className="college-chips">
              {detail.targets.map((chip: AdCollegeChip) => <span key={chip.id} className="college-chip static">{chip.short_name || chip.name}</span>)}
            </div>
          </div>
          {detail.private != null && (detail.private.internal_notes || detail.private.contact_name || detail.private.contact_email || detail.private.contact_phone) && (
            <div className="ads-detail-block private">
              <b>Private bookkeeping (admin-only)</b>
              {detail.private.contact_name && <p>Contact: {detail.private.contact_name}</p>}
              {detail.private.contact_email && <p>Email: {detail.private.contact_email}</p>}
              {detail.private.contact_phone && <p>Phone: {detail.private.contact_phone}</p>}
              {detail.private.internal_notes && <p>Notes: {detail.private.internal_notes}</p>}
            </div>
          )}
        </div>

        <div className="ads-detail-col">
          <div className="ads-detail-block">
            <b>Schedule & budget</b>
            <p>Start {fmtDate(c.start_at)} → End {fmtDate(c.end_at)}</p>
            <p>Budget: {c.budget != null ? `₹${Number(c.budget).toLocaleString()}` : 'not set'} <small>(planning only — no billing)</small></p>
          </div>

          <div className="ads-detail-block">
            <b>Performance</b>
            <div className="ads-campaign-metrics">
              <span><i>Impressions</i><b>{fmtInt(a.impressions)}</b></span>
              <span><i>Clicks</i><b>{fmtInt(a.clicks)}</b></span>
              <span><i>CTR</i><b>{ctrOf(a.clicks, a.impressions)}</b></span>
            </div>
            {a.impressions === 0 && <p className="ads-state">No impressions yet — CTR stays “—” until the campaign actually serves.</p>}
          </div>

          {a.by_day.length > 0 && (
            <div className="ads-detail-block">
              <b>Impressions & clicks per day</b>
              <table className="ads-table">
                <thead><tr><th>Day</th><th>Impressions</th><th>Clicks</th></tr></thead>
                <tbody>
                  {a.by_day.map(day => (
                    <tr key={day.day}>
                      <td>{day.day}</td>
                      <td><span className="ads-bar" style={{ width: `${(day.impressions / maxDayImp) * 100}%` }} aria-hidden="true"/>{fmtInt(day.impressions)}</td>
                      <td>{fmtInt(day.clicks)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {a.by_college.length > 0 && (
            <div className="ads-detail-block">
              <b>Performance by college</b>
              <table className="ads-table">
                <thead><tr><th>College</th><th>Impressions</th><th>Clicks</th><th>CTR</th></tr></thead>
                <tbody>
                  {a.by_college.map((row, index) => (
                    <tr key={`${row.college}-${index}`}>
                      <td>{row.college}</td><td>{fmtInt(row.impressions)}</td><td>{fmtInt(row.clicks)}</td><td>{ctrOf(row.clicks, row.impressions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(detailByStatus(c.status) ?? []).length > 0 && (
            <div className="ads-detail-block">
              <b>Status actions</b>
              <div className="ads-campaign-actions">
                {detailByStatus(c.status)!.map(([status, label, klass]) => (
                  <button key={status} className={`ad-action ${klass ?? ''}`} disabled={busy !== null} onClick={() => void statusAction(status, label)}>
                    {busy === status ? '…' : label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function detailByStatus(status: CampaignStatus): Array<[CampaignStatus, string, string?]> | null {
  switch (status) {
    case 'draft': return [['scheduled', 'Schedule'], ['active', 'Publish now'], ['archived', 'Archive']]
    case 'scheduled': return [['paused', 'Pause'], ['draft', 'Back to draft'], ['archived', 'Archive']]
    case 'active': return [['paused', 'Pause'], ['completed', 'End now']]
    case 'paused': return [['active', 'Resume'], ['completed', 'End now'], ['draft', 'Back to draft'], ['archived', 'Archive']]
    case 'completed': return [['archived', 'Archive']]
    case 'archived': return null
  }
}

export default AdsAdmin
