/**
 * "Get the native app" prompt for mobile browsers.
 *
 * The web app invites phone visitors to install the Capacitor Android/iOS
 * app. Desktop browsers (Windows/macOS/Linux) are never prompted — a download
 * card there is pure annoyance. The prompt is also suppressed inside the
 * native app itself (the user already has it) and until a real download URL
 * is configured for the detected platform, so a visitor is never sent to a
 * dead store link.
 *
 * Activation: Android ships with a default link to the signed APK on GitHub
 * Releases (no Play Store listing yet); set VITE_ANDROID_APP_URL to override it
 * (e.g. a Play Store URL once published). iOS has no default — set
 * VITE_IOS_APP_URL (App Store) to enable it. With no URL for a platform the
 * prompt simply does not appear on that platform.
 */

export type MobilePlatform = 'ios' | 'android'

/** Stable permalink to the latest signed Android APK on GitHub Releases.
 *  `releases/latest/download/<asset>` always resolves to the newest release,
 *  so this stays correct as new versions are published. */
const DEFAULT_ANDROID_APP_URL = 'https://github.com/sarthakmulik/CAMPUS/releases/latest/download/CAMPUS.apk'

/**
 * Classify the visitor's device from the browser, not the viewport — a narrow
 * desktop window is still a desktop. Returns null for anything that is not a
 * phone/tablet, which is the signal to stay silent.
 */
export function detectMobilePlatform(): MobilePlatform | null {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent
  if (/android/i.test(ua)) return 'android'
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios'
  // iPadOS 13+ Safari masquerades as macOS; touch points give it away. A real
  // Mac has none, so this never catches a desktop.
  if (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return 'ios'
  return null
}

/** The configured https download link for a platform, or null when unset.
 *  Only https is accepted — a misconfigured javascript:/data: value is ignored
 *  rather than rendered into a clickable link. */
export function appDownloadUrl(platform: MobilePlatform): string | null {
  const raw = (platform === 'ios'
    ? import.meta.env.VITE_IOS_APP_URL
    : (import.meta.env.VITE_ANDROID_APP_URL || DEFAULT_ANDROID_APP_URL)) as string | undefined
  const trimmed = raw?.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/* ---- dismissal memory -------------------------------------------------- */

const DISMISS_KEY = 'campus-app-dl-dismissed-at'
/** After a dismiss, stay quiet for this long before offering again. */
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

export function appPromptDismissed(): boolean {
  try {
    const at = Number(window.localStorage.getItem(DISMISS_KEY))
    if (!Number.isFinite(at) || at <= 0) return false
    return Date.now() - at < COOLDOWN_MS
  } catch {
    return true // private mode: never nag means never nag
  }
}

export function dismissAppPrompt(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    /* private mode: the in-memory state still hides it for this visit */
  }
}