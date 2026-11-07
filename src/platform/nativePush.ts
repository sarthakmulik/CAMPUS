import { PushNotifications } from '@capacitor/push-notifications'
import { saveDeviceToken, removeDeviceToken } from '../lib/db'
import { isNativeApp, nativePlatform } from './platform'

/**
 * Native push — FCM for Android, plain APNs for iOS (the Capacitor 8 iOS
 * plugin emits the raw APNs device token; no Firebase on iOS). The native
 * twin of lib/webPush.ts, with the same rules:
 *  - Permission is NEVER requested on load; only from an explicit user
 *    gesture (the notification settings sheet).
 *  - A denied user is told honestly; we never re-prompt programmatically.
 *  - Tokens are bound to the signed-in user server-side; logout removes
 *    this device's row, so account switching can never inherit it.
 *  - An Android build without Firebase configuration reports "not
 *    configured" (build-time guard in registerOnce), never crashes.
 *
 * Foreground pushes are intentionally NOT displayed: the in-app realtime
 * bell already covers every event while the app is open.
 */

export type NativePushStatus = 'granted' | 'denied' | 'unsupported' | 'no-key' | 'error'

const ACTIVE_FLAG = 'campus-native-push-active'
const TOKEN_KEY = 'campus-native-push-token'
const CHANNEL_ID = 'campus_default'

let listenersInstalled = false
let pendingRegistration: ((token: string) => void) | null = null
let pendingFailure: (() => void) | null = null

function readFlag(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function writeFlag(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch { /* private mode */ }
}

export function nativePushActive(): boolean {
  return readFlag(ACTIVE_FLAG) === '1'
}

/** This device's last registered token (own-row management in the settings sheet). */
export function currentNativeToken(): string | null {
  return readFlag(TOKEN_KEY)
}

export async function nativePushPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  const result = await PushNotifications.checkPermissions()
  // Android adds 'prompt-with-rationale' — from the user's side it is a prompt
  return result.receive === 'granted' ? 'granted' : result.receive === 'denied' ? 'denied' : 'prompt'
}

/** Install once: token delivery, tap routing, Android channel. */
export function initNativePush(): void {
  if (!isNativeApp || listenersInstalled) return
  listenersInstalled = true

  if (nativePlatform === 'android') {
    void PushNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'CAMPUS notifications',
      description: 'Messages, mentions and campus activity you enabled',
      importance: 4,
      vibration: true,
      sound: 'default',
    }).catch(() => {})
  }

  void PushNotifications.addListener('registration', ({ value: token }) => {
    writeFlag(TOKEN_KEY, token)
    if (nativePushActive()) {
      void saveDeviceToken(token, nativePlatform === 'ios' ? 'ios' : 'android').catch(() => {})
    }
    pendingRegistration?.(token)
    pendingRegistration = null
    pendingFailure = null
  })

  void PushNotifications.addListener('registrationError', () => {
    pendingFailure?.()
    pendingRegistration = null
    pendingFailure = null
  })

  // Tap → the same hash routes every other entry point uses. The payload's
  // url is built server-side for the recipient only ('#c/slug', '#e/slug'…);
  // the hash handlers verify access through Supabase like any navigation.
  void PushNotifications.addListener('pushNotificationActionPerformed', action => {
    const url = (action.notification.data as { url?: string } | undefined)?.url
    if (typeof url === 'string' && url.startsWith('#')) window.location.hash = url
  })
}

/** Android's plugin hard-crashes (uncatchable IllegalStateException) when a
 *  FirebaseMessaging-backed method is called without google-services.json;
 *  the build-time flag (vite.config.ts) is the only safe signal. iOS uses
 *  plain APNs — no Firebase, no crash path, always safe to call. */
function registrationSafe(): boolean {
  return nativePlatform === 'ios' || __CAMPUS_PUSH_ANDROID__
}

function registerOnce(timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    // Never call register() on an unconfigured Android build — the native
    // exception kills the process before any JS rejection or event fires.
    if (!registrationSafe()) {
      reject(new Error('not configured'))
      return
    }
    const timer = window.setTimeout(() => {
      pendingRegistration = null
      pendingFailure = null
      reject(new Error('registration timed out'))
    }, timeoutMs)
    pendingRegistration = token => { window.clearTimeout(timer); resolve(token) }
    // registrationError on a CONFIGURED build is a provider failure (network,
    // bad key) — report 'error', not 'no-key', so the UI wording stays honest
    pendingFailure = () => { window.clearTimeout(timer); reject(new Error('registration failed')) }
    PushNotifications.register().catch(() => {
      window.clearTimeout(timer)
      pendingRegistration = null
      pendingFailure = null
      reject(new Error('registration failed'))
    })
  })
}

/** Subscribe this device (user gesture only). Same status vocabulary as webPush. */
export async function enableNativePush(): Promise<NativePushStatus> {
  if (!isNativeApp) return 'unsupported'
  initNativePush()
  try {
    let permission = await nativePushPermission()
    if (permission === 'prompt') permission = await nativePushPermissionRequest()
    if (permission !== 'granted') return 'denied'
    const token = await registerOnce()
    await saveDeviceToken(token, nativePlatform === 'ios' ? 'ios' : 'android')
    writeFlag(ACTIVE_FLAG, '1')
    return 'granted'
  } catch (error) {
    return error instanceof Error && error.message === 'not configured' ? 'no-key' : 'error'
  }
}

async function nativePushPermissionRequest(): Promise<'granted' | 'denied' | 'prompt'> {
  const result = await PushNotifications.requestPermissions()
  return result.receive === 'granted' ? 'granted' : result.receive === 'denied' ? 'denied' : 'prompt'
}

/** Unregister this device end-to-end (provider + server row + flags). */
export async function disableNativePush(): Promise<void> {
  const token = readFlag(TOKEN_KEY)
  try {
    if (token) await removeDeviceToken(token)
  } catch { /* best-effort: the server row is cleaned when delivery next fails */ }
  try {
    // unregister() touches FirebaseMessaging on Android — same crash without config
    if (registrationSafe()) await PushNotifications.unregister()
  } catch { /* not registered */ }
  writeFlag(ACTIVE_FLAG, null)
  writeFlag(TOKEN_KEY, null)
}

/** Startup self-heal: re-register only devices that explicitly opted in.
 *  Never prompts; a revoked permission simply leaves push off. */
export async function reconcileNativePush(): Promise<void> {
  if (!isNativeApp || !nativePushActive()) return
  initNativePush()
  try {
    if ((await nativePushPermission()) !== 'granted') return
    const token = await registerOnce()
    await saveDeviceToken(token, nativePlatform === 'ios' ? 'ios' : 'android')
  } catch { /* a dead registration stays off until the user re-enables */ }
}

/** Logout cleanup — called BEFORE the session ends so the RPC is still
 *  authenticated. The next account can never inherit this device. */
export async function cleanupNativePushOnLogout(): Promise<void> {
  if (!isNativeApp) return
  const token = readFlag(TOKEN_KEY)
  if (token) {
    try { await removeDeviceToken(token) } catch { /* best-effort */ }
  }
  writeFlag(ACTIVE_FLAG, null)
  writeFlag(TOKEN_KEY, null)
}