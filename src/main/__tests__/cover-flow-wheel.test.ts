// Cover Flow by wheel (src/common/cover-flow-wheel.ts) — the MX Master 3S
// thumb wheel on workmini and the MacBook trackpad's two-finger side swipe
// (Jake, 2026-10-21). Streams are recorded SHAPES, not real captures: Chromium
// on the Mac gives a notchy wheel one event per notch (~4 px slow, 40 px+
// accelerated), Options+ smooth scrolling and the trackpad many small px
// deltas every 8–17 ms, the trackpad a decaying momentum tail after lift-off.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCoverWheel, replayWheel, COVER_WHEEL_DEFAULTS, JUKEBOX_WHEEL_OPTIONS,
  type WheelSample, type CoverWheelOptions,
} from '../../common/cover-flow-wheel.ts'

const sample = (deltaX: number, deltaY: number, timeStamp: number, extra: Partial<WheelSample> = {}): WheelSample =>
  ({ deltaX, deltaY, deltaMode: 0, shiftKey: false, timeStamp, ...extra })

/** Evenly spaced horizontal events. */
const hstream = (deltas: number[], every: number, t0 = 1000, extra: Partial<WheelSample> = {}): WheelSample[] =>
  deltas.map((d, i) => sample(d, 0, t0 + i * every, extra))
const vstream = (deltas: number[], every: number, t0 = 1000, extra: Partial<WheelSample> = {}): WheelSample[] =>
  deltas.map((d, i) => sample(0, d, t0 + i * every, extra))

/** The fingers' deltas, then the momentum tail decaying from the last one (macOS-style, whole px, 16 ms). */
function swipe(finger: number[], decay: number, t0 = 1000, every = 16): number[] {
  const out = [...finger]
  let v = Math.abs(finger[finger.length - 1]) * decay
  const sign = Math.sign(finger[finger.length - 1])
  while (Math.round(v) >= 1) { out.push(sign * Math.round(v)); v *= decay }
  void t0; void every
  return out
}
const sum = (a: number[]): number => a.reduce((s, x) => s + x, 0)
const lastStepAt = (perSample: number[]): number => perSample.reduce((at, s, i) => (s !== 0 ? i : at), -1)

// A gentle swipe, a medium one, a flick (fingers left = deltaX > 0 under natural scrolling).
const GENTLE = swipe([2, 4, 7, 9, 10, 9, 7, 5], 0.85)
const MEDIUM = swipe([3, 8, 12, 15, 16, 14, 12], 0.9)
const FLICK = swipe([4, 10, 18, 26, 32], 0.94)

describe('a notchy wheel: one notch, one cover', () => {
  test('MX thumb wheel at ±40 px a notch, unhurried: every notch is one cover', () => {
    const r = replayWheel(hstream([40, 40, 40, 40, 40], 200))
    assert.deepEqual(r.perSample, [1, 1, 1, 1, 1])
    assert.equal(r.total, 5)
    assert.ok(r.consumed.every(Boolean), 'horizontal = ours: the page never scrolls sideways')
    assert.equal(replayWheel(hstream([-40, -40, -40], 200)).total, -3)
  })

  test('notches inside one gesture (60 ms apart) are still one each, and a run of them is not capped', () => {
    const r = replayWheel(hstream(Array(8).fill(40), 60))
    assert.deepEqual(r.perSample, Array(8).fill(1))
  })

  test('a slow Mac notch is only ~4 px (0.1 line × 40) — still one cover; so is an accelerated 120 px one', () => {
    assert.equal(replayWheel(hstream([4.000244140625, 4.000244140625, 4.000244140625], 150)).total, 3)
    assert.equal(replayWheel(hstream([120], 0)).total, 1)
  })

  test('line- and page-mode notches (deltaMode 1/2) are one cover each', () => {
    assert.deepEqual(replayWheel(hstream([1, 3, -1], 200, 1000, { deltaMode: 1 })).perSample, [1, 1, -1])
    assert.equal(replayWheel(hstream([1], 0, 1000, { deltaMode: 2 })).total, 1)
  })

  test('a lone twitch under 2 px is not a notch', () => {
    assert.equal(replayWheel(hstream([1], 0)).total, 0)
  })

  test('a notch waits notchMs for a neighbour, then settles as one cover', () => {
    const w = createCoverWheel()
    const p = w.push(sample(40, 0, 5000))
    assert.equal(p.steps, 0)
    assert.equal(p.consume, true)
    assert.equal(p.settleAt, 5000 + COVER_WHEEL_DEFAULTS.notchMs)
    assert.deepEqual(w.settle(5039), { steps: 0, settleAt: 5040 }, 'too early: still waiting')
    assert.deepEqual(w.settle(5040), { steps: 1, settleAt: null })
    assert.deepEqual(w.settle(6000), { steps: 0, settleAt: null }, 'settled once')
  })
})

