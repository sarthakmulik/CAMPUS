import { App as CapacitorApp } from '@capacitor/app'
import * as navHistory from '../lib/navHistory'
import { isNativeApp, publicWebOrigin } from './platform'

/**
 * Native navigation bridge — installed once from the app shell.
 *
 * Back: the web shell already owns a device-back policy (navHistory.ts:
 * every depth change pushes a snapshot entry, overlays register closers,
 * the boot entry is depth 0). The Android hardware back simply pops that
 * stack; at the root a second press within 2s exits, so a stray press
 * never closes the app unexpectedly.
 *
 * Deep links: campus://<kind>/<id> maps onto the SAME hash routes the web
 * app resolves (#p/ #u/ #chat/ #e/ #c/ #m/). The hash handlers fetch through
 * Supabase under RLS — a link identifier is never treated as authorization.
 */
let installed = false
let lastBackPress = 0

export function initNativeNavigation(onExitHint: (message: string) => void): void {
  if (!isNativeApp || installed) return
  installed = true

  void CapacitorApp.addListener('backButton', () => {
    const entry = navHistory.decodeState(window.history.state)
    if (entry && entry.d > 0) {
      window.history.back()
      return
    }
    const now = Date.now()
    if (now - lastBackPress < 2000) {
      void CapacitorApp.exitApp()
      return
    }
    lastBackPress = now
    onExitHint('Press back again to exit CAMPUS')
  })

  const openDeepLink = (raw: string | undefined) => {
    if (!raw) return
    const hash = deepLinkHash(raw)
    if (hash && window.location.hash !== hash) window.location.hash = hash
  }

  void CapacitorApp.addListener('appUrlOpen', ({ url }) => openDeepLink(url))
  // Cold start: Android delivers the launching intent here, not via appUrlOpen.
  void CapacitorApp.getLaunchUrl().then(launch => openDeepLink(launch?.url)).catch(() => {})
}

const ID_PATTERNS: Record<string, RegExp> = {
  post: /^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$/i,
  chat: /^[0-9a-f-]{32,36}$/i,
  profile: /^[a-z0-9_]{2,32}$/i,
  event: /^[a-z0-9-]+$/i,
  community: /^[a-z0-9-]+$/i,
  listing: /^[a-z0-9-]+$/i,
}

const HASH_PREFIX: Record<string, string> = {
  post: '#p/',
  chat: '#chat/',
  profile: '#u/',
  event: '#e/',
  community: '#c/',
  listing: '#m/',
}

function deepLinkHash(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol === 'campus:') {
      const kind = url.hostname.toLowerCase()
      const id = url.pathname.replace(/^\//, '').replace(/\/+$/, '')
      const pattern = ID_PATTERNS[kind]
      if (!pattern || !pattern.test(id)) return null
      return `${HASH_PREFIX[kind]}${id}`
    }
    // HTTPS app/universal links onto the public deployment carry the same
    // hash routes — pass the fragment through untouched.
    if (url.protocol === 'https:' && url.origin === publicWebOrigin() && url.hash) {
      return url.hash
    }
    return null
  } catch {
    return null
  }
}