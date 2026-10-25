/**
 * Swipe-to-dismiss for bottom sheets (UI-3).
 *
 * The drag only engages when a touch begins on the sheet's grab zone — the
 * `.sheet-handle` or the `.sheet-heading` (title row with the close button).
 * Taps there still work: a gesture becomes a drag only after a clear
 * downward pull. While dragging, the sheet follows the finger 1:1; on
 * release it either animates out and dismisses, or springs back.
 *
 * Self-contained by design: the page swipe-nav system in App.tsx already
 * steps aside for `.overlay`/`.bottom-sheet` touches, so this module never
 * interacts with it. Listeners are passive and the grab zones carry
 * `touch-action: none` (see styles.css), so scrolling can never glitch.
 */

export type SheetDismissCleanup = () => void

const COMMIT_DISTANCE = 110   // px of downward drag that commits a dismiss
const FLICK_DISTANCE = 40     // minimum travel for a flick to commit
const FLICK_VELOCITY = 0.6    // px/ms — a deliberate downward flick
const CLOSE_ANIMATION_MS = 230

export function attachSheetDismiss(
  el: HTMLElement,
  onDismiss: () => void,
): SheetDismissCleanup {
  const grabMatches = (target: EventTarget | null): boolean =>
    target instanceof Element && !!target.closest('.sheet-handle, .sheet-heading')

  let startY: number | null = null
  let dy = 0
  let lastY = 0
  let lastT = 0
  let vel = 0
  let closeTimer: number | null = null

  const clearInline = () => {
    el.classList.remove('sheet-dragging', 'sheet-closing')
    el.closest('.overlay')?.classList.remove('overlay-fade')
    el.style.transform = ''
  }

  const onStart = (event: TouchEvent) => {
    if (closeTimer !== null) return                 // already animating out
    if (event.touches.length > 1) return
    if (!grabMatches(event.target)) return          // body touches stay free
    const touch = event.touches[0]
    startY = touch.clientY
    lastY = touch.clientY
    lastT = performance.now()
    vel = 0
    dy = 0
  }

  const onMove = (event: TouchEvent) => {
    if (startY === null || event.touches.length > 1) return
    const touch = event.touches[0]
    const raw = touch.clientY - startY
    if (raw < 0) {                                  // upward: hand off cleanly
      startY = touch.clientY
      dy = 0
      clearInline()
      return
    }
    dy = raw
    // velocity only updates on real frame-spaced samples: coalesced moves
    // that land in the same tick would invent an enormous px/ms and trigger
    // a flick-dismiss nobody made
    const now = performance.now()
    const dt = now - lastT
    if (dt >= 8) {
      vel = (touch.clientY - lastY) / dt
      lastY = touch.clientY
      lastT = now
    } else {
      lastY = touch.clientY
    }
    el.classList.add('sheet-dragging')
    el.classList.remove('sheet-closing')
    el.style.transform = `translateY(${dy}px)`
  }

  const finish = () => {
    if (startY === null) return
    const traveled = dy
    const flick = vel
    startY = null
    if (traveled > COMMIT_DISTANCE || (traveled > FLICK_DISTANCE && flick > FLICK_VELOCITY)) {
      const overlay = el.closest('.overlay')
      el.style.transform = ''
      el.classList.remove('sheet-dragging')
      el.classList.add('sheet-closing')
      overlay?.classList.add('overlay-fade')
      closeTimer = window.setTimeout(() => {
        closeTimer = null
        clearInline()
        onDismiss()
      }, CLOSE_ANIMATION_MS)
    } else {
      clearInline() // spring back
    }
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: true })
  el.addEventListener('touchend', finish, { passive: true })
  el.addEventListener('touchcancel', finish, { passive: true })

  return () => {
    if (closeTimer !== null) { window.clearTimeout(closeTimer); closeTimer = null }
    clearInline()
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', finish)
    el.removeEventListener('touchcancel', finish)
  }
}