describe('smooth streams accumulate: first cover at 40 px, then one per 80 px', () => {
  // Options+ smooth scrolling on the thumb wheel: 2–8 px every 10 ms.
  const ROLL = [2, 4, 6, 8, 5, 3]

  test('a short smooth roll (56 px) moves one cover — no single 2–8 px event moves anything', () => {
    const r = replayWheel(hstream([...ROLL, ...ROLL], 10))
    assert.equal(r.total, 1)
    // The cover lands when the running total first reaches 40 (2+4+6+8+5+3+2+4+6 = 40).
    assert.equal(r.perSample.indexOf(1), 8)
    assert.ok(r.consumed.every(Boolean))
  })

  test('a long smooth roll (140 px) moves two: 40, then 120', () => {
    const roll = Array(5).fill(ROLL).flat()
    assert.equal(sum(roll), 140)
    assert.equal(replayWheel(hstream(roll, 10)).total, 2)
  })

  test('a slow steady drag (4 px every 16 ms): covers land at exactly 40, 120 and 200 px', () => {
    const r = replayWheel(hstream(Array(60).fill(4), 16))
    assert.deepEqual(r.perSample.flatMap((s, i) => (s !== 0 ? [(i + 1) * 4] : [])), [40, 120, 200])
  })

  test('30 px of smooth travel is not a cover (under the lead)', () => {
    assert.equal(replayWheel(hstream(Array(15).fill(2), 10)).total, 0)
  })
})

describe('the MacBook trackpad: two-finger side swipe with its momentum tail', () => {
  test('a gentle swipe (~90 px with its tail) moves one cover', () => {
    assert.ok(sum(GENTLE) >= 40 && sum(GENTLE) < 120, `gentle = ${sum(GENTLE)} px`)
    assert.equal(replayWheel(hstream(GENTLE, 16)).total, 1)
  })

  test('a medium swipe (~190 px) moves two', () => {
    assert.ok(sum(MEDIUM) >= 120 && sum(MEDIUM) < 200, `medium = ${sum(MEDIUM)} px`)
    assert.equal(replayWheel(hstream(MEDIUM, 16)).total, 2)
  })

  test('a flick (~600 px, tail included) stops at the cap — three covers, never the whole row', () => {
    assert.ok(sum(FLICK) > 500, `flick = ${sum(FLICK)} px`)
    const r = replayWheel(hstream(FLICK, 16))
    assert.equal(r.total, COVER_WHEEL_DEFAULTS.maxSteps)
    assert.equal(r.total, 3)
    // The covers move in the first ~150 ms; the second-long tail moves nothing more…
    assert.ok(FLICK.length > 50, `tail of ${FLICK.length} events`)
    assert.ok(lastStepAt(r.perSample) <= 9, `last step at sample ${lastStepAt(r.perSample)}`)
    // …but every event of it is still eaten, so the page never drifts sideways.
    assert.ok(r.consumed.every(Boolean))
  })

  test('direction follows the fingers under natural scrolling: fingers right (deltaX < 0) = previous cover', () => {
    assert.equal(replayWheel(hstream(MEDIUM.map((d) => -d), 16)).total, -2)
  })

  test('the same swipe on a 120 Hz Mac (8 ms events) moves the same covers', () => {
    assert.equal(replayWheel(hstream(MEDIUM, 8)).total, 2)
    assert.equal(replayWheel(hstream(FLICK, 8)).total, 3)
  })

  test('a horizontal swipe with a little vertical wobble is still horizontal', () => {
    const r = replayWheel(MEDIUM.map((d, i) => sample(d, i % 3 === 0 ? 1 : 0, 1000 + i * 16)))
    assert.equal(r.total, 2)
    assert.ok(r.consumed.every(Boolean))
  })
})

