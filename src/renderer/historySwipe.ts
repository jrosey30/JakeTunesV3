/**
 * Two-finger horizontal swipe → back / forward (2026-10-21, parity with the
 * phone's swipe-back). Pure, so the gesture rules are unit-tested; the window
 * listener lives in NavigationContext.
 *
 * DOM wheel events carry no gesture phase, so a gesture is a run of wheel
 * events with gaps under `gapMs` (the trackpad's momentum tail stays inside the
 * same gesture — it can't fire twice). A gesture navigates once, only when it
 * is clearly horizontal, quick and long enough — a slow sideways drag, any
 * vertical scroll, or a gesture that anything under the pointer consumed
 * (Cover Flow's side-scroll preventDefaults; horizontal carousels scroll) is
 * dead for its whole run. Fingers moving right (deltaX < 0 with natural
 * scrolling) = back, as in Safari.
 */

export interface SwipeSample {
  /** Event time, ms. */
  t: number
  dx: number
  dy: number
  /** Something under the pointer owns this wheel (preventDefault, or a horizontal scroller). */
  consumed: boolean
}

export interface SwipeOptions {
  gapMs: number
  distance: number
  windowMs: number
  minEvents: number
  /** |dx| must exceed |dy| × ratio for the whole run. */
  ratio: number
}

export const SWIPE_DEFAULTS: SwipeOptions = { gapMs: 220, distance: 150, windowMs: 450, minEvents: 4, ratio: 2.5 }

export class HistorySwipeTracker {
  private start = 0
  private last = -Infinity
  private sx = 0
  private sy = 0
  private n = 0
  private done = false
  private readonly o: SwipeOptions
  constructor(o: SwipeOptions = SWIPE_DEFAULTS) { this.o = o }

  push(s: SwipeSample): 'back' | 'forward' | null {
    if (s.t - this.last > this.o.gapMs) {
      this.start = s.t; this.sx = 0; this.sy = 0; this.n = 0; this.done = false
    }
    this.last = s.t
    if (this.done) return null
    if (s.consumed) { this.done = true; return null }
    this.sx += s.dx; this.sy += s.dy; this.n++
    const ax = Math.abs(this.sx), ay = Math.abs(this.sy)
    if (ay > 12 && ay * this.o.ratio > ax) { this.done = true; return null }      // a scroll, not a swipe
    if (s.t - this.start > this.o.windowMs) { this.done = true; return null }      // a slow sideways drag
    if (this.n >= this.o.minEvents && ax >= this.o.distance) {
      this.done = true
      return this.sx < 0 ? 'back' : 'forward'
    }
    return null
  }
}

/** Mouse side buttons (DOM `button`): 3 = Back, 4 = Forward. */
export function mouseButtonNav(button: number): 'back' | 'forward' | null {
  return button === 3 ? 'back' : button === 4 ? 'forward' : null
}
