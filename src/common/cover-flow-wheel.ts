/**
 * Cover Flow by wheel (Jake, 2026-10-21: "the Cover Flow on my desktop should
 * work easily with the side scroll wheel on my mouse. Especially on my work
 * mini. Same applies for side swipe gesture on laptop MacBook").
 *
 * Turns a stream of wheel events into whole cover steps. Pure: no DOM, no
 * clock, no timers. The caller feeds every WheelEvent to push() and, when a
 * result carries `settleAt`, calls settle() at that time if no further event
 * came first (useCoverFlowWheel does this with one setTimeout).
 *
 * The inputs it has to read, all as DOM wheel events with no phase info:
 *   - a notchy wheel: one event per notch, spaced by the hand (≥ ~40 ms).
 *     Chromium on macOS gives a slow notch only ~4 px (0.1 line × 40) and an
 *     accelerated one 40 px or more, so the SIZE of a notch says nothing.
 *     What marks a notch is that it is ALONE: no other event within
 *     `notchMs` either side. A lone event is one cover, whatever its size.
 *   - smooth streams: the MacBook trackpad's two-finger swipe, Logi Options+
 *     smooth scrolling on the MX Master 3S thumb wheel, a free-spinning
 *     wheel: events every 8–17 ms with small deltas, and on the trackpad a
 *     momentum tail after the fingers lift. These accumulate: the first cover
 *     after `leadPx`, each further one after `stepPx` more.
 *   - shift + vertical wheel (macOS usually converts it to deltaX itself;
 *     when it arrives as shiftKey + deltaY with no deltaX it is read as
 *     horizontal, down = right).
 *
 * A gesture is everything up to `gestureGapMs` of quiet. Its axis is decided
 * on its FIRST event, because Chromium only lets the first wheel event of a
 * scroll sequence decide whether the rest can be cancelled. A horizontal
 * gesture is ours (consume = preventDefault, so the page never scrolls
 * sideways and Chromium never reads it as back/forward); a vertical one is the
 * page's and is never touched. A clearly-other-axis event of SWITCH_PX or
 * more hands the gesture over at once (swipe the covers, then scroll the page
 * without waiting).
 *
 * A stream push can move at most `maxSteps` covers, momentum tail included
 * (the phone's "a flick moves a few", LaunchPageG.swift `.alwaysByFew`), so a
 * hard flick never sails through all ten. A new push re-arms the cap without
 * waiting for the gesture to end: turning back, or a beat of stillness
 * (`pushGapMs`) inside the stream. A momentum tail never pauses (macOS sends
 * it every frame until it stops), but fingers put back on the pad stop the
 * tail, and the next swipe starts a beat later. Speed is NOT used to spot a
 * new swipe: event timing jitters under load (a busy frame delays events and
 * then delivers them bunched), so a speed-surge rule can mistake a flick's
 * own tail for a new swipe and let it sail on. Lone notches are not capped:
 * each one is a click the hand made.
 *
 * Direction follows the content, like every other scroller on the Mac:
 * deltaX > 0 (content scrolling toward its right end) = the next cover. With
 * macOS natural scrolling (the default) that is fingers moving LEFT, so the
 * covers slide with the fingers; whatever the user set for natural scrolling
 * or Options+ "invert" is honoured because it is already in the sign.
 */

export interface WheelSample {
  deltaX: number
  deltaY: number
  /** WheelEvent.deltaMode: 0 = px, 1 = lines, 2 = pages. */
  deltaMode: number
  shiftKey: boolean
  /** A trackpad pinch arrives as ctrl + wheel: never a cover step. */
  ctrlKey?: boolean
  metaKey?: boolean
  /** WheelEvent.timeStamp, ms. settle() takes times on this same event clock. */
  timeStamp: number
}

export interface CoverWheelOptions {
  /** 'x': only horizontal gestures step (the Home row; vertical scrolls the
   *  page). 'both': either axis steps, by whichever dominates (the library's
   *  jukebox arc flips vertically). */
  axis?: 'x' | 'both'
  /** Smooth travel to the first cover of a push, px. */
  leadPx?: number
  /** Smooth travel to each further cover, px. */
  stepPx?: number
  /** Most covers one stream push moves (Infinity = no cap). */
  maxSteps?: number
  /** Stillness inside a stream that starts a new push (re-arms the cap), ms. */
  pushGapMs?: number
  /** Quiet that ends a gesture, ms. */
  gestureGapMs?: number
  /** An event with no neighbour within this, ms, is a notch. */
  notchMs?: number
  /** Least time between two stream steps, ms (0 = none). */
  minStepGapMs?: number
  /** deltaMode 1 → px. */
  linePx?: number
  /** deltaMode 2 → px. */
  pagePx?: number
}

/** The Home page's Island Albums row (TonightOnJakeTunes). */
export const COVER_WHEEL_DEFAULTS = {
  axis: 'x' as 'x' | 'both',
  // 40 then 80: a short deliberate swipe moves one cover; over a few covers
  // that averages ~70 px each, which is also how far a side cover slides per
  // step (cover-flow.ts `step: 70`), so the row keeps pace with the fingers.
  // Not 1.6x ahead of them: the phone's 64 pt step made a 100 pt flick jump
  // No. 1 → No. 7 ("very sensitive and moves very fast", Jake 10/20).
  leadPx: 40,
  stepPx: 80,
  maxSteps: 3,
  pushGapMs: 70,
  gestureGapMs: 160,
  notchMs: 40,
  minStepGapMs: 0,
  // Chromium's px per wheel line on the Mac (kScrollbarPixelsPerCocoaTick).
  linePx: 40,
  pagePx: 800,
}

/** The library's jukebox arc (CoverFlowView): either axis, one flip per
 *  48 px as before, flips at most every 70 ms (its anti-glitch damping),
 *  and no per-push cap: a flick through hundreds of albums may run on. */
export const JUKEBOX_WHEEL_OPTIONS: CoverWheelOptions = {
  axis: 'both',
  leadPx: 48,
  stepPx: 48,
  maxSteps: Infinity,
  minStepGapMs: 70,
}

/** |a| must beat |b| by this to count as a's axis (x gesture, or a switch). */
const AXIS_RATIO = 1.5
/** The other axis must move at least this in one event to take the gesture over. */
const SWITCH_PX = 4
/** A reversal needs at least this much in one event to start a new push. */
const REARM_PX = 6
/** A lone event smaller than this is a twitch, not a notch (a slow Mac notch is ~4 px). */
const NOTCH_MIN_PX = 2

export interface WheelPushResult {
  /** Covers to move now: + next, − previous. */
  steps: number
  /** preventDefault this event (it belongs to a gesture this flow owns). */
  consume: boolean
  /** Call settle() at this time unless another event comes first. */
  settleAt: number | null
}

export interface WheelSettleResult {
  steps: number
  settleAt: number | null
}

export interface CoverWheel {
  push(sample: WheelSample): WheelPushResult
  settle(now: number): WheelSettleResult
}

interface Gesture {
  axis: 'x' | 'y'
  lastT: number
  stream: boolean
  pending: { d: number; t: number } | null
  // the current push
  acc: number
  /** Covers this push has moved (signed): its first needs leadPx, the rest stepPx. */
  net: number
  /** Covers since the cap was last armed (signed): |capNet| ≤ maxSteps. */
  capNet: number
  dir: number
  prevT: number | null
  lastStepT: number
}

const finite = (n: number): number => (Number.isFinite(n) ? n : 0)

export function createCoverWheel(options: CoverWheelOptions = {}): CoverWheel {
  const o = { ...COVER_WHEEL_DEFAULTS, ...options }
  let g: Gesture | null = null

  const newGesture = (axis: 'x' | 'y', t: number): Gesture => ({
    axis, lastT: t, stream: false, pending: null,
    acc: 0, net: 0, capNet: 0, dir: 0,
    prevT: null, lastStepT: -Infinity,
  })

  /** Turning back: travel the old way is dropped and the new way starts afresh. */
  const reverse = (s: Gesture, dir: number): void => {
    s.acc = 0
    s.net = 0
    s.capNet = 0
    s.dir = dir
  }

  /** A lone event: one cover its way (none for a twitch). */
  const resolveNotch = (s: Gesture): number => {
    const p = s.pending
    s.pending = null
    if (!p || Math.abs(p.d) < NOTCH_MIN_PX) return 0
    return Math.sign(p.d)
  }

  /** One stream delta into the current push; returns the covers it completes. */
  const feed = (s: Gesture, d: number, t: number): number => {
    const sign = Math.sign(d)
    if (sign !== 0 && s.dir !== 0 && sign !== s.dir && Math.abs(d) >= REARM_PX) reverse(s, sign)
    else if (s.prevT !== null && t - s.prevT >= o.pushGapMs) s.capNet = 0        // a new swipe: the cap re-arms, travel is kept
    if (s.dir === 0 && sign !== 0) s.dir = sign
    s.prevT = t

    s.acc += d
    let steps = 0
    for (;;) {
      const need = s.net === 0 ? o.leadPx : o.stepPx
      const way = s.acc >= need && s.capNet < o.maxSteps ? 1 : s.acc <= -need && s.capNet > -o.maxSteps ? -1 : 0
      if (way === 0) break
      if (o.minStepGapMs > 0 && t - s.lastStepT < o.minStepGapMs) {
        s.acc = Math.max(-need, Math.min(need, s.acc))                          // hold one, no backlog
        break
      }
      s.net += way
      s.capNet += way
      s.acc -= way * need
      s.lastStepT = t
      steps += way
      if (o.minStepGapMs > 0) break
    }
    // At the cap, travel past it is dropped, so turning back answers at once.
    if (s.capNet >= o.maxSteps) s.acc = Math.min(s.acc, 0)
    if (s.capNet <= -o.maxSteps) s.acc = Math.max(s.acc, 0)
    return steps
  }

  const axisOf = (dx: number, dy: number): 'x' | 'y' => {
    if (o.axis === 'both') return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    return Math.abs(dx) > AXIS_RATIO * Math.abs(dy) ? 'x' : 'y'
  }

  /** The event clearly belongs to the other axis, by enough to take over. */
  const takesOver = (s: Gesture, dx: number, dy: number): boolean => {
    if (s.axis === 'x') return Math.abs(dy) >= SWITCH_PX && Math.abs(dy) > AXIS_RATIO * Math.abs(dx)
    return Math.abs(dx) >= SWITCH_PX && Math.abs(dx) > AXIS_RATIO * Math.abs(dy)
  }

  const ours = (s: Gesture | null): boolean => s !== null && (o.axis === 'both' || s.axis === 'x')
  const settleAtOf = (s: Gesture | null): number | null => (s?.pending ? s.pending.t + o.notchMs : null)

  return {
    push(sample: WheelSample): WheelPushResult {
      if (sample.ctrlKey || sample.metaKey) return { steps: 0, consume: false, settleAt: settleAtOf(g) }
      const k = sample.deltaMode === 1 ? o.linePx : sample.deltaMode === 2 ? o.pagePx : 1
      let dx = finite(sample.deltaX) * k
      let dy = finite(sample.deltaY) * k
      if (sample.shiftKey && dx === 0 && dy !== 0) { dx = dy; dy = 0 }
      const t = finite(sample.timeStamp)
      let steps = 0

      // A notch waiting to see if it was alone: anything this late says it was.
      if (g?.pending && t - g.pending.t >= o.notchMs) steps += resolveNotch(g)
      if (g && t - g.lastT >= o.gestureGapMs) g = null

      if (dx === 0 && dy === 0) return { steps, consume: ours(g), settleAt: settleAtOf(g) }

      if (!g) g = newGesture(axisOf(dx, dy), t)
      else if (takesOver(g, dx, dy)) {
        steps += resolveNotch(g)
        g = newGesture(g.axis === 'x' ? 'y' : 'x', t)
      }
      const s = g
      s.lastT = t
      if (!ours(s)) return { steps, consume: false, settleAt: null }

      const d = s.axis === 'x' ? dx : dy
      if (s.stream) steps += feed(s, d, t)
      else if (s.pending) {
        // A neighbour inside notchMs: this is a stream, not notches.
        const p = s.pending
        s.pending = null
        s.stream = true
        steps += feed(s, p.d, p.t)
        steps += feed(s, d, t)
      } else s.pending = { d, t }
      return { steps, consume: true, settleAt: settleAtOf(s) }
    },

    settle(now: number): WheelSettleResult {
      if (!g?.pending) return { steps: 0, settleAt: null }
      if (now - g.pending.t < o.notchMs) return { steps: 0, settleAt: g.pending.t + o.notchMs }
      return { steps: resolveNotch(g), settleAt: null }
    },
  }
}

export interface WheelReplay {
  /** Steps credited at each sample (a notch's step lands on the sample it belongs to). */
  perSample: number[]
  consumed: boolean[]
  total: number
}

/** Replays a recorded stream as the renderer would: a pending notch settles
 *  at its settleAt unless the next sample comes first, and once after the end. */
export function replayWheel(samples: WheelSample[], options: CoverWheelOptions = {}): WheelReplay {
  const w = createCoverWheel(options)
  const perSample: number[] = []
  const consumed: boolean[] = []
  let total = 0
  let settleAt: number | null = null
  let owner = -1
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    if (settleAt !== null && settleAt <= s.timeStamp) {
      const r = w.settle(settleAt)
      if (owner >= 0) perSample[owner] += r.steps
      total += r.steps
      settleAt = r.settleAt
    }
    const r = w.push(s)
    perSample.push(r.steps)
    consumed.push(r.consume)
    total += r.steps
    if (r.settleAt !== null && r.settleAt !== settleAt) owner = i
    settleAt = r.settleAt
  }
  if (settleAt !== null) {
    const r = w.settle(settleAt)
    if (owner >= 0) perSample[owner] += r.steps
    total += r.steps
  }
  return { perSample, consumed, total }
}
