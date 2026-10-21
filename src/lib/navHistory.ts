/**
 * Browser-history integration for CAMPUS's state-driven shell.
 *
 * CAMPUS is not a router app: the shell is one component whose panes,
 * community details, direct-message threads and overlays are React state.
 * Without this module those states never touch browser history, so the
 * mobile system Back button has nothing to pop and simply exits the app.
 *
 * Policy implemented here (the "CAMPUS mobile back policy"):
 *  - Every in-app depth change (switching the active pane, opening a
 *    community detail, opening a DM thread, opening an overlay) pushes ONE
 *    history entry that carries a serialised snapshot of the shell view.
 *    Entries carry a depth counter `d` so the popstate handler can always
 *    tell Back from Forward without trusting history indices.
 *  - Tab switches INSIDE an open detail (community Feed→Chat→About…) are
 *    REPLACED in place (`replaceView`), not pushed: they are one screen.
 *    Device Back from a community therefore returns to wherever the user
 *    came from, and can never ping-pong between About and another tab.
 *  - Overlays (modals, sheets, the drawer) push their own entry tagged
 *    `overlay`. Popping such an entry runs the overlay's registered closer,
 *    so device Back closes the topmost overlay before navigating anywhere.
 *    When an overlay is closed by other means (its own ✕, or as a side
 *    effect of some action) the entry is abandoned, not popped — closing
 *    never fights an in-flight view push. The popstate handler DRAINS stale
 *    overlay entries transparently, so abandoned entries never become
 *    dead Back presses.
 *  - In-app back arrows (thread arrow, detail arrows) pop through
 *    history.back() when the top entry really is the screen they close.
 *  - The very first history entry is always a CAMPUS entry (boot replaces
 *    state), so a Back from any pushed screen always lands inside the app.
 *    Pressing Back on the boot screen legitimately leaves the app — an
 *    ordinary website cannot keep the user hostage once its stack is
 *    exhausted, and this module deliberately does not trap it.
 */

export type CampusView = {
  /** active bottom-nav pane, e.g. 'Home' | 'Chats' | 'Communities'… */
  nav: string
  /** open community detail (drives CommunityDetail mount) */
  community?: string | null
  /** current community detail tab (replaced in place, not a history step) */
  ctab?: string | null
  /** open event detail slug */
  event?: string | null
  /** open marketplace listing slug */
  listing?: string | null
  /** a direct/group conversation occupies the screen on mobile */
  dm?: { id: string } | null
}

type CampusState = {
  __campus: true
  /** depth in OUR history stack (0 = boot entry); lets popstate tell
      Back from Forward without guessing */
  d: number
  view?: CampusView
  overlay?: string
}

const KEY = '__campus'

export function decodeState(raw: unknown): CampusState | null {
  if (raw && typeof raw === 'object' && (raw as { [k: string]: unknown })[KEY] === true) {
    return raw as CampusState
  }
  return null
}

function encodeState(state: Omit<CampusState, '__campus'>): CampusState {
  return { __campus: true, ...state }
}

function normaliseView(view: CampusView): CampusView {
  const next: CampusView = { nav: view.nav }
  if (view.community) next.community = view.community
  if (view.ctab) next.ctab = view.ctab
  if (view.event) next.event = view.event
  if (view.listing) next.listing = view.listing
  if (view.dm?.id) next.dm = { id: view.dm.id }
  return next
}

/* ---- overlay registry ------------------------------------------------- */

type OverlayCloser = () => void
const overlayClosers = new Map<string, OverlayCloser>()
let overlaySeq = 0

/* ---- listener ---------------------------------------------------------- */

type Handlers = {
  /** apply a restored view snapshot (from history Back/Forward) */
  onView: (view: CampusView) => void
}

let handlers: Handlers | null = null
let installed = false
/** depth of the entry we believe we are on (our own stack) */
let myDepth = 0
/** the view the shell currently believes is the top history entry */
let lastPushedView: CampusView | null = null

function drainStaleOverlay(maxSteps = 12): boolean {
  /* The current entry is an overlay whose closer is gone (it was closed as
     a side effect). Keep popping until a live view surfaces. Bounded. */
  for (let i = 0; i < maxSteps; i++) {
    const entry = decodeState(window.history.state)
    if (!entry) return false // left our stack entirely
    if (entry.overlay && !overlayClosers.has(entry.overlay)) {
      window.history.back()
      continue
    }
    return true // a live entry is on top now; popstate will apply it
  }
  return false // pathological stack; stop consuming Back presses
}

