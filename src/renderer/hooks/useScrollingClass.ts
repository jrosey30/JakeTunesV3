import { useEffect, type RefObject } from 'react'

/**
 * Marks a scroller with `className` while it is scrolling (cleared `idleMs`
 * after the last scroll event), so CSS can switch hover off mid-scroll
 * (2026-10-21). With the pointer parked over the Artists grid, cards slid
 * under it every few frames and each :hover change started the card's
 * transitions (photo shadow, the play disc's opacity/transform) — compositing
 * updates over ~1,940 cards on every scrolled frame. Measured on the Artists
 * flick (off-screen, 120 Hz): 92 → 109 fps with hover off while scrolling.
 *
 * Toggles the class directly on the element: no React render per scroll.
 */
export function useScrollingClass(ref: RefObject<HTMLElement>, className = 'is-scrolling', idleMs = 150): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let timer = 0
    const onScroll = (): void => {
      if (!timer) el.classList.add(className)
      else clearTimeout(timer)
      timer = window.setTimeout(() => { timer = 0; el.classList.remove(className) }, idleMs)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (timer) clearTimeout(timer)
      el.classList.remove(className)
    }
  }, [ref, className, idleMs])
}
