import { useCallback, useEffect, useState } from 'react'
import {
  Archive, ArrowLeft, BadgeCheck, Bookmark, BookmarkCheck, Building2, Check,
  ChevronLeft, ChevronRight, Clock, Flag, Loader2, MapPin, Package, Pencil,
  RefreshCcw, RotateCcw, Share2, ShieldAlert, Trash2, X,
} from 'lucide-react'
import * as mk from '../lib/marketplace'
import * as db from '../lib/db'

type Identity = { id: string; name: string; username: string; initials: string }

type Props = {
  identity: Identity | null
  configured: boolean
  slug: string
  colleges: db.College[]
  myCollegeId: string | null
  requireAuth: (reason: string, returnTo?: string) => boolean
  notify: (message: string) => void
  onBack: () => void
  onContactSeller: (sellerId: string, listingTitle: string) => void
  onOpenProfile: (profileId: string) => void
  onEdit: (listing: mk.ListingDetail) => void
  onChanged: () => void
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export default function ListingDetail({
  slug, requireAuth, notify,
  onBack, onContactSeller, onOpenProfile, onEdit, onChanged,
}: Props) {
  const [row, setRow] = useState<mk.ListingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [photo, setPhoto] = useState(0)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState<string>(mk.REPORT_REASONS[0])
  const [reportDetails, setReportDetails] = useState('')
  const [reporting, setReporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const detail = await mk.listingDetail(slug)
      setRow(detail)
      setPhoto(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This listing could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [slug])

  useEffect(() => { void load() }, [load])

  const toggleSave = async () => {
    if (!row) return
    setSaving(true)
    try {
      const saved = await mk.toggleSavedListing(row.id)
      setRow({ ...row, savedByMe: saved, savedCount: Math.max(0, row.savedCount + (saved ? 1 : -1)) })
      notify(saved ? 'Saved to your listings.' : 'Removed from saved.')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not change the saved state.')
    } finally {
      setSaving(false)
    }
  }

  const changeStatus = async (status: mk.ListingStatus) => {
    if (!row) return
    setBusy(true)
    try {
      await mk.setListingStatus(row.id, status)
      await load()
      onChanged()
      notify(`Listing ${mk.STATUS_LABELS[status].toLowerCase() === 'active' ? 'reopened' : `marked ${mk.STATUS_LABELS[status].toLowerCase()}`}.`)
    } catch (err) {
      notify(err instanceof Error ? err.message : 'That change was refused.')
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    if (!row) return
    setBusy(true)
    try {
      await mk.deleteListing(row.id)
      onChanged()
      notify('Listing deleted.')
      onBack()
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The listing could not be deleted.')
    } finally {
      setBusy(false)
      setConfirmDelete(false)
    }
  }

  const submitReport = async () => {
    if (!row) return
    setReporting(true)
    try {
      await mk.reportListing(row.id, reportReason, reportDetails || undefined)
      setReportOpen(false)
      setReportDetails('')
      notify('Report received — the CAMPUS team will review it.')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The report could not be sent.')
    } finally {
      setReporting(false)
    }
  }

  const share = async () => {
    const url = `${window.location.origin}${window.location.pathname}#m/${slug}`
    try {
      await navigator.clipboard.writeText(url)
      notify('Link copied — share it with a classmate.')
    } catch {
      notify(url)
    }
  }

  if (loading) {
    return <main className="mk-page"><div className="mk-state"><Loader2 className="spin" size={22} /> Loading listing…</div></main>
  }

  if (error) {
    return (
      <main className="mk-page">
        <button className="mk-back" onClick={onBack}><ArrowLeft size={15} /> Back to marketplace</button>
        <div className="mk-state mk-error">
          <p>{error}</p>
          <button className="primary-button small" onClick={() => void load()}>Retry</button>
        </div>
      </main>
    )
  }

  if (!row) {
    return (
      <main className="mk-page">
        <button className="mk-back" onClick={onBack}><ArrowLeft size={15} /> Back to marketplace</button>
        <div className="mk-state">
          <Package size={26} />
          <p>This listing is not available — it may have been sold, removed or deleted.</p>
        </div>
      </main>
    )
  }

  const owner = row.isMine
  const canContact = !owner && row.status === 'active'
  const price = mk.priceLine(row)
  const scopeLabel = row.audience === 'global' ? 'All colleges' : (row.collegeName ?? 'College listing')
  const mainImage = row.images[photo] ?? row.images[0]

  const statusAction = row.status === 'draft'
    ? { label: 'Publish', run: () => changeStatus('active') }
    : row.status === 'reserved'
      ? { label: 'Unreserve', run: () => changeStatus('active') }
      : row.status === 'sold'
        ? { label: 'Relist', run: () => changeStatus('active') }
        : row.status === 'archived'
          ? { label: 'Reopen', run: () => changeStatus('active') }
          : null

  return (
    <main className="mk-detail">
      <button className="mk-back" onClick={onBack}><ArrowLeft size={15} /> Back to marketplace</button>

      <div className="mk-detail-grid">
        <section className="mk-gallery" aria-label="Listing photos">
          {mainImage ? (
            <>
              <div className="mk-gallery-main">
                <img src={mainImage} alt={row.title} />
                {row.images.length > 1 && (
                  <>
                    <button aria-label="Previous photo" onClick={() => setPhoto(p => (p - 1 + row.images.length) % row.images.length)}>
                      <ChevronLeft size={18} />
                    </button>
                    <button aria-label="Next photo" onClick={() => setPhoto(p => (p + 1) % row.images.length)}>
                      <ChevronRight size={18} />
                    </button>
                  </>
                )}
              </div>
              {row.images.length > 1 && (
                <div className="mk-thumbs">
                  {row.images.map((src, i) => (
                    <button key={src + i} className={i === photo ? 'on' : ''} onClick={() => setPhoto(i)}>
                      <img src={src} alt="" />
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="mk-gallery-empty"><Package size={34} /><span>No photo uploaded</span></div>
          )}
        </section>

        <section className="mk-info">
          <div className="mk-info-head">
            <div>
              <div className="mk-chips">
                <span className={`mk-chip ${mk.STATUS_CHIP_CLASSES[row.status]}`}>{mk.STATUS_LABELS[row.status]}</span>
                <span className="mk-chip mk-chip-soft">{mk.TX_LABELS[row.transactionType]}</span>
                <span className="mk-chip mk-chip-soft">{row.category}</span>
                {row.condition && <span className="mk-chip">{mk.CONDITION_LABELS[row.condition]}</span>}
              </div>
              <h1>{row.title}</h1>
              <div className="mk-price mk-price-lg">{price}</div>
            </div>
            <button
              className={`mk-save-lg ${row.savedByMe ? 'on' : ''}`}
              onClick={toggleSave}
              disabled={saving}
              aria-label={row.savedByMe ? 'Remove from saved' : 'Save listing'}
            >
              {row.savedByMe ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
            </button>
          </div>

          <p className="mk-meta mk-meta-lg">
            <span className="mk-scope"><Building2 size={12} /> {scopeLabel}</span>
            <span className="mk-time"><Clock size={12} /> Listed {relativeTime(row.publishedAt ?? row.createdAt)}</span>
          </p>

          {(row.brand || row.model) && (
            <p className="mk-meta">
              <span>{[row.brand, row.model].filter(Boolean).join(' · ')}</span>
            </p>
          )}
          {row.quantity > 1 && <p className="mk-meta"><span>Quantity: {row.quantity}</span></p>}

          {row.moderationStatus === 'removed' && owner && (
            <div className="mk-notice mk-notice-warn">
              <ShieldAlert size={15} />
              <span><b>Removed by moderation.</b> {row.removedReason ?? ''} Only you can see this listing now.</span>
            </div>
          )}
          {row.status === 'draft' && (
            <div className="mk-notice">
              <span>Draft — only you can see this listing. Publish it from below so others can find it.</span>
            </div>
          )}
          {row.status === 'sold' && (
            <div className="mk-notice mk-notice-sold">
              <Check size={15} />
              <span>Marked as sold. The listing stays up as a record, but contact is closed.</span>
            </div>
          )}
          {row.status === 'reserved' && (
            <div className="mk-notice">
              <span>Reserved — the seller is holding this for someone right now.</span>
            </div>
          )}
          {row.status === 'archived' && (
            <div className="mk-notice">
              <span>Archived — this listing is no longer discoverable.</span>
            </div>
          )}

          <div className="mk-actions">
            {canContact && (
              <button
                className="primary-button"
                onClick={() => {
                  if (!requireAuth('contact the seller')) return
                  onContactSeller(row.ownerId, row.title)
                }}
              >
                Contact seller
              </button>
            )}
            {row.status === 'sold' && <button className="secondary-button" disabled>Item sold</button>}
            {row.status === 'archived' && <button className="secondary-button" disabled>Archived</button>}
            <button className="secondary-button" onClick={share}><Share2 size={15} /> Share</button>
            <button className="ghost-button" onClick={() => setReportOpen(true)}><Flag size={14} /> Report</button>
          </div>

          {owner && (
            <div className="mk-owner-tools">
              <h3>Manage listing</h3>
              <div className="mk-owner-actions">
                {row.status !== 'draft' && row.status !== 'archived' && (
                  <button className="secondary-button small" disabled={busy} onClick={() => onEdit(row)}>
                    <Pencil size={13} /> Edit
                  </button>
                )}
                {statusAction && (
                  <button className="secondary-button small" disabled={busy} onClick={statusAction.run}>
                    <RefreshCcw size={13} /> {statusAction.label}
                  </button>
                )}
                {row.status === 'active' && (
                  <button className="secondary-button small" disabled={busy} onClick={() => changeStatus('reserved')}>
                    <Archive size={13} /> Reserve
                  </button>
                )}
                {row.status !== 'archived' && row.moderationStatus === 'clean' && (
                  <button className="secondary-button small" disabled={busy} onClick={() => changeStatus('archived')}>
                    <Archive size={13} /> Archive
                  </button>
                )}
                {row.moderationStatus === 'clean' && (
                  confirmDelete ? (
                    <button className="danger-button small" disabled={busy} onClick={doDelete}>
                      <Trash2 size={13} /> Really delete?
                    </button>
                  ) : (
                    <button className="ghost-button small" disabled={busy} onClick={() => setConfirmDelete(true)}>
                      <Trash2 size={13} /> Delete
                    </button>
                  )
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="mk-section">
        <h2>About this listing</h2>
        <p className="mk-description">{row.description}</p>
      </section>

      <section className="mk-section">
        <h2>Seller</h2>
        <div className="mk-seller">
          <button className="mk-seller-id" onClick={() => onOpenProfile(row.ownerId)}>
            {row.ownerAvatar
              ? <img src={row.ownerAvatar} alt="" />
              : <span className="mk-avatar-fallback">{row.ownerName?.slice(0, 1) ?? '?'}</span>}
            <span>
              <b>
                {row.ownerName ?? row.ownerUsername}
                {row.ownerVerified && <BadgeCheck size={13} className="mk-verified" />}
              </b>
              <small>@{row.ownerUsername}</small>
            </span>
          </button>
          {row.ownerCollege && (
            <span className="mk-chip mk-chip-soft"><Building2 size={11} /> {row.ownerCollege}</span>
          )}
          <span className="mk-chip mk-chip-soft">{mk.HANDOVER_LABELS[row.handover]}</span>
          {row.handoverSpot && (
            <span className="mk-chip"><MapPin size={11} /> {row.handoverSpot}</span>
          )}
        </div>
        <p className="mk-honesty">
          CAMPUS connects you with the seller — it does not verify items, process payments or guarantee
          transactions. Meet in a public campus spot and inspect the item before paying.
        </p>
      </section>

      {reportOpen && (
        <div className="modal-backdrop" onClick={() => setReportOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Report listing">
            <header className="wizard-head">
              <div>
                <h2>Report this listing</h2>
                <p>Reports go to the CAMPUS moderation team.</p>
              </div>
              <button className="text-button" onClick={() => setReportOpen(false)} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="form-stack">
              <label className="form-field">
                <span>Reason</span>
                <select value={reportReason} onChange={e => setReportReason(e.target.value)}>
                  {mk.REPORT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>Details (optional)</span>
                <textarea
                  value={reportDetails}
                  onChange={e => setReportDetails(e.target.value)}
                  rows={3}
                  placeholder="Anything moderators should know…"
                />
              </label>
            </div>
            <footer className="wizard-foot">
              <button className="ghost-button" onClick={() => setReportOpen(false)}>Cancel</button>
              <button className="primary-button" disabled={reporting} onClick={() => void submitReport()}>
                {reporting ? <Loader2 className="spin" size={14} /> : <Flag size={14} />} Submit report
              </button>
            </footer>
          </div>
        </div>
      )}
    </main>
  )
}
