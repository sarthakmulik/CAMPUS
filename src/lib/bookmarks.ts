import { useSyncExternalStore } from 'react'
import { supabase } from './supabase'
import { friendlyMessage } from './db'
import { toggleSavedEvent } from './events'
import { toggleSavedListing } from './marketplace'

/**
 * Bookmarks / Saved Items — the one persisted save system.
 *
 * CAMPUS persists saves in four owner-private tables, chosen to keep the
 * existing per-surface contracts untouched:
 *
 *   post/reel   -> public.post_bookmarks   (schema.sql, PK post_id+user_id)
 *   event       -> public.saved_events     (0018, toggle_saved_event RPC)
 *   listing     -> public.saved_listings   (0019, toggle_saved_listing RPC)
 *   resource    -> public.saved_resources  (0026, toggle_saved_resource RPC)
 *
 * `savedStore` is the single client-side mirror of those rows: every save
 * surface (Home feed, Discover reels, community feed, Events, Marketplace,
 * community resources, the Bookmarks page) reads the saved flag from it and
 * toggles through it, so one tap is reflected everywhere at once. The state
 * always matches the server after a reload or account switch; nothing here
 * carries stale users' data (reset() on identity change).
 *
 * The Bookmarks page itself reads the server through list_saved_items()
 * (0026) — a visibility-checked, cursor-paginated merge of all four stores —
 * so opening the page is always a fresh, RLS-honest read.
 */

export type SavedKind = 'post' | 'reel' | 'event' | 'listing' | 'resource'

export const SAVED_KIND_LABEL: Record<SavedKind, string> = {
  post: 'Post',
  reel: 'Reel',
  event: 'Event',
  listing: 'Listing',
  resource: 'Resource',
}

/* -------------------------------------------------------------------------- */
/* Global saved-state store                                                    */
/* -------------------------------------------------------------------------- */

const keyOf = (kind: SavedKind, id: string) => `${kind}:${id}`

type StoreState = {
  /** every persisted save known to this session: key -> saved? */
  map: Map<string, boolean>
  version: number
}

let state: StoreState = { map: new Map(), version: 0 }

/** true while a toggle is in flight for a key (guards rapid double taps) */
const pending = new Map<string, boolean>()

let lastUser: string | null = null

const listeners = new Set<() => void>()

function emit() {
  state = { map: state.map, version: state.version + 1 }
  for (const listener of listeners) listener()
}

const getSnapshot = () => state.version
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Load real persisted rows for a user-specific batch (posts/reels/resources). */
export function savedStoreBindUser(userId: string | null): void {
  if (lastUser === userId) return
  // account switch or logout: the previous member's mirror must not leak
  lastUser = userId
  pending.clear()
  state = { map: new Map(), version: 0 }
  emit()
}

/**
 * Bulk-merge server truth (post_bookmarks / saved_resources batches, or the
 * saved flags the events / marketplace RPCs already return). Rows not in the
 * batch are left alone — callers hydrate only the ids they just loaded.
 */
export function savedStoreMerge(items: { kind: SavedKind; id: string; saved: boolean }[]): void {
  let changed = false
  for (const item of items) {
    const key = keyOf(item.kind, item.id)
    // a write is in flight for this key: the optimistic flip must survive
    // reads that may pre-date the write (merges confirm nothing here — the
    // toggle's own result settles the value)
    if (pending.has(key)) continue
    if (state.map.get(key) !== item.saved) {
      state.map.set(key, item.saved)
      changed = true
    }
  }
  if (changed) emit()
}

export function savedStoreSet(kind: SavedKind, id: string, saved: boolean): void {
  const key = keyOf(kind, id)
  if (state.map.get(key) === saved) return
  state.map.set(key, saved)
  emit()
}

export function isSaved(kind: SavedKind, id: string): boolean {
  return state.map.get(keyOf(kind, id)) ?? false
}

/** useSyncExternalStore-friendly flag hook (never re-renders unrelated rows). */
export function useSavedFlag(kind: SavedKind, id: string): boolean {
  useSyncExternalStore(subscribe, getSnapshot)
  return isSaved(kind, id)
}

/** The Bookmarks page listens for any change and refetches its list. */
export function subscribeToStore(listener: () => void): () => void {
  return subscribe(listener)
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

/** Mark a post or reel bookmark in post_bookmarks. Idempotent both ways. */
async function persistPostBookmark(postId: string, saved: boolean): Promise<boolean> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  if (saved) {
    const { error } = await supabase
      .from('post_bookmarks')
      .upsert(
        { post_id: postId, user_id: (await supabase.auth.getUser()).data.user?.id ?? '' },
        { onConflict: 'post_id,user_id', ignoreDuplicates: true },
      )
    if (error) throw new Error(friendlyMessage(error))
    return true
  }
  const { error } = await supabase
    .from('post_bookmarks')
    .delete()
    .eq('post_id', postId)
  if (error) throw new Error(friendlyMessage(error))
  return false
}

async function persistSavedResource(resourceId: string, saved: boolean): Promise<boolean> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('toggle_saved_resource', { p_resource: resourceId, p_saved: saved })
  if (error) throw new Error(friendlyMessage(error))
  return Boolean(data)
}

/**
 * The one toggle every bookmark button goes through.
 * - optimistic: the flag flips immediately for every subscriber
 * - in-flight guard: a second tap while the row writes waits, then applies to
 *   the freshest target instead of double-firing (never a duplicate insert)
 * - rollback: a failed write returns the previous state and rethrows so the
 *   UI can show an honest error
 */
