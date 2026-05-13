/**
 * 4.4.25: macOS-style elastic rubber-band overscroll on a scrollable
 * element. When the user wheel/trackpad-scrolls past the end of the
 * content, the content translates outward with diminishing returns,
 * then springs back when the wheel stops.
 *
 * Why not just rely on Chromium's native bounce on macOS:
 * Chromium DOES provide a native rubber-band on macOS, but it's tied
 * to the OS's scroll-momentum system and tends to feel weak in
 * Electron — particularly for horizontal scrollers and when the
 * scroll container has custom scrollbar styling. Writing our own
 * gives identical behavior across platforms, an explicit easing curve
 * (`cubic-bezier(0.16, 1, 0.3, 1)` is the same one Apple uses for
 * spring-back in the Music app), and works the same regardless of the
 * Electron version or future Chromium changes.
 *
 * Behavior:
 *   - User scrolls past start/end → wheel.deltaY (or deltaX) is
 *     captured, the content translates by `delta * damping * (1 - r)`
 *     where r is a logarithmic resistance term (the further you push,
 *     the harder it gets, just like iOS).
 *   - Capped at ~40% of the container's relevant dimension so you
 *     can't pull the content fully off-screen.
 *   - When wheel events stop for 90ms, the content springs back to 0
 *     via a CSS transition.
 *   - If user resumes wheel scrolling within bounds (cancels the
 *     overscroll), spring-back runs immediately.
 *
 * Implementation detail:
 *   - For horizontal scrollers we transform the container itself
 *     (visually self-contained, no parent layout disruption).
 *   - For vertical scrollers we transform the container's first
 *     element child so the scroll FRAME (and scrollbar) stays put;
 *     only the content shifts. The container's `overflow: auto` and
 *     the scrollbar element are NOT affected.
 *   - Sets `overscroll-behavior: contain` programmatically so we
 *     don't double-bounce with Chromium's native effect.
 *   - On unmount, all inline styles are cleared.
 */

import { useEffect } from 'react'

interface UseElasticOverscrollOptions {
  /** Which axis to bounce on. Default: 'y'. */
  axis?: 'x' | 'y'
  /**
   * How much of each wheel delta to apply as visual translation.
   * 0 = no effect, 1 = 1:1 (very loose). Default 0.35 — feels like
   * macOS Music app's horizontal rows.
   */
  damping?: number
  /** Spring-back animation duration in ms. Default 360 (matches Music). */
  springMs?: number
  /**
   * Maximum overscroll offset in px. Default: 40% of the container's
   * relevant dimension. Lower values feel tighter; higher feels more
   * elastic.
   */
  cap?: number
}

export function useElasticOverscroll(
  ref: React.RefObject<HTMLElement | null>,
  options: UseElasticOverscrollOptions = {},
): void {
  const { axis = 'y', damping = 0.35, springMs = 360, cap } = options

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Pick the element to transform. For horizontal scroll rows, the
    // container itself is fine (a flex row of cards visually shifting
    // left/right reads correctly). For vertical, we need to transform
    // the inner content so the scrollbar / frame stays anchored.
    const target = axis === 'x'
      ? el
      : (el.firstElementChild as HTMLElement | null)
    if (!target) return

    // Disable Chromium's native bounce so we don't double up.
    const prevOverscrollBehavior = el.style.overscrollBehavior
    el.style.overscrollBehavior = 'contain'

    let overscroll = 0
    let springTimeout: ReturnType<typeof setTimeout> | null = null
    let clearTransitionTimeout: ReturnType<typeof setTimeout> | null = null

    const isAtStart = () =>
      axis === 'x' ? el.scrollLeft <= 0 : el.scrollTop <= 0
    const isAtEnd = () =>
      axis === 'x'
        ? Math.ceil(el.scrollLeft + el.clientWidth) >= el.scrollWidth
        : Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight

    const apply = (offset: number) => {
      target.style.transform =
        axis === 'x' ? `translateX(${offset}px)` : `translateY(${offset}px)`
    }

    const springBack = () => {
      springTimeout = null
      if (overscroll === 0) return
      target.style.transition = `transform ${springMs}ms cubic-bezier(0.16, 1, 0.3, 1)`
      apply(0)
      overscroll = 0
      // Clear the transition after it completes so subsequent overscroll
      // feels immediate (transform: 'none' during apply otherwise eases).
      if (clearTransitionTimeout) clearTimeout(clearTransitionTimeout)
      clearTransitionTimeout = setTimeout(() => {
        target.style.transition = ''
      }, springMs + 20)
    }

    const handleWheel = (e: WheelEvent) => {
      const delta = axis === 'x' ? e.deltaX : e.deltaY
      if (delta === 0) return

      const pushingFurtherStart = delta < 0 && isAtStart()
      const pushingFurtherEnd = delta > 0 && isAtEnd()

      if (!pushingFurtherStart && !pushingFurtherEnd) {
        // Scrolling within bounds. If overscroll is active, snap back
        // now — the user is "rescuing" the scroll.
        if (overscroll !== 0 && springTimeout === null) springBack()
        return
      }

      // We're at a boundary AND pushing further out. Eat the event and
      // apply elastic translation.
      e.preventDefault()
      target.style.transition = 'none'

      const dimension = axis === 'x' ? el.clientWidth : el.clientHeight
      const maxOver = cap ?? dimension * 0.4

      // Logarithmic resistance: the further out you push, the more of
      // each delta is absorbed. Matches iOS feel where the last 10% of
      // overscroll requires a lot more force than the first 10%.
      const resistance = Math.min(1, Math.abs(overscroll) / maxOver)
      const effectiveDelta = delta * damping * (1 - resistance * 0.7)

      overscroll -= effectiveDelta
      // Clamp to ±maxOver.
      if (overscroll > maxOver) overscroll = maxOver
      if (overscroll < -maxOver) overscroll = -maxOver
      apply(overscroll)

      // Schedule spring-back after wheel quiet period.
      if (springTimeout) clearTimeout(springTimeout)
      springTimeout = setTimeout(springBack, 90)
    }

    el.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      el.removeEventListener('wheel', handleWheel)
      if (springTimeout) clearTimeout(springTimeout)
      if (clearTransitionTimeout) clearTimeout(clearTransitionTimeout)
      target.style.transform = ''
      target.style.transition = ''
      el.style.overscrollBehavior = prevOverscrollBehavior
    }
  }, [axis, damping, springMs, cap, ref])
}