describe('vertical scrolling belongs to the page', () => {
  test('a trackpad vertical scroll with momentum: zero steps, nothing consumed', () => {
    const r = replayWheel(vstream(FLICK, 16))
    assert.equal(r.total, 0)
    assert.ok(r.consumed.every((c) => !c))
  })

  test('mouse-wheel notches up and down: zero steps, nothing consumed', () => {
    const r = replayWheel(vstream([40, 40, -40, 4, -4], 120))
    assert.equal(r.total, 0)
    assert.ok(r.consumed.every((c) => !c))
  })

  test('a vertical scroll that drifts sideways a little stays the page’s', () => {
    const r = replayWheel(FLICK.map((d, i) => sample(i % 2 ? 2 : 1, d, 1000 + i * 16)))
    assert.equal(r.total, 0)
    assert.ok(r.consumed.every((c) => !c))
  })

  test('a diagonal (45°) first event is not ours', () => {
    const r = replayWheel([sample(10, 10, 1000)])
    assert.deepEqual(r.consumed, [false])
  })
})

describe('shift + vertical wheel = horizontal', () => {
  test('shift + deltaY notches (no deltaX) step: down = next, up = previous', () => {
    const down = replayWheel(vstream([40, 40], 200, 1000, { shiftKey: true }))
    assert.equal(down.total, 2)
    assert.ok(down.consumed.every(Boolean))
    assert.equal(replayWheel(vstream([-40, -40, -40], 200, 1000, { shiftKey: true })).total, -3)
  })

  test('shift + a smooth vertical stream accumulates like a horizontal one', () => {
    assert.equal(replayWheel(vstream(MEDIUM, 16, 1000, { shiftKey: true })).total, 2)
  })

  test('when macOS already turned shift-wheel into deltaX, deltaX is used as-is', () => {
    assert.equal(replayWheel(hstream([40], 0, 1000, { shiftKey: true })).total, 1)
  })
})

describe('gestures: quiet splits them, nothing carries over', () => {
  test('two half-swipes of 30 px: 300 ms apart they are two gestures and move nothing', () => {
    const half = Array(10).fill(3)
    const apart = [...hstream(half, 10, 1000), ...hstream(half, 10, 1000 + 90 + 300)]
    assert.equal(replayWheel(apart).total, 0, 'a stale 30 px never tips the next gesture over')
    const joined = hstream([...half, ...half], 10, 1000)
    assert.equal(replayWheel(joined).total, 1, 'the same 60 px in one gesture is a cover')
  })

  test('two flicks with a quiet gap: the cap applies to each — 3 + 3', () => {
    const a = hstream(FLICK, 16, 1000)
    const b = hstream(FLICK, 16, a[a.length - 1].timeStamp + 300)
    assert.equal(replayWheel([...a, ...b]).total, 6)
  })
})

describe('the per-push cap', () => {
  test('maxSteps is what one push can do, whatever the travel', () => {
    for (const maxSteps of [1, 2, 4]) {
      assert.equal(replayWheel(hstream(FLICK, 16), { maxSteps }).total, maxSteps)
    }
    assert.ok(replayWheel(hstream(FLICK, 16), { maxSteps: Infinity }).total > 3, 'uncapped, the same flick sails on')
  })

  test('big single events (a coalesced burst after a busy frame) cannot step past the cap either', () => {
    const r = replayWheel(hstream([60, 200, 200, 200], 16))
    assert.equal(r.total, 3)
    assert.equal(replayWheel(hstream([-60, -200, -200, -200], 16)).total, -3)
  })

  test('fingers back on the pad stop the tail; a beat later a new flick re-arms the cap (no 160 ms quiet needed)', () => {
    const tA = hstream(FLICK.slice(0, 5 + 20), 16, 1000)      // the flick, its tail stopped by the touch
    const tB = hstream(FLICK, 16, tA[tA.length - 1].timeStamp + 100)
    assert.equal(replayWheel([...tA, ...tB]).total, 6)
  })

  test('a new swipe that starts inside the tail’s own rhythm (< 70 ms) is the same push — still capped', () => {
    const tA = hstream(FLICK.slice(0, 5 + 20), 16, 1000)
    const tB = hstream(FLICK, 16, tA[tA.length - 1].timeStamp + 40)
    assert.equal(replayWheel([...tA, ...tB]).total, 3)
  })

  test('the tail alone never re-arms, even with its events bunched and delayed by busy frames', () => {
    const tail = swipe([4, 10, 18, 26, 32], 0.97)
    const regular = tail.map((d, i) => sample(d, 0, 1000 + i * 16 + (i % 2 ? 6 : 0)))
    assert.equal(replayWheel(regular).total, 3)
    // What the renderer harness saw: a 40–60 ms stall, then events 1 ms apart.
    let t = 1000
    const bunched = tail.map((d, i) => { t += i % 6 === 0 ? 60 : i % 6 === 1 ? 1 : 16; return sample(d, 0, t) })
    assert.equal(replayWheel(bunched).total, 3)
  })

  test('travel past the cap is dropped: a slow drag back steps back after one stepPx, not after unwinding the tail', () => {
    const f = hstream(FLICK, 16, 1000)
    const back = hstream(Array(25).fill(-4), 16, f[f.length - 1].timeStamp + 16)
    const r = replayWheel([...f, ...back])
    assert.equal(r.total, 2)
    assert.equal(r.perSample.slice(f.length).indexOf(-1), 19, 'the 20th −4 px event (80 px back)')
  })

  test('turning back starts a fresh push: the leftover the old way is dropped and the lead applies', () => {
    const fwd = hstream(Array(10).fill(10), 10, 1000)           // 100 px: one cover, 60 px toward the next
    const back = hstream(Array(6).fill(-10), 10, 1100)
    const r = replayWheel([...fwd, ...back])
    assert.equal(r.total, 0)
    assert.equal(r.perSample.slice(fwd.length).indexOf(-1), 3, 'back after 40 px, not after unwinding 60 + 80')
  })

  test('a flick back is capped on its own: three back, not six', () => {
    const f = hstream(FLICK, 16, 1000)
    const b = hstream(FLICK.map((d) => -d), 16, f[f.length - 1].timeStamp + 16)
    assert.equal(replayWheel([...f, ...b]).total, 0)
  })

  test('turning back after the cap answers at once and moves back', () => {
    const r = replayWheel([...hstream(FLICK.slice(0, 12), 16, 1000), ...hstream([-6, -12, -20, -26, -30], 16, 1000 + 12 * 16)])
    assert.equal(r.perSample.slice(0, 12).reduce((s, x) => s + x, 0), 3)
    assert.ok(r.total < 3, `after the reversal net = ${r.total}`)
  })
})

describe('axis hand-over without waiting for quiet', () => {
  test('swipe the covers, then scroll the page straight away: the vertical scroll is not eaten', () => {
    const h = hstream(MEDIUM, 16, 1000)
    const v = vstream([6, 12, 18, 18, 14, 10], 16, h[h.length - 1].timeStamp + 16)
    const r = replayWheel([...h, ...v])
    assert.equal(r.total, 2)
    assert.ok(r.consumed.slice(h.length).every((c) => !c), 'every vertical event reaches the page')
  })

  test('scroll the page, then a thumb-wheel notch straight away: the notch steps', () => {
    const v = vstream([20, 20, 20], 16, 1000)
    const r = replayWheel([...v, sample(40, 0, 1000 + 3 * 16 + 20)])
    assert.equal(r.total, 1)
    assert.deepEqual(r.consumed, [false, false, false, true])
  })
})

describe('never a cover step', () => {
  test('a trackpad pinch (ctrl + wheel) is not ours', () => {
    const r = replayWheel(hstream([40, 40], 200, 1000, { ctrlKey: true }))
    assert.equal(r.total, 0)
    assert.ok(r.consumed.every((c) => !c))
  })

  test('zero and non-finite deltas are ignored without breaking the stream', () => {
    const r = replayWheel([sample(0, 0, 1000), sample(Number.NaN, 0, 1010), sample(40, 0, 1300)])
    assert.equal(r.total, 1)
  })
})

describe('the library’s jukebox arc (CoverFlowView)', () => {
  const J: CoverWheelOptions = JUKEBOX_WHEEL_OPTIONS

  test('either axis flips: a vertical notch and a horizontal notch are one page each', () => {
    assert.equal(replayWheel(vstream([40, 40], 200), J).total, 2)
    assert.equal(replayWheel(hstream([40, -40, -40], 200), J).total, -1)
    assert.equal(replayWheel(vstream([4.000244140625], 0), J).total, 1, 'the slow 4 px Mac notch the old 48 px threshold needed twelve of')
  })

  test('every jukebox gesture is consumed — the stage owns the wheel', () => {
    assert.ok(replayWheel(vstream(FLICK, 16), J).consumed.every(Boolean))
  })

  test('a flick runs on (no cap) but flips at most every 70 ms', () => {
    const r = replayWheel(vstream(FLICK, 16), J)
    assert.ok(r.total > 3, `jukebox flick = ${r.total}`)
    const at = r.perSample.flatMap((s, i) => (s !== 0 ? [1000 + i * 16] : []))
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 70, `flips ${at[i - 1]} → ${at[i]}`)
    assert.ok(r.perSample.every((s) => Math.abs(s) <= 1), 'one flip per event at most')
  })

  test('a stale partial scroll no longer tips a later, unrelated one into a flip', () => {
    const r = replayWheel([...vstream([10, 10, 10, 10], 10, 1000), ...vstream([10], 0, 2000)], J)
    assert.equal(r.total, 1, 'the late lone event is its own notch, the 40 px before it never flipped')
  })
})

describe('wiring (source locks)', () => {
  const read = (rel: string): string => readFileSync(join(import.meta.dirname, '../..', rel), 'utf-8')
  const hook = read('renderer/hooks/useCoverFlowWheel.ts')

  test('the listener is native and non-passive (React’s onWheel is passive: preventDefault would be ignored)', () => {
    assert.match(hook, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/)
    assert.match(hook, /if \(r\.consume && e\.cancelable\) e\.preventDefault\(\)/)
  })

  test('a lone notch settles on the EVENT clock — never compared with performance.now()', () => {
    // With the wall clock, a busy page (events handled ~30 ms late in the
    // renderer harness) read every event of a swipe as a lone notch.
    assert.doesNotMatch(hook.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /performance\.now\(/)
    assert.match(hook, /wheel\.settle\(at\)/)
    assert.match(hook, /Math\.max\(0, at - eventTime\)/)
  })

  test('both Cover Flows use it; the jukebox’s passive React onWheel is gone', () => {
    const home = read('renderer/components/TonightOnJakeTunes.tsx')
    const juke = read('renderer/views/CoverFlowView.tsx')
    assert.match(home, /useCoverFlowWheel\(stageRef,[\s\S]*?COVER_WHEEL_DEFAULTS, flow\.length > 0\)/)
    assert.match(juke, /useCoverFlowWheel\(stageRef, go, JUKEBOX_WHEEL_OPTIONS, albums\.length > 0\)/)
    assert.doesNotMatch(juke, /onWheel=/)
    assert.match(juke, /ref=\{stageRef\}\s+className="coverflow-stage"/)
  })
})
