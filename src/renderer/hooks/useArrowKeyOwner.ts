/**
 * "I own ← / → while I'm on screen" (utils/arrowKeyOwner.ts — the visible
 * Cover Flow owns the arrows, the iTunes way). Registers an owner for the
 * life of the stage element; it takes keys only while at least half of the
 * stage is visible (IntersectionObserver — the Home's Cover Flow scrolled out
 * of view hands ←/→ straight back to previous / next track).
 *
 * Handlers are read through a ref, so they can close over the latest state
 * without re-registering.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { claimArrowKeys } from '../utils/arrowKeyOwner'

/** "≥ 50% of the stage visible" (half a pixel of slack for rounding). */
export const ARROW_OWNER_MIN_VISIBLE = 0.5

export function useArrowKeyOwner(
  ref: RefObject<HTMLElement>,
  handlers: { step: (delta: -1 | 1) => void; enter?: () => void },
  /** Re-register when the stage mounts (e.g. the row appears); false = no owner. */
  enabled: boolean,
): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const takesEnter = !!handlers.enter

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let visible = false
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        // Half of the stage — or, for a stage taller than the window, half
        // of the window's height of it.
        const whole = Math.min(entry.boundingClientRect.height, entry.rootBounds?.height ?? Infinity)
        visible = entry.isIntersecting && entry.intersectionRect.height >= whole * ARROW_OWNER_MIN_VISIBLE - 0.5
      }
    }, { threshold: Array.from({ length: 21 }, (_, i) => i / 20) })
    io.observe(el)
    const release = claimArrowKeys({
      isActive: () => visible && el.isConnected,
      step: (delta) => handlersRef.current.step(delta),
      ...(takesEnter ? { enter: () => handlersRef.current.enter?.() } : {}),
    })
    return () => {
      io.disconnect()
      release()
    }
  }, [ref, enabled, takesEnter])
}
