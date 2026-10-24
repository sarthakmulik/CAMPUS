import { supabase, isSupabaseConfigured } from './supabase'
import { friendlyMessage } from './db'

/**
 * CAMPUS Advertising client (`ads.ts`).
 *
 * Everything sensitive lives in the database (migrations 0035/0036):
 * admin authorization, college targeting, lifecycle, eligibility, dedupe.
 * This module is only a thin typed wrapper plus the media helpers the DB
 * cannot do — XHR upload with real progress/cancel and a video thumbnail
 * captured in the browser.
 */

/* ------------------------------------------------------------------ types -- */

export type CtaKey =
  | 'learn_more'
  | 'visit_website'
  | 'get_directions'
  | 'view_offer'
  | 'register_now'
  | 'explore_event'

export const CTA_LABELS: Record<CtaKey, string> = {
  learn_more: 'Learn more',
  visit_website: 'Visit website',
  get_directions: 'Get directions',
  view_offer: 'View offer',
  register_now: 'Register now',
  explore_event: 'Explore event',
}

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'active'
  | 'paused'
  | 'completed'
  | 'archived'

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
}

/** Ad as served to a feed viewer (public-safe columns only). */
export type SponsoredAd = {
  id: string
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

export type AdCollegeChip = {
  id: string
  name: string
  short_name: string | null
  city?: string | null
  state?: string | null
}

/** Campaign row for the management list (admin-only RPC). */
export type AdCampaignRow = {
  id: string
  name: string
  advertiser_name: string
  advertiser_logo_url: string | null
  headline: string
  status: CampaignStatus
  creative_kind: 'image' | 'video' | null
  creative_mime: string | null
  creative_path: string | null
  creative_thumb_path: string | null
  creative_duration_seconds: number | null
  start_at: string
  end_at: string
  budget: number | null
  impressions_count: number
  clicks_count: number
  colleges: AdCollegeChip[]
  has_private_notes: boolean
  created_by_name: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

/** Full detail for edit/analytics (admin-only RPC). */
export type AdCampaignDetail = {
  campaign: Record<string, unknown> & {
    id: string
    name: string
    advertiser_name: string
    advertiser_logo_url: string | null
    headline: string
    description: string
    cta: CtaKey
    destination_url: string
    creative_kind: 'image' | 'video' | null
    creative_path: string | null
    creative_thumb_path: string | null
    creative_mime: string | null
    creative_size_bytes: number | null
    creative_duration_seconds: number | null
    status: CampaignStatus
    start_at: string
    end_at: string
    budget: number | null
    created_at: string
    updated_at: string
  }
  targets: AdCollegeChip[]
  private: {
    contact_name?: string | null
    contact_email?: string | null
    contact_phone?: string | null
    internal_notes?: string | null
  } | null
  analytics: AdAnalytics
}

export type AdAnalytics = {
  impressions: number
  clicks: number
  ctr: number
  by_day: Array<{ day: string; impressions: number; clicks: number }>
  by_college: Array<{ college: string; impressions: number; clicks: number; ctr: number }>
}

export type AdOverview = {
  total: number
  draft: number
  scheduled: number
  active: number
  paused: number
  completed: number
  archived: number
  impressions: number
  clicks: number
  ctr: number
  ending_soon: number
}

export type AdCollegeHit = {
  id: string
  name: string
  short_name: string | null
  city: string | null
  state: string | null
  verified: boolean
  member_count: number
}

/* --------------------------------------------------------------- helpers -- */

const SITE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? ''

/** Public URL of a file stored in the `ad-media` bucket. */
export function adMediaUrl(path: string | null | undefined): string | null {
  if (!path || !SITE_URL) return null
  return `${SITE_URL}/storage/v1/object/public/ad-media/${path}`
}

async function rpc<T>(name: string, args: Record<string, unknown>, fallbackError: string): Promise<T> {
  if (!supabase) throw new Error('CAMPUS is not connected. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.')
  const { data, error } = (await supabase.rpc(name, args)) as { data: unknown; error: { message: string } | null }
  if (error) throw new Error(friendlyMessage(error) || fallbackError)
  return data as T
}

/* ================================================================ DELIVERY */

/** Ads currently serving for THIS signed-in viewer (server enforces targeting). */
export async function fetchSponsoredAds(limit = 2): Promise<SponsoredAd[]> {
  if (!supabase) return []
  const rows = await rpc<Array<Record<string, unknown>>>('serve_sponsored_ads', { p_limit: limit }, 'Could not load sponsored posts.')
  return (rows ?? []).map(row => ({
    id: String(row.id),
    advertiser_name: String(row.advertiser_name),
    advertiser_logo_url: (row.advertiser_logo_url as string | null) ?? null,
    headline: String(row.headline),
    description: String(row.description),
    cta: row.cta as CtaKey,
    destination_url: String(row.destination_url),
    creative_kind: row.creative_kind as 'image' | 'video',
    creative_url: adMediaUrl(row.creative_path as string) ?? '',
    creative_mime: (row.creative_mime as string | null) ?? null,
    creative_thumb_url: adMediaUrl(row.creative_thumb_path as string),
    creative_duration_seconds: (row.creative_duration_seconds as number | null) ?? null,
  }))
}

/** One idempotent impression per display instance (server dedupes + validates). */
export async function recordAdImpression(campaignId: string, displayId: string): Promise<void> {
  try {
    await rpc<boolean>('record_sponsored_impression', { p_campaign: campaignId, p_display: displayId }, '')
  } catch {
    /* analytics must never disturb the feed */
  }
}

/**
 * Click recording — the CTA opens in a new tab, so this page survives and a
 * plain (non-keepalive) request is reliable. Fire-and-forget: navigation
 * must never wait on analytics.
 */
export async function recordAdClick(campaignId: string, displayId: string): Promise<void> {
  try {
    await rpc<boolean>('record_sponsored_click', { p_campaign: campaignId, p_display: displayId }, '')
  } catch {
    /* ignore */
  }
}

/* =================================================================== ADMIN */

export async function fetchAdOverview(): Promise<AdOverview> {
  return rpc<AdOverview>('ad_overview_metrics', {}, 'Could not load advertising overview.')
}

export async function fetchAdCampaigns(): Promise<AdCampaignRow[]> {
  const rows = await rpc<Array<Record<string, unknown>>>('list_sponsored_campaigns_admin', {}, 'Could not load campaigns.')
  return (rows ?? []).map(row => ({
    id: String(row.id),
    name: String(row.name),
    advertiser_name: String(row.advertiser_name),
    advertiser_logo_url: (row.advertiser_logo_url as string | null) ?? null,
    headline: String(row.headline),
    status: row.status as CampaignStatus,
    creative_kind: (row.creative_kind as 'image' | 'video' | null) ?? null,
    creative_mime: (row.creative_mime as string | null) ?? null,
    creative_path: (row.creative_path as string | null) ?? null,
    creative_thumb_path: (row.creative_thumb_path as string | null) ?? null,
    creative_duration_seconds: (row.creative_duration_seconds as number | null) ?? null,
    start_at: String(row.start_at),
    end_at: String(row.end_at),
    budget: (row.budget as number | null) ?? null,
    impressions_count: Number(row.impressions_count ?? 0),
    clicks_count: Number(row.clicks_count ?? 0),
    colleges: (row.colleges as AdCollegeChip[]) ?? [],
    has_private_notes: Boolean(row.has_private_notes),
    created_by_name: (row.created_by_name as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: (row.completed_at as string | null) ?? null,
  }))
}

export async function fetchAdCampaign(id: string): Promise<AdCampaignDetail> {
  const raw = await rpc<Record<string, unknown>>('get_sponsored_campaign_admin', { p_campaign: id }, 'Could not load the campaign.')
  const campaign = (raw.campaign ?? {}) as AdCampaignDetail['campaign']
  return {
    campaign,
    targets: (raw.targets as AdCollegeChip[]) ?? [],
    private: (raw.private as AdCampaignDetail['private']) ?? null,
    analytics: (raw.analytics as AdAnalytics) ?? { impressions: 0, clicks: 0, ctr: 0, by_day: [], by_college: [] },
  }
}

export type CreateAdCampaignInput = {
  name: string
  advertiser_name: string
  headline: string
  description: string
  cta: CtaKey
  destination_url: string
  start_at: string
  end_at: string
  budget: number | null
  advertiser_logo_url: string | null
  private: { contact_name?: string; contact_email?: string; contact_phone?: string; internal_notes?: string }
  reference: string | null
}

export async function createAdCampaign(input: CreateAdCampaignInput): Promise<string> {
  return rpc<string>('create_sponsored_campaign', {
    p_name: input.name,
    p_advertiser_name: input.advertiser_name,
    p_headline: input.headline,
    p_description: input.description,
    p_cta: input.cta,
    p_destination_url: input.destination_url,
    p_start_at: input.start_at,
    p_end_at: input.end_at,
    p_budget: input.budget,
    p_advertiser_logo_url: input.advertiser_logo_url,
    p_private: input.private,
    p_reference: input.reference,
  }, 'Could not create the campaign.')
}

/** Replace the whole target set. Empty array is rejected SERVER-SIDE. */
export async function setAdCampaignTargets(campaignId: string, collegeIds: string[]): Promise<void> {
  await rpc<void>('set_sponsored_campaign_targets', { p_campaign: campaignId, p_colleges: collegeIds }, 'Could not save targeting.')
}

export type AttachCreativeInput = {
  campaignId: string
  kind: 'image' | 'video'
  mime: string
  path: string
  sizeBytes: number
  durationSeconds?: number | null
  thumbPath?: string | null
}

export async function attachAdCreative(input: AttachCreativeInput): Promise<void> {
  await rpc<void>('attach_sponsored_creative', {
    p_campaign: input.campaignId,
    p_kind: input.kind,
    p_mime: input.mime,
    p_path: input.path,
    p_size_bytes: input.sizeBytes,
    p_duration_seconds: input.durationSeconds ?? null,
    p_thumb_path: input.thumbPath ?? null,
  }, 'Could not attach the creative.')
}

export async function updateAdCampaign(
  campaignId: string,
  patch: Partial<{
    name: string
    advertiser_name: string
    advertiser_logo_url: string | null
    headline: string
    description: string
    cta: CtaKey
    destination_url: string
    budget: number | null
    start_at: string
    end_at: string
    internal_notes: string | null
    contact_name: string | null
    contact_email: string | null
    contact_phone: string | null
  }>,
): Promise<void> {
  await rpc<void>('update_sponsored_campaign', { p_campaign: campaignId, p_patch: patch }, 'Could not save the campaign.')
}

export async function setAdCampaignStatus(campaignId: string, status: CampaignStatus): Promise<void> {
  await rpc<void>('set_sponsored_campaign_status', { p_campaign: campaignId, p_status: status }, 'Could not update the campaign.')
}

export async function duplicateAdCampaign(campaignId: string): Promise<string> {
  return rpc<string>('duplicate_sponsored_campaign', { p_campaign: campaignId }, 'Could not duplicate the campaign.')
}

export async function searchAdColleges(q: string, limit = 24, offset = 0): Promise<AdCollegeHit[]> {
  return rpc<AdCollegeHit[]>(
    'search_colleges_for_ads',
    { p_q: q.trim() ? q.trim() : null, p_limit: limit, p_offset: offset },
    'Could not search colleges.',
  ).then(rows => rows ?? [])
}

/* ================================================================== UPLOAD */

export type UploadHandle = {
  promise: Promise<void>
  cancel: () => void
}

/**
 * Upload an ad creative with REAL progress + cancellation (supabase-js has no
 * upload progress events, so this drives the Storage REST endpoint directly).
 * The file must target `campaigns/<campaignId>/…` — the server-side attach RPC
 * rejects paths outside the campaign's own folder, and the bucket policy only
 * lets admins write into ad-media/campaigns/*.
 */
export function uploadAdCreative(opts: {
  path: string
  file: File
  onProgress?: (percent: number) => void
}): UploadHandle {
  const xhr = new XMLHttpRequest()
  let cancelled = false

  const promise = new Promise<void>((resolve, reject) => {
    if (!supabase || !isSupabaseConfigured) {
      reject(new Error('CAMPUS is not connected. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.'))
      return
    }
    supabase.auth.getSession().then(({ data: sessionData }) => {
      const token = sessionData.session?.access_token
      if (cancelled) return
      if (!token) {
        reject(new Error('Your session expired — sign in again to upload.'))
        return
      }
      xhr.open('POST', `${SITE_URL}/storage/v1/object/ad-media/${opts.path}`, true)
      xhr.setRequestHeader('apikey', import.meta.env.VITE_SUPABASE_ANON_KEY as string)
      xhr.setRequestHeader('authorization', `Bearer ${token}`)
      xhr.setRequestHeader('cache-control', '3600')
      xhr.setRequestHeader('content-type', opts.file.type || 'application/octet-stream')
      xhr.upload.onprogress = event => {
        if (event.lengthComputable && opts.onProgress) {
          opts.onProgress(Math.round((event.loaded / event.total) * 100))
        }
      }
      xhr.onload = () => {
        if (cancelled) return
        if (xhr.status >= 200 && xhr.status < 300) {
          opts.onProgress?.(100)
          resolve()
        } else {
          let message = `Upload failed (${xhr.status}).`
          try {
            const body = JSON.parse(xhr.responseText) as { message?: string; error?: string }
            message = body.message || body.error || message
          } catch { /* keep the status-code message */ }
          reject(new Error(message))
        }
      }
      xhr.onerror = () => { if (!cancelled) reject(new Error('Upload failed — check your connection and retry.')) }
      xhr.onabort = () => { if (!cancelled) reject(new Error('Upload cancelled.')) }
      xhr.send(opts.file)
    }, err => {
      reject(new Error(friendlyMessage(err)))
    })
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
      if (xhr.readyState !== 0 && xhr.readyState !== 4) xhr.abort()
    },
  }
}

/* ================================================================== THUMBS */

/**
 * Capture a poster frame from a local video file (client-side, canvas-based).
 * Returns null quietly — the UI falls back to a <video> element preview.
 */
export async function captureVideoThumbnail(file: File): Promise<File | null> {
  try {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    try {
      video.preload = 'metadata'
      video.muted = true
      video.src = url
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('timeout')), 15_000)
        video.onloadedmetadata = () => { window.clearTimeout(timer); resolve() }
        video.onerror = () => { window.clearTimeout(timer); reject(new Error('decode')) }
      })
      await new Promise<void>(resolve => {
        video.onseeked = () => resolve()
        video.currentTime = Math.min(Math.max(video.duration * 0.15, 0.2), 4)
      })

      const scale = Math.min(1, 720 / Math.max(video.videoWidth || 720, 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round((video.videoWidth || 720) * scale)
      canvas.height = Math.round((video.videoHeight || 1280) * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.82))
      if (!blob) return null
      return new File([blob], 'thumb.webp', { type: 'image/webp' })
    } finally {
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
    }
  } catch {
    return null
  }
}
