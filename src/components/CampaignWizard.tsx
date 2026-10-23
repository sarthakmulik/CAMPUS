import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AdCampaignDetail, AdCollegeChip, CampaignStatus, CtaKey } from '../lib/ads'
import {
  CTA_LABELS,
  attachAdCreative,
  adMediaUrl,
  captureVideoThumbnail,
  createAdCampaign,
  setAdCampaignStatus,
  setAdCampaignTargets,
  updateAdCampaign,
  uploadAdCreative,
  type UploadHandle,
} from '../lib/ads'
import { probeVideo } from '../lib/media'
import CollegePicker from './CollegePicker'

const MAX_CREATIVE_BYTES = 25 * 1024 * 1024 // mirrors the ad-media bucket limit (25 MB)
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm'])
const STEPS = ['Details', 'Creative', 'Colleges', 'Schedule', 'Review'] as const

type Draft = {
  name: string
  advertiserName: string
  headline: string
  description: string
  cta: CtaKey
  destinationUrl: string
  logoUrl: string
  contactName: string
  contactEmail: string
  contactPhone: string
  reference: string
  budget: string
  startAt: string      // datetime-local value
  endAt: string        // datetime-local value
  publishAs: 'schedule' | 'now'
}

type PickedCreative = {
  file: File
  kind: 'image' | 'video'
  previewUrl: string
  durationSeconds: number | null
}

const EMPTY_DRAFT: Draft = {
  name: '',
  advertiserName: '',
  headline: '',
  description: '',
  cta: 'learn_more',
  destinationUrl: '',
  logoUrl: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  reference: '',
  budget: '',
  startAt: '',
  endAt: '',
  publishAs: 'schedule',
}

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function urlOk(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'https:' || url.protocol === 'http:') && /^https?:\/\/[^\s]+$/.test(value.trim())
  } catch {
    return false
  }
}

function extensionFor(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
  if (fromName && fromName.length <= 5) return fromName
  return IMAGE_TYPES.has(file.type) ? 'jpg' : 'mp4'
}

/**
 * Guided, 5-step campaign wizard (create + edit). Every step validates before
 * the user can advance; nothing is submitted until all steps pass. The
 * campaign row is created as a DRAFT first, then the creative file uploads to
 * its own folder (campaigns/<id>/…) with visible progress + cancel, then
 * targeting + status are applied — mirroring the server-side rules.
 */
