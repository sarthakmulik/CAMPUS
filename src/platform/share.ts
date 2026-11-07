import { Share } from '@capacitor/share'
import { isNativeApp } from './platform'

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed'

/** Whether a system share sheet exists here (native apps always have one). */
export function canSystemShare(): boolean {
  return isNativeApp || typeof navigator.share === 'function'
}

/**
 * System share with graceful degradation: native share sheet inside the
 * apps, Web Share API where the browser offers it, clipboard everywhere
 * else. Cancelling a share sheet is not an error and never touches the
 * clipboard.
 */
export async function shareLink(opts: { title?: string; text?: string; url: string }): Promise<ShareOutcome> {
  if (isNativeApp) {
    try {
      await Share.share({ title: opts.title, text: opts.text, url: opts.url, dialogTitle: 'Share via…' })
      return 'shared'
    } catch (error) {
      if (isCancel(error)) return 'cancelled'
      // fall through to clipboard on a real share failure
    }
  } else if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: opts.title, text: opts.text, url: opts.url })
      return 'shared'
    } catch (error) {
      if (isCancel(error)) return 'cancelled'
    }
  }
  try {
    if (!navigator.clipboard?.writeText) return 'failed'
    await navigator.clipboard.writeText(opts.url)
    return 'copied'
  } catch {
    return 'failed'
  }
}

function isCancel(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  const message = error instanceof Error ? error.message : String(error)
  return /cancel/i.test(message)
}