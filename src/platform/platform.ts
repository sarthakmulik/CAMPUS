import { Capacitor } from '@capacitor/core'

/** True inside the Capacitor Android/iOS WebView, false in any browser. */
export const isNativeApp = Capacitor.isNativePlatform()

export const nativePlatform: 'android' | 'ios' | 'web' =
  Capacitor.getPlatform() as 'android' | 'ios' | 'web'

/**
 * Canonical PUBLIC web origin for anything that leaves the device:
 * share/copy links and auth email redirects. Native WebViews run on
 * https://localhost (Android) / capacitor://localhost (iOS), so links built
 * from window.location.origin there are dead outside the app. Set
 * VITE_PUBLIC_WEB_ORIGIN to the public deployment to pin them; on the web
 * the current origin is already correct.
 */
export function publicWebOrigin(): string {
  const configured = (import.meta.env.VITE_PUBLIC_WEB_ORIGIN as string | undefined)?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return window.location.origin
}