function onPopState(event: PopStateEvent) {
  if (!handlers) return
  const entry = decodeState(event.state)
  if (!entry) return // crossing to a non-CAMPUS entry: the browser owns it
  myDepth = typeof entry.d === 'number' ? entry.d : myDepth
  if (entry.overlay) {
    // destination is an overlay entry. Forward into an open one: nothing to
    // do. A stale one (closed elsewhere) is drained silently so abandoned
    // entries never become dead Back presses.
    if (!overlayClosers.has(entry.overlay) && !drainStaleOverlay()) {
      handlers.onView(entry.view ?? { nav: 'Home' })
    }
    return
  }
  // Destination is a plain view. If an overlay is open ABOVE it, this Back
  // press means "close the overlay" — the view underneath already matches.
  // (popstate carries the DESTINATION's state, so the just-left overlay's
  // entry can never be seen here; the open-registry is the only signal.)
  if (overlayClosers.size > 0) {
    const openKeys = [...overlayClosers.keys()]
    const topKey = openKeys[openKeys.length - 1]
    const closer = overlayClosers.get(topKey)
    if (closer) {
      overlayClosers.delete(topKey)
      closer()
      return
    }
    overlayClosers.delete(topKey)
  }
  if (entry.view) {
    const view = normaliseView(entry.view)
    lastPushedView = view
    handlers?.onView(view)
    return
  }
}

/** Install the single popstate handler and stamp the boot entry. */
export function initNavHistory(view: CampusView, nextHandlers: Handlers) {
  lastPushedView = normaliseView(view)
  window.history.replaceState(encodeState({ d: 0, view: lastPushedView }), '')
  myDepth = 0
  handlers = nextHandlers
  if (!installed) {
    installed = true
    window.addEventListener('popstate', onPopState)
  }
}

/**
 * Deep links rewrite the URL hash of the CURRENT entry; keep the app's own
 * state on it instead of the shared `replaceState(null, …)` that would
 * sever the in-app history chain.
 */
export function preserveCurrentEntry() {
  const view = lastPushedView ?? { nav: 'Home' }
  window.history.replaceState(encodeState({ d: myDepth, view }), '')
}

/** Push one in-app depth change (never called from popstate paths). */
export function pushView(view: CampusView) {
  const normal = normaliseView(view)
  lastPushedView = normal
  myDepth += 1
  window.history.pushState(encodeState({ d: myDepth, view: normal }), '')
}

/** Same screen, different tab/state detail: rewrite the current entry in
 * place (no depth change, no extra Back step). */
export function replaceView(view: CampusView) {
  const normal = normaliseView(view)
  lastPushedView = normal
  window.history.replaceState(encodeState({ d: myDepth, view: normal }), '')
}

/**
 * Identity of a screen ignoring in-screen tab state (everything except
 * the community tab). Used to decide push-vs-replace.
 */
export function viewCoreKey(view: CampusView): string {
  return JSON.stringify({
    nav: view.nav,
    community: view.community ?? null,
    event: view.event ?? null,
    listing: view.listing ?? null,
    dm: view.dm?.id ?? null,
  })
}

/** The view the shell currently believes is the top history entry. */
export function currentPushedView(): CampusView | null {
  return lastPushedView
}

export function tracePushedView(view: CampusView) {
  lastPushedView = normaliseView(view)
}

/* ---- overlays ------------------------------------------------------------ */

/**
 * Register an overlay that is opening and push its history entry.
 * The closer runs when a Back press reaches this entry (or when the entry
 * is drained after the overlay was closed another way — closers are
 * unregistered then, so `closer` should simply be idempotent).
 */
export function openOverlayEntry(onBackClose: OverlayCloser): string {
  const key = `ov-${++overlaySeq}`
  overlayClosers.set(key, onBackClose)
  myDepth += 1
  window.history.pushState(encodeState({ d: myDepth, overlay: key }), '')
  return key
}

/* ---- in-app back arrows ---------------------------------------------------- */

/**
 * Back arrow for the DM thread screen: pop only when the CURRENT history
 * entry really is the thread we pushed; otherwise report failure so the
 * caller closes the thread without touching history.
 */
export function popThreadEntry(): boolean {
  const entry = decodeState(window.history.state)
  if (entry?.view?.dm?.id) {
    window.history.back()
    return true
  }
  return false
}

/** Same guarantee for detail screens (community/event/listing details). */
export function popSubviewEntry(): boolean {
  const entry = decodeState(window.history.state)
  if (entry?.view) {
    window.history.back()
    return true
  }
  return false
}

/* ---- React hook ---------------------------------------------------------- */

import { useEffect, useRef } from 'react'

/**
 * Wire an existing overlay (modal / sheet / drawer) into device Back:
 * opening pushes one history entry; pressing Back closes it via `close`.
 *
 * Closing through the overlay's own UI (or as a side effect of another
 * action) must NOT pop history — the popstate handler drains abandoned
 * entries, so neither path can fight an in-flight view push or leave a
 * dead Back step. `close` should be idempotent.
 */
export function useOverlayBackGuard(open: boolean, close: () => void) {
  const keyRef = useRef<string | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (open && keyRef.current === null) {
      keyRef.current = openOverlayEntry(() => closeRef.current())
    } else if (!open && keyRef.current !== null) {
      // closed by its own UI / a side effect: abandon the entry (drained
      // transparently on the next Back)
      overlayClosers.delete(keyRef.current)
      keyRef.current = null
    }
  }, [open])

  // unmount while open: same abandonment
  useEffect(() => () => {
    const key = keyRef.current
    if (key) {
      keyRef.current = null
      overlayClosers.delete(key)
    }
  }, [])
}