export async function toggleSaved(kind: SavedKind, id: string): Promise<boolean> {
  const key = keyOf(kind, id)

  // collapse rapid taps: if a write is already in flight, remember only the
  // newest intent — it is applied by the in-flight call after it settles
  if (pending.has(key)) {
    const queued = !isSaved(kind, id)
    pending.set(key, queued)
    return queued
  }

  const previous = isSaved(kind, id)
  const target = !previous
  pending.set(key, target)
  savedStoreSet(kind, id, target)
  try {
    let persisted: boolean
    if (kind === 'post' || kind === 'reel') persisted = await persistPostBookmark(id, target)
    else if (kind === 'resource') persisted = await persistSavedResource(id, target)
    else if (kind === 'event') persisted = await toggleSavedEvent(id, target)
    else persisted = await toggleSavedListing(id)

    // the server may disagree (its RPCs re-check ownership and eligibility)
    if (persisted !== target) savedStoreSet(kind, id, persisted)
    const queued = pending.get(key)
    pending.delete(key)
    if (queued !== undefined && queued !== isSaved(kind, id)) {
      // a second tap raced the write: run its difference once, quietly
      await toggleSaved(kind, id)
    }
    return isSaved(kind, id)
  } catch (error) {
    pending.delete(key)
    savedStoreSet(kind, id, previous) // honest rollback
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Hydration — load real saved flags into the store                            */
/* -------------------------------------------------------------------------- */

/** One batched query: which of these posts does the member have bookmarked? */
export async function hydratePostSaves(ids: string[]): Promise<Set<string>> {
  const real = ids.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id))
  if (!supabase || real.length === 0) return new Set()
  const user = (await supabase.auth.getUser()).data.user
  if (!user) return new Set()
  const { data, error } = await supabase
    .from('post_bookmarks')
    .select('post_id')
    .eq('user_id', user.id)
    .in('post_id', real)
  if (error) throw new Error(friendlyMessage(error))
  savedStoreMerge((data ?? []).map((row: { post_id: string }) => ({ kind: 'post', id: row.post_id, saved: true })))
  return new Set((data ?? []).map((row: { post_id: string }) => row.post_id))
}

/** Mark loaded post rows saved/unsaved (posts AND reels live in posts). */
export async function syncPostSaves(posts: { id: string; kind: string }[]): Promise<void> {
  if (posts.length === 0) return
  const savedIds = await hydratePostSaves(posts.map(p => p.id))
  savedStoreMerge(posts.map(p => ({
    kind: p.kind === 'reel' ? 'reel' : 'post',
    id: p.id,
    saved: savedIds.has(p.id),
  } as { kind: SavedKind; id: string; saved: boolean })))
}

/** One batched query: which community resources does the member have saved? */
export async function hydrateResourceSaves(ids: string[]): Promise<Set<string>> {
  const real = ids.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id))
  if (!supabase || real.length === 0) return new Set()
  const user = (await supabase.auth.getUser()).data.user
  if (!user) return new Set()
  const { data, error } = await supabase
    .from('saved_resources')
    .select('resource_id')
    .eq('user_id', user.id)
    .in('resource_id', real)
  // migration not applied yet: behave like "nothing saved" instead of crashing
  // a resources panel that has never supported saving
  if (error) return new Set()
  savedStoreMerge((data ?? []).map((row: { resource_id: string }) => ({ kind: 'resource', id: row.resource_id, saved: true })))
  return new Set((data ?? []).map((row: { resource_id: string }) => row.resource_id))
}

/* -------------------------------------------------------------------------- */
/* The Bookmarks page data path (list_saved_items, 0026)                       */
/* -------------------------------------------------------------------------- */

export type SavedItem = {
  kind: SavedKind
  id: string
  savedAt: string
  /** true when the row is real but its payload no longer resolves — shown with an unavailable state, never crashing the page */
  payload: Record<string, unknown> | null
}

export type SavedPage = {
  items: SavedItem[]
  /** cursor for the next page (last row), or null when the list ended */
  next: { savedAt: string; id: string } | null
}

export type SavedFilter = 'all' | SavedKind

function mapPayload(kind: SavedKind, raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  // empty object means the RPC returned a row whose content no longer resolves
  return kind === 'resource' || kind === 'event' || kind === 'listing' ? {} : { body: null }
}

export async function fetchSavedPage(
  kind: SavedFilter,
  query: string,
  before: { savedAt: string; id: string } | null,
): Promise<SavedPage> {
  if (!supabase) throw new Error('CAMPUS is not connected.')
  const { data, error } = await supabase.rpc('list_saved_items', {
    p_kind: kind,
    p_query: query.trim() || null,
    p_before: before?.savedAt ?? null,
    p_limit: 12,
    p_after_id: before?.id ?? null,
  })
  // the migration has not been applied yet — an honest, actionable message
  if (error && /Could not find the function|schema cache|PGRST202/i.test(String((error as { message?: string }).message ?? ''))) {
    throw new Error('Saved items are not enabled on the server yet. Apply supabase/migrations/0026_saved_items.sql in the Supabase SQL editor.')
  }
  if (error) throw new Error(friendlyMessage(error))

  type Row = {
    kind: SavedKind
    content_id: string
    saved_at: string
    payload: unknown
  }
  const rows = (data ?? []) as Row[]
  const items: SavedItem[] = rows.map(row => ({
    kind: row.kind,
    id: row.content_id,
    savedAt: row.saved_at,
    payload: mapPayload(row.kind, row.payload),
  }))
  const last = rows[rows.length - 1]
  return {
    items,
    next: rows.length === 12 && last
      ? { savedAt: last.saved_at, id: last.content_id }
      : null,
  }
}
