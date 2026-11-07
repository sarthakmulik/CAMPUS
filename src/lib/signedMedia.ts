/**
 * Signed-URL media presentation layer (migration 0051).
 *
 * The `media` storage bucket is private and its SELECT policy authorizes a
 * caller exactly when they may see a post that references the object. The
 * database keeps storing canonical (public-shaped) URLs in posts.media_urls —
 * only presentation changes: every renderer resolves its media through here,
 * minting a short-lived signed URL per source. The mint itself requires the
 * caller to pass the storage policy, so signing is the authorization act —
 * a resolved URL can never reach someone the post is hidden from.
 *
 * Other buckets (avatars, ad-media, chat-media, resources, communities) are
 * NOT signed here and pass straight through — this module's rewrite only
 * applies to /storage/v1/object/public/media/ sources. (Video compression and
 * the reel window live in lib/media.ts.)
 */
import { useState, useEffect } from 'react'
import { getSupabaseClient } from './db'

const MEDIA_SEGMENT = '/storage/v1/object/public/media/'
const MEDIA_TTL_S = 6 * 60 * 60            // mint for 6 h
const TTL_MARGIN_MS = 60 * 1000            // treat as stale 1 min early

type Entry = { url: string | null; exp: number; pending?: Promise<void> }

const store = new Map<string, Entry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of [...listeners]) l()
}

/** true only for canonical media-bucket sources (the ones 0051 manages). */
function isMediaBucketUrl(url: string): boolean {
  return url.includes(MEDIA_SEGMENT)
}

function objectPathOf(url: string): string | null {
  const i = url.indexOf(MEDIA_SEGMENT)
  return i < 0 ? null : url.slice(i + MEDIA_SEGMENT.length).split('?')[0]
}

/** Best-effort storage base for turning "/object/sign/..." into an absolute URL. */
function storageBaseUrl(): string {
  const sb = getSupabaseClient()
  try {
    const cfg = (sb as unknown as { supabaseUrl?: string }).supabaseUrl
    if (cfg) return `${cfg}/storage/v1`
  } catch { /* fall through to env */ }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  return `${env?.VITE_SUPABASE_URL ?? ''}/storage/v1`
}

/** Resolve one source: mint a signed URL (or cache the pass-through). */
function enqueue(source: string): void {
  const hit = store.get(source)
  if (hit) {
    if (hit.url && hit.exp > Date.now()) return
    if (hit.pending) return
  }
  const path = isMediaBucketUrl(source) ? objectPathOf(source) : null
  if (!path) {
    store.set(source, { url: source, exp: Number.MAX_SAFE_INTEGER })
    notify()
    return
  }
  const pending = (async () => {
    try {
      const sb = getSupabaseClient()
      if (!sb) { store.set(source, { url: null, exp: 0 }); return }
      const { data, error } = await sb.storage.from('media').createSignedUrl(path, MEDIA_TTL_S)
      const raw = error || !data?.signedUrl ? null : data.signedUrl
      const real = raw ? (raw.startsWith('/') ? `${storageBaseUrl()}${raw}` : raw) : null
      store.set(source, { url: real, exp: real ? Date.now() + MEDIA_TTL_S * 1000 - TTL_MARGIN_MS : 0 })
    } catch {
      store.set(source, { url: null, exp: 0 })
    } finally {
      const e = store.get(source) ?? { url: null, exp: 0 }
      store.set(source, { url: e.url, exp: e.exp, pending: undefined })
      notify()
    }
  })()
  store.set(source, { url: null, exp: 0, pending })
}

export type SignedMedia = { urls: string[]; ready: boolean; /** at least one source failed the gate */ blocked: boolean }

/**
 * Single-source variant for one-shot covers, logos and listing photos:
 * same store and gating as useSignedMedia, shaped for a lone URL.
 */
export function useSignedMediaUrl(source: string | null | undefined): { url: string | null; ready: boolean } {
  const resolved = useSignedMedia(source ? [source] : [])
  return { url: resolved.urls[0] ?? null, ready: resolved.ready }
}

/**
 * React hook: return feed-shaped media, presentation-resolved. Sources that
 * are not media-bucket URLs pass through untouched. `ready` is true once
 * every media-bucket source has a usable (or definitively denied) outcome,
 * so a renderer can hold a quiet skeleton instead of flashing a broken image.
 */
export function useSignedMedia(urls: string[] | null | undefined): SignedMedia {
  const list = urls?.filter(Boolean) ?? []
  const needsSigning = list.some(isMediaBucketUrl)
  const key = needsSigning ? list.join('|') : ''
  const [, bump] = useState(0)

  useEffect(() => {
    if (!needsSigning) return
    const rerender = (): void => { bump(v => v + 1) }
    listeners.add(rerender)
    for (const u of list) if (isMediaBucketUrl(u)) enqueue(u)
    return () => { listeners.delete(rerender) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-kick when the source list content changes
  }, [needsSigning, key])

  if (!list.length) return { urls: list, ready: true, blocked: false }
  const missing = list.some(u => isMediaBucketUrl(u) && !store.get(u)?.url)
  const blocked = list.some(u => {
    const e = store.get(u)
    return isMediaBucketUrl(u) && e && e.exp <= Date.now() && !e.pending
  })
  return {
    urls: list.map(u => {
      const e = store.get(u)
      return isMediaBucketUrl(u) && e?.url ? e.url : u
    }),
    ready: !missing,
    blocked,
  }
}
