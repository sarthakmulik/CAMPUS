import { useEffect, useRef } from 'react'

export type MenuDismissOptions = {
  /** close on a pointerdown outside the boundary (menus; default true) */
  outside?: boolean
  /** close on Escape (default true) */
  escape?: boolean
  /** every boundary element that counts as "inside" the menu */
  getBoundaries?: () => Array<Element | null>
  /** extra predicate for hits that must NOT close (CommunityChat selectors etc.) */
  inside?: (target: Element) => boolean
  /** called with the outside target after a real dismissal decides nothing was inside */
  onDismissed?: (target: Element) => void
}

/**
 * ONE dismiss rule for transient menus, dialogs and pickers:
 * a pointerdown anywhere outside the boundary closes it BEFORE the click
 * reaches its real target (opening another message's menu therefore needs a
 * single tap, never two), and Escape closes it. Everything stays fresh —
 * the close callback and boundaries live in refs refreshed every render —
 * so no stale closures and no listener churn while the menu is open.
 */
export function useMenuDismiss(
  open: boolean,
  close: () => void,
  getBoundaries: () => Array<Element | null>,
  opts?: MenuDismissOptions,
): void {
  const closeRef = useRef(close)
  closeRef.current = close
  const boundsRef = useRef(getBoundaries)
  boundsRef.current = getBoundaries
  const insideRef = useRef(opts?.inside)
  insideRef.current = opts?.inside
  const dismissedRef = useRef(opts?.onDismissed)
  dismissedRef.current = opts?.onDismissed

  const withOutside = opts?.outside !== false
  const withEscape = opts?.escape !== false

  useEffect(() => {
    if (!open) return
    const insideBoundary = (target: Element): boolean => {
      if (boundsRef.current().some(element => element && element.contains(target))) return true
      const predicate = insideRef.current
      return predicate ? predicate(target) : false
    }
    const onPointer = (event: PointerEvent) => {
      if (!withOutside) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (insideBoundary(target)) return
      dismissedRef.current?.(target)
      closeRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (!withEscape || event.key !== 'Escape') return
      event.stopPropagation()
      closeRef.current()
    }
    if (withOutside) document.addEventListener('pointerdown', onPointer, true)
    if (withEscape) document.addEventListener('keydown', onKey, true)
    return () => {
      if (withOutside) document.removeEventListener('pointerdown', onPointer, true)
      if (withEscape) document.removeEventListener('keydown', onKey, true)
    }
  }, [open, withOutside, withEscape])
}

/** Escape-only dismissal for modals with their own backdrop handling. */
export function useEscapeKey(open: boolean, close: () => void): void {
  useMenuDismiss(open, close, () => [], { outside: false })
}
