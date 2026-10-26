/**
 * Persistent composer draft storage on top of IndexedDB.
 *
 * localStorage (the primary draft writer in App) can only hold strings, so
 * the attached media Files were lost on every reload — the draft came back
 * without its images/reel. Files CAN live in IndexedDB, so this tiny kv store
 * mirrors the draft INCLUDING the File objects. Everything is best-effort:
 * every surface degrades to the localStorage mirror (text + uploaded URLs),
 * so a blocked IDB (Firefox private mode) keeps publishing working, minus
 * the media re-attach convenience.
 */
import type { PostKind } from '../types'

export type ComposerDraftMeta = {
  body: string
  kind: PostKind
  source: 'home' | 'confessions'
  /** public URLs of ALREADY-UPLOADED media (partial uploads included) */
  media: string[] | null
  videoTrim: { start: number; end: number } | null
  reelDuration: number | null
  /** the exactly-once key, persisted with the draft */
  pendingId: string | null
  /**
   * true while a publish attempt is (or may still be) running — the source of
   * the "resume finish posting on boot" behaviour. Never set for polls: that
   * path has no client key, resuming it could double-post.
   */
  inFlight: boolean
}

export type ComposerDraftFile = ComposerDraftMeta & {
  files: File[]
  video: File | null
}

const DB_NAME = 'campus-drafts'
const STORE = 'drafts'
const KEY = 'composer'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          const idb = req.result
          if (!idb.objectStoreNames.contains(STORE)) idb.createObjectStore(STORE)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch { resolve(null) }
    })
  }
  return dbPromise
}

/** Write (or overwrite) the composer draft, media Files included. */
export async function saveComposerDraft(meta: ComposerDraftMeta, files: File[], video: File | null): Promise<void> {
  try {
    const idb = await openDb()
    if (!idb) return
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ ...meta, files, video }, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('aborted'))
    })
  } catch { /* drafts stay memory-only + the localStorage mirror */ }
}

/** Read the composer draft (meta + media Files), or null when absent. */
export async function loadComposerDraft(): Promise<ComposerDraftFile | null> {
  try {
    const idb = await openDb()
    if (!idb) return null
    return await new Promise(resolve => {
      const tx = idb.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve((req.result ?? null) as ComposerDraftFile | null)
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

export async function clearComposerDraft(): Promise<void> {
  try {
    const idb = await openDb()
    if (!idb) return
    await new Promise<void>(resolve => {
      const tx = idb.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch { /* nothing to clean */ }
}
