import { App as CapacitorApp } from '@capacitor/app'
import { isNativeApp } from './platform'

/**
 * Foreground/background signals that work on BOTH shells. iOS WKWebView does
 * not reliably fire visibilitychange when the app is backgrounded, so native
 * builds use Capacitor's appStateChange; browsers keep visibilitychange.
 * Realtime sockets die silently in the background — consumers re-read their
 * authoritative data on resume because postgres_changes never replays
 * events missed while disconnected.
 */

export function onAppResume(callback: () => void): () => void {
  if (isNativeApp) {
    const listener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) callback()
    })
    return () => { void listener.then(handle => handle.remove()) }
  }
  const onVisible = () => { if (!document.hidden) callback() }
  document.addEventListener('visibilitychange', onVisible)
  return () => document.removeEventListener('visibilitychange', onVisible)
}

export function onAppPause(callback: () => void): () => void {
  if (isNativeApp) {
    const listener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) callback()
    })
    return () => { void listener.then(handle => handle.remove()) }
  }
  const onHidden = () => { if (document.hidden) callback() }
  document.addEventListener('visibilitychange', onHidden)
  return () => document.removeEventListener('visibilitychange', onHidden)
}