/**
 * Web push (VAPID) plumbing for CAMPUS.
 *
 * Rules encoded here:
 *  - Browser permission is NEVER requested on page load. Subscription
 *    happens only after an explicit user gesture (profile action).
 *  - A user who denied permission is told what happened and pointed at
 *    browser settings — we never re-prompt programmatically.
 *  - Subscriptions are associated with the signed-in user server-side;
 *    logging out unsubscribes this device. Account switching can never
 *    inherit a previous account's device registration.
 *  - Missing VITE_VAPID_PUBLIC_KEY disables push entirely (honest
 *    "not configured" state, no broken UI).
 */

import { removePushSubscription, savePushSubscription } from './db'

const vapidPublicKey = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? ''

export function pushSupported(): boolean {
  return (
    vapidPublicKey !== '' &&
    typeof window !== 'undefined' &&
    'serviceWorker' in window.navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function pushConfigured(): boolean {
  return vapidPublicKey !== ''
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const norm = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(norm)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

export async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in window.navigator)) return null
  try {
    return await window.navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch {
    return null
  }
}

export function currentPermission(): NotificationPermission | 'unsupported' {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission
}

/**
 * Subscribe this browser (call from a user gesture only). Returns a
 * status string the settings sheet renders honestly:
 *   granted | denied | unsupported | no-key | error
 */
export async function enablePush(userId: string): Promise<
  'granted' | 'denied' | 'unsupported' | 'no-key' | 'error'
> {
  if (!pushConfigured()) return 'no-key'
  if (!pushSupported()) return 'unsupported'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  try {
    const registration = await getRegistration()
    if (!registration) return 'error'
    const key = urlBase64ToUint8Array(vapidPublicKey)
    const existing = await registration.pushManager.getSubscription()
    const sub =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key as unknown as BufferSource,
      }))
    const json = sub.toJSON()
    // p256dh / auth are the device's shared secrets — stored server-side
    // behind the save_push_subscription RPC, never exposed to other users.
    const p256dh = (json.keys as Record<string, string> | undefined)?.p256dh
    const auth = (json.keys as Record<string, string> | undefined)?.auth
    if (!p256dh || !auth) {
      await sub.unsubscribe()
      return 'error'
    }
    await savePushSubscription({
      endpoint: sub.endpoint,
      p256dh,
      auth,
      userAgent: window.navigator.userAgent.slice(0, 180),
    })
    setPushActiveFlag()
    void userId
    return 'granted'
  } catch {
    return 'error'
  }
}

/** Unsubscribe this browser end-to-end (browser + server row). */
export async function disablePush(): Promise<void> {
  try {
    const registration = await window.navigator.serviceWorker.getRegistration('/')
    const sub = registration ? await registration.pushManager.getSubscription() : null
    if (sub) {
      await removePushSubscription(sub.endpoint)
      await sub.unsubscribe()
    }
  } catch {
    // best-effort: the server row is cleaned up when it next fails
  } finally {
    try {
      window.localStorage.removeItem(ACTIVE_FLAG)
    } catch { /* private mode */ }
  }
}

/** One-time nudge flag: never nag a user who dismissed the offer. */
const PROMPT_FLAG = 'campus-push-prompt-dismissed'

/** Marks that THIS user turned browser push on in THIS browser. The
 * startup reconcile only acts for devices that opted in — turning the
 * preference off must not resurrect itself. */
const ACTIVE_FLAG = 'campus-push-active'

function setPushActiveFlag(): void {
  try {
    window.localStorage.setItem(ACTIVE_FLAG, '1')
  } catch { /* private mode: reconcile simply won't run */ }
}

/**
 * Self-healing subscription sync — call on every app start for a
 * signed-in user. Web-push subscriptions are perishable: browsers rotate
 * endpoints, FCM retires stale registrations, and a pushed push can end
 * up addressing a dead endpoint while the app still believes it is
 * enrolled. This repairs that silently, but only for devices that have
 * opted in (permission granted + the active flag set):
 *   - live subscription    → re-save it (server row again up to date)
 *   - missing subscription → re-subscribe once and save
 * Never prompts: if permission was revoked it does nothing.
 */
export async function reconcilePush(): Promise<
  'repaired' | 'restored' | 'unchanged' | 'inactive' | 'error'
> {
  if (!pushConfigured() || !pushSupported()) return 'inactive'
  if (currentPermission() !== 'granted') return 'inactive'
  try {
    if (window.localStorage.getItem(ACTIVE_FLAG) !== '1') return 'inactive'
  } catch {
    return 'inactive'
  }
  const registration = await getRegistration()
  if (!registration) return 'error'
  const key = urlBase64ToUint8Array(vapidPublicKey)
  try {
    let sub = await registration.pushManager.getSubscription()
    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key as unknown as BufferSource,
      })
    }
    const json = sub.toJSON()
    const keys = json.keys as Record<string, string> | undefined
    const p256dh = keys?.p256dh
    const auth = keys?.auth
    if (!p256dh || !auth) return 'error'
    await savePushSubscription({
      endpoint: sub.endpoint,
      p256dh,
      auth,
      userAgent: window.navigator.userAgent.slice(0, 180),
    })
    setPushActiveFlag()
    return 'repaired'
  } catch {
    // A dead registration that cannot re-subscribe (e.g. new permission
    // rules): leave it — the user can always re-enable from the sheet.
    return 'error'
  }
}

export function pushPromptDismissed(): boolean {
  try {
    return window.localStorage.getItem(PROMPT_FLAG) === '1'
  } catch {
    return true
  }
}

export function dismissPushPrompt(): void {
  try {
    window.localStorage.setItem(PROMPT_FLAG, '1')
  } catch {
    /* private mode: never nag means never nag */
  }
}
