import { useEffect } from 'react'

/**
 * Lock the page behind a fixed overlay (modal, dialog, bottom sheet) while it
 * is open — a wheel or touch drag on the dimmed backdrop must not scroll the
 * content underneath it. Every overlay in CAMPUS mounts only while open (their
 * parents render them conditionally), so locking on mount and restoring the
 * previous value on unmount is enough; no open-state prop is needed.
 *
 * Same behaviour as the original inline effect in CreateListingWizard, shared
 * so every overlay stays consistent (auth modal, comments, report dialogs,
 * the event wizard, the reel-trim sheet, and the visitor sign-up gate).
 */
export function useBodyScrollLock(): void {
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])
}