export function CampaignWizard({
  mode,
  campaignId,
  initial,
  onSaved,
  onCancel,
  flash,
}: {
  mode: 'create' | 'edit'
  campaignId?: string | null
  initial?: AdCampaignDetail | null
  onSaved: (campaignId: string) => void
  onCancel: () => void
  flash?: (message: string) => void
}) {
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [targets, setTargets] = useState<AdCollegeChip[]>([])
  const [originalTargetIds, setOriginalTargetIds] = useState<string[]>([])
  const [picked, setPicked] = useState<PickedCreative | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const uploadRef = useRef<UploadHandle | null>(null)
  const stepRefs = useRef<Array<HTMLDivElement | null>>([])

  useEffect(() => {
    if (mode === 'edit' && initial) {
      const c = initial.campaign
      setDraft({
        name: c.name,
        advertiserName: c.advertiser_name,
        headline: c.headline,
        description: c.description,
        cta: c.cta,
        destinationUrl: c.destination_url,
        logoUrl: c.advertiser_logo_url ?? '',
        contactName: initial.private?.contact_name ?? '',
        contactEmail: initial.private?.contact_email ?? '',
        contactPhone: initial.private?.contact_phone ?? '',
        reference: '',
        budget: c.budget != null ? String(c.budget) : '',
        startAt: isoToLocalInput(c.start_at),
        endAt: isoToLocalInput(c.end_at),
        publishAs: 'schedule',
      })
      setTargets(initial.targets)
      setOriginalTargetIds(initial.targets.map(t => t.id))
    }
  }, [mode, initial])

  const existingCreative = initial?.campaign.creative_path
    ? {
        path: initial.campaign.creative_path,
        kind: initial.campaign.creative_kind as 'image' | 'video' | null,
        mime: initial.campaign.creative_mime,
        thumb: adMediaUrl(initial.campaign.creative_thumb_path),
        url: adMediaUrl(initial.campaign.creative_path),
        duration: initial.campaign.creative_duration_seconds,
      }
    : null

  const set = (patch: Partial<Draft>) => setDraft(prev => ({ ...prev, ...patch }))

  /* ------------------------------------------------------- step validation */

  const problems = useMemo((): string[] => {
    if (step === 0) {
      const list: string[] = []
      if (draft.name.trim().length < 3 || draft.name.trim().length > 80) list.push('Campaign name must be 3–80 characters.')
      if (draft.advertiserName.trim().length < 2) list.push('Advertiser / business name is required (2+ characters).')
      if (draft.headline.trim().length < 4 || draft.headline.trim().length > 96) list.push('Headline must be 4–96 characters.')
      if (draft.description.trim().length < 4 || draft.description.trim().length > 280) list.push('Description must be 4–280 characters.')
      if (!urlOk(draft.destinationUrl)) list.push('Destination must be a valid http(s):// URL.')
      if (draft.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.contactEmail)) list.push('Contact email looks invalid.')
      return list
    }
    if (step === 1) {
      if (picked) {
        if (picked.file.size > MAX_CREATIVE_BYTES) return ['Creative exceeds the 25 MB limit.']
        if (picked.kind === 'video' && (picked.durationSeconds ?? 0) > 30) return ['Video ads must be 30 seconds or shorter.']
        return []
      }
      if (existingCreative && mode === 'edit') return [] // keeping the current creative is valid
      return ['Choose an image (JPEG/PNG/WebP) or a video (MP4/WebM, ≤30 s, ≤25 MB).']
    }
    if (step === 2) {
      if (targets.length === 0) return ['Select at least one target college — a campaign must always define its audience.']
      return []
    }
    if (step === 3) {
      const list: string[] = []
      if (!draft.startAt || !draft.endAt) list.push('Pick both a start and an end date/time.')
      else if (new Date(draft.endAt).getTime() <= new Date(draft.startAt).getTime()) list.push('The end must be after the start.')
      if (draft.budget && (Number.isNaN(Number(draft.budget)) || Number(draft.budget) < 0)) list.push('Budget must be zero or a positive number.')
      return list
    }
    return []
  }, [step, draft, picked, existingCreative, mode, targets])

  useEffect(() => { setError(null) }, [step])

  const canNext = problems.length === 0

  /* ------------------------------------------------------------ submission */

  const doUpload = async (campaign: string, file: File): Promise<{ path: string; thumbPath: string | null }> => {
    const folder = `campaigns/${campaign}`
    const path = `${folder}/creative-${Date.now()}.${extensionFor(file)}`
    setUploading(true)
    setProgress(0)
    let thumbPath: string | null = null
    try {
      if (file.type.startsWith('video/')) {
        const thumb = await captureVideoThumbnail(file)
        if (thumb) {
          const thumbName = `${folder}/thumb-${Date.now()}.webp`
          const thumbUpload = uploadAdCreative({ path: thumbName, file: thumb })
          uploadRef.current = thumbUpload
          await thumbUpload.promise
          thumbPath = thumbName
        }
      }
      const handle = uploadAdCreative({ path, file, onProgress: setProgress })
      uploadRef.current = handle
      await handle.promise
      return { path, thumbPath }
    } finally {
      setUploading(false)
      uploadRef.current = null
    }
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const targetIds = [...new Set(targets.map(t => t.id))]

      if (mode === 'create') {
        const id = await createAdCampaign({
          name: draft.name.trim(),
          advertiser_name: draft.advertiserName.trim(),
          headline: draft.headline.trim(),
          description: draft.description.trim(),
          cta: draft.cta,
          destination_url: draft.destinationUrl.trim(),
          start_at: new Date(draft.startAt).toISOString(),
          end_at: new Date(draft.endAt).toISOString(),
          budget: draft.budget === '' ? null : Number(draft.budget),
          advertiser_logo_url: draft.logoUrl.trim() || null,
          private: {
            contact_name: draft.contactName.trim() || undefined,
            contact_email: draft.contactEmail.trim() || undefined,
            contact_phone: draft.contactPhone.trim() || undefined,
            internal_notes: undefined,
          },
          reference: draft.reference.trim() || null,
        })

        await setAdCampaignTargets(id, targetIds)
        let thumbPath: string | null = null
        if (picked) {
          const uploaded = await doUpload(id, picked.file)
          thumbPath = uploaded.thumbPath
          await attachAdCreative({
            campaignId: id,
            kind: picked.kind,
            mime: picked.file.type,
            path: uploaded.path,
            sizeBytes: picked.file.size,
            durationSeconds: picked.durationSeconds,
            thumbPath,
          })
        }
        await setAdCampaignStatus(id, draft.publishAs === 'now' ? 'active' : 'scheduled')
        return id
      }

      // edit mode: patch only what changed; server enforces pause-before-edit
      const c = initial!.campaign
      const patch: Record<string, unknown> = {}
      if (draft.name.trim() !== c.name) patch.name = draft.name.trim()
      if (draft.advertiserName.trim() !== c.advertiser_name) patch.advertiser_name = draft.advertiserName.trim()
      if (draft.headline.trim() !== c.headline) patch.headline = draft.headline.trim()
      if (draft.description.trim() !== c.description) patch.description = draft.description.trim()
      if (draft.cta !== c.cta) patch.cta = draft.cta
      if (draft.destinationUrl.trim() !== c.destination_url) patch.destination_url = draft.destinationUrl.trim()
      if ((draft.logoUrl.trim() || null) !== (c.advertiser_logo_url ?? null)) patch.advertiser_logo_url = draft.logoUrl.trim() || null
      if ((draft.budget === '' ? null : Number(draft.budget)) !== (c.budget ?? null)) patch.budget = draft.budget === '' ? null : Number(draft.budget)
      if (new Date(draft.startAt).toISOString() !== c.start_at) patch.start_at = new Date(draft.startAt).toISOString()
      if (new Date(draft.endAt).toISOString() !== c.end_at) patch.end_at = new Date(draft.endAt).toISOString()
      if (draft.contactName !== (initial!.private?.contact_name ?? '') || draft.contactEmail !== (initial!.private?.contact_email ?? '')
        || draft.contactPhone !== (initial!.private?.contact_phone ?? '')) {
        patch.contact_name = draft.contactName.trim() || null
        patch.contact_email = draft.contactEmail.trim() || null
        patch.contact_phone = draft.contactPhone.trim() || null
      }
      if (Object.keys(patch).length > 0) {
        await updateAdCampaign(c.id, patch)
      }
      const changedTargets = targetIds.length !== originalTargetIds.length
        || targetIds.some(id => !originalTargetIds.includes(id))
      if (changedTargets) {
        await setAdCampaignTargets(c.id, targetIds)
      }
      if (picked) {
        const uploaded = await doUpload(c.id, picked.file)
        await attachAdCreative({
          campaignId: c.id,
          kind: picked.kind,
          mime: picked.file.type,
          path: uploaded.path,
          sizeBytes: picked.file.size,
          durationSeconds: picked.durationSeconds,
          thumbPath: uploaded.thumbPath,
        })
      }
      return c.id
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong while saving the campaign.')
      return null
    } finally {
      setBusy(false)
    }
  }

  /* ----------------------------------------------------------- file pick -- */

  const pickFile = async (file: File | null) => {
    if (!file) return
    const isImage = IMAGE_TYPES.has(file.type)
    const isVideo = VIDEO_TYPES.has(file.type)
    if (!isImage && !isVideo) {
      setError('Upload a JPEG, PNG or WebP image, or an MP4/WebM video.')
      return
    }
    if (file.size > MAX_CREATIVE_BYTES) {
      setError('That file is larger than 25 MB — pick a smaller creative.')
      return
    }
    if (isVideo) {
      try {
        const probe = await probeVideo(file)
        if (probe.duration > 30) {
          setError(`That video is ${Math.round(probe.duration)}s — video ads must be 30 seconds or shorter.`)
          return
        }
        setPicked({ file, kind: 'video', previewUrl: URL.createObjectURL(file), durationSeconds: probe.duration })
      } catch {
        setError('CAMPUS could not read that video. MP4 and WebM work best.')
        return
      }
    } else {
      setPicked({ file, kind: 'image', previewUrl: URL.createObjectURL(file), durationSeconds: null })
    }
    setError(null)
  }

  // revoke the local preview when it changes/unmounts
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.previewUrl) }, [picked])

  /* --------------------------------------------------------------- render -- */

  const previewAd = useMemo(() => ({
    id: campaignId ?? 'preview',
    advertiser_name: draft.advertiserName.trim() || 'Advertiser',
    advertiser_logo_url: draft.logoUrl.trim() || null,
    headline: draft.headline.trim() || 'Your headline appears here',
    description: draft.description.trim() || 'Supporting text for the campaign appears here.',
    cta: draft.cta,
    destination_url: draft.destinationUrl.trim() || 'https://example.com',
    creative_kind: (picked?.kind ?? existingCreative?.kind ?? 'image') as 'image' | 'video',
    creative_url: picked?.previewUrl ?? existingCreative?.url ?? '',
    creative_mime: picked?.file.type ?? existingCreative?.mime ?? null,
    creative_thumb_url: existingCreative?.thumb ?? null,
    creative_duration_seconds: picked?.durationSeconds ?? existingCreative?.duration ?? null,
  }), [draft, picked, existingCreative, campaignId])

  const goStep = (next: number) => {
    setStep(Math.max(0, Math.min(STEPS.length - 1, next)))
    stepRefs.current[Math.min(STEPS.length - 1, next)]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const advance = async () => {
    if (step === STEPS.length - 1) {
      const id = await submit()
      if (id) {
        flash?.(mode === 'create' ? 'Campaign created and saved.' : 'Campaign updated.')
        onSaved(id)
      }
      return
    }
    goStep(step + 1)
  }

  return (
    <div className="ad-wizard" ref={node => { stepRefs.current[4] = node }}>
      <div className="ad-wizard-head">
        <div>
          <p className="ad-eyebrow">{mode === 'create' ? 'New campaign' : 'Edit campaign'}</p>
          <h3>{STEPS[step]}</h3>
        </div>
        <button className="icon-button" aria-label="Close the campaign wizard" onClick={onCancel}><X size={20}/></button>
      </div>

      <div className="ad-wizard-steps" role="list" aria-label="Wizard progress">
        {STEPS.map((label, index) => (
          <button
            key={label}
            role="listitem"
            className={`ad-step-dot${index === step ? ' on' : index < step ? ' done' : ''}`}
            onClick={() => index < step && goStep(index)}
            disabled={index > step}
            aria-current={index === step ? 'step' : undefined}
          >
            {index + 1}. {label}
          </button>
        ))}
      </div>

      {error && <p className="ad-error" role="alert">{error}</p>}

      <div className="ad-wizard-body">
        {step === 0 && (
          <div className="ad-form">
            <label className="ad-field">
              <span>Campaign name *</span>
              <input value={draft.name} onChange={e => set({ name: e.target.value })} maxLength={80} placeholder="e.g. Café Aroma launch week"/>
            </label>
            <label className="ad-field">
              <span>Advertiser / business name *</span>
              <input value={draft.advertiserName} onChange={e => set({ advertiserName: e.target.value })} maxLength={80} placeholder="e.g. Café Aroma Pune"/>
              <small>The business shown on the ad — does not need a CAMPUS account.</small>
            </label>
            <label className="ad-field">
              <span>Headline *</span>
              <input value={draft.headline} onChange={e => set({ headline: e.target.value })} maxLength={96} placeholder="e.g. Student combo: chai + sandwich at ₹99"/>
            </label>
            <label className="ad-field">
              <span>Description *</span>
              <textarea value={draft.description} onChange={e => set({ description: e.target.value })} maxLength={280} rows={3} placeholder="Supporting text shown under the creative (≤280 characters)"/>
            </label>
            <div className="ad-field-pair">
              <label className="ad-field">
                <span>Call to action *</span>
                <select value={draft.cta} onChange={e => set({ cta: e.target.value as CtaKey })}>
                  {(Object.keys(CTA_LABELS) as CtaKey[]).map(key => <option key={key} value={key}>{CTA_LABELS[key]}</option>)}
                </select>
              </label>
              <label className="ad-field">
                <span>Destination URL *</span>
                <input value={draft.destinationUrl} onChange={e => set({ destinationUrl: e.target.value })} inputMode="url" placeholder="https://…"/>
              </label>
            </div>
            <label className="ad-field">
              <span>Advertiser logo URL (optional)</span>
              <input value={draft.logoUrl} onChange={e => set({ logoUrl: e.target.value })} inputMode="url" placeholder="https://…/logo.png"/>
            </label>
            <details className="ad-private-note">
              <summary>Internal bookkeeping (admins only)</summary>
              <div className="ad-field-pair">
                <label className="ad-field">
                  <span>Contact person</span>
                  <input value={draft.contactName} onChange={e => set({ contactName: e.target.value })}/>
                </label>
                <label className="ad-field">
                  <span>Contact email</span>
                  <input value={draft.contactEmail} onChange={e => set({ contactEmail: e.target.value })} inputMode="email"/>
                </label>
              </div>
              <div className="ad-field-pair">
                <label className="ad-field">
                  <span>Contact phone</span>
                  <input value={draft.contactPhone} onChange={e => set({ contactPhone: e.target.value })} inputMode="tel"/>
                </label>
                <label className="ad-field">
                  <span>Reference (stored with notes)</span>
                  <input value={draft.reference} onChange={e => set({ reference: e.target.value })}/>
                </label>
              </div>
            </details>
          </div>
        )}

        {step === 1 && (
          <div className="ad-form">
            <label className="ad-field ad-filedrop">
              <span>Choose creative (image or video) *</span>
              <input
                type="file"
                accept={isSupabaseAccept}
                onChange={e => void pickFile(e.target.files?.[0] ?? null)}
                disabled={uploading}
              />
              <small>JPEG / PNG / WebP, or MP4 / WebM ≤ 30 s · max 25 MB — validated here and again server-side.</small>
            </label>
            {picked && (
              <button type="button" className={`ad-creative-choice${picked.kind === 'video' ? ' video' : ''}`}>
                {picked.kind === 'image'
                  ? <img src={picked.previewUrl} alt="Selected creative preview"/>
                  : <video src={picked.previewUrl} controls muted playsInline preload="metadata"/>}
                <i onClick={() => setPicked(null)} className="ad-creative-remove" role="button" aria-label="Remove the chosen creative">✕</i>
              </button>
            )}
            {!picked && existingCreative && (
              <div className="ad-creative-choice existing">
                {existingCreative.kind === 'video'
                  ? <video src={existingCreative.url ?? ''} poster={existingCreative.thumb ?? undefined} controls muted playsInline preload="metadata"/>
                  : <img src={existingCreative.url ?? ''} alt="Current creative"/>}
                <small>Current published creative — choosing a new file replaces it (saved campaign requires pause-first for active ads, enforced server-side).</small>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="ad-form">
            <p className="ad-step-hint">Every campaign must target at least one college. Ads are delivered only to students whose college affiliation matches — a student at a non-targeted college, or with no college, never receives it.</p>
            <CollegePicker
              selected={targets}
              onChange={next => setTargets(next)}
              flash={flash}
            />
          </div>
        )}

        {step === 3 && (
          <div className="ad-form">
            <div className="ad-field-pair">
              <label className="ad-field">
                <span>Start *</span>
                <input type="datetime-local" value={draft.startAt} onChange={e => set({ startAt: e.target.value })}/>
              </label>
              <label className="ad-field">
                <span>End *</span>
                <input type="datetime-local" value={draft.endAt} onChange={e => set({ endAt: e.target.value })}/>
              </label>
            </div>
            <label className="ad-field">
              <span>Planning budget (₹, optional)</span>
              <input value={draft.budget} onChange={e => set({ budget: e.target.value })} inputMode="decimal" placeholder="e.g. 2500"/>
              <small>Planning note only — CAMPUS has no billing yet, so this never claims spend or revenue.</small>
            </label>
            <div className="ad-publish-choice" role="radiogroup" aria-label="Publish behaviour">
              <label className={draft.publishAs === 'schedule' ? 'on' : ''}>
                <input type="radio" name="publishAs" checked={draft.publishAs === 'schedule'} onChange={() => set({ publishAs: 'schedule' })}/>
                <b>Publish as scheduled</b>
                <small>Goes live automatically at the start time (server sweep).</small>
              </label>
              <label className={draft.publishAs === 'now' ? 'on' : ''}>
                <input type="radio" name="publishAs" checked={draft.publishAs === 'now'} onChange={() => set({ publishAs: 'now' })}/>
                <b>Publish now</b>
                <small>Becomes active immediately; still only serves inside the window.</small>
              </label>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="ad-form ad-review">
            <div className="ad-review-block">
              <b>Campaign</b>
              <p>{draft.name.trim()}</p>
            </div>
            <div className="ad-review-block">
              <b>Advertiser</b>
              <p>{draft.advertiserName.trim()}</p>
            </div>
            <div className="ad-review-block">
              <b>Call to action</b>
              <p>{CTA_LABELS[draft.cta]} → <span className="ad-url">{draft.destinationUrl.trim()}</span></p>
            </div>
            <div className="ad-review-block">
              <b>Target colleges ({targets.length})</b>
              <div className="college-chips">
                {targets.map(chip => <span key={chip.id} className="college-chip static">{chip.short_name || chip.name}</span>)}
              </div>
            </div>
            <div className="ad-review-block">
              <b>Schedule</b>
              <p>{draft.startAt.replace('T', ' ')} → {draft.endAt.replace('T', ' ')} (your local time)</p>
            </div>
            {draft.budget && (
              <div className="ad-review-block">
                <b>Planning budget</b>
                <p>₹{draft.budget} · planning note only, no billing yet</p>
              </div>
            )}
            {picked && (
              <div className="ad-review-block">
                <b>{mode === 'edit' ? 'Replacement creative' : 'Creative'}</b>
                <p className="ad-url">{picked.file.name} · {Math.round(picked.file.size / 1024)} KB{picked.durationSeconds ? ` · ${picked.durationSeconds.toFixed(1)}s` : ''}</p>
              </div>
            )}
            <div className="ad-preview-frame">
              <p className="ad-eyebrow">Mobile preview</p>
              <AdPreviewCard ad={previewAd}/>
            </div>
            <p className="ad-fineprint">On submit the campaign is created as a draft, the creative uploads to its own storage folder (you can cancel mid-upload), targeting is saved, then status is applied.</p>
          </div>
        )}
      </div>

      {(uploading) && (
        <div className="ad-upload-progress" role="status">
          <span className="bar"><i style={{ width: `${progress}%` }}/></span>
          <span>Uploading creative… {progress}%</span>
          <button
            type="button"
            onClick={() => uploadRef.current?.cancel()}
          >Cancel upload</button>
        </div>
      )}

      <div className="ad-wizard-footer">
        <button className="ad-secondary" onClick={() => goStep(step - 1)} disabled={step === 0 || busy || uploading}>
          Back
        </button>
        {problems.length > 0 && step === STEPS.length - 1
          ? null
          : <button className="ad-primary" onClick={() => void advance()} disabled={!canNext || busy || uploading}>
              {busy ? 'Saving…' : step === STEPS.length - 1 ? (mode === 'create' ? 'Create campaign' : 'Save changes') : 'Next'}
            </button>}
      </div>
    </div>
  )
}

const isSupabaseAccept = 'image/jpeg,image/png,image/webp,video/mp4,video/webm'

/* Lightweight preview card for step 5 (no observer/tracking — never records). */
function AdPreviewCard({
  ad,
}: {
  ad: {
    advertiser_name: string
    advertiser_logo_url: string | null
    headline: string
    description: string
    cta: CtaKey
    destination_url: string
    creative_kind: 'image' | 'video'
    creative_url: string
    creative_mime: string | null
    creative_thumb_url: string | null
    creative_duration_seconds: number | null
  }
}) {
  const initials = ad.advertiser_name.trim().split(/\s+/).filter(Boolean).map(part => part[0]).slice(0, 2).join('').toUpperCase() || 'SP'
  return (
    <article className="post-card ad-card preview" aria-label="Mobile preview of the sponsored card">
      <div className="post-head">
        <span className="post-author-link static">
          <span className="avatar post-avatar">
            {ad.advertiser_logo_url ? <img src={ad.advertiser_logo_url} alt=""/> : <span className="ad-initials">{initials}</span>}
          </span>
          <span className="post-id">
            <span className="post-namerow"><b>{ad.advertiser_name}</b></span>
            <span className="post-idline ad-sponsored-line"><span className="badge ad-sponsored-badge">Sponsored</span></span>
          </span>
        </span>
      </div>
      <div className="post-content">
        <p className="post-body">{ad.headline}</p>
        {ad.creative_kind === 'video'
          ? <video className="post-media ad-media" src={ad.creative_url} poster={ad.creative_thumb_url ?? undefined} controls muted playsInline preload="metadata"/>
          : ad.creative_url
            ? <img className="post-media ad-media" src={ad.creative_url} alt=""/>
            : null}
        <p className="post-body ad-desc">{ad.description}</p>
        <span className="ad-cta static">{CTA_LABELS[ad.cta]}</span>
        <p className="ad-fineprint">Sponsored by {ad.advertiser_name}</p>
      </div>
    </article>
  )
}

export type { CampaignStatus }
export default CampaignWizard
