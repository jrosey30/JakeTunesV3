import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RING_GAP_S, decayFor, easeFor, frameSeconds, newBloom, stepBloom,
} from '../../renderer/utils/visualizerClock.ts'

/** A pounding kick: full bass every other quarter second, silence between. */
const kick = (t: number): number => (Math.floor(t / 0.125) % 2 === 0 ? 1 : 0)

function run(hz: number, seconds: number) {
  const s = newBloom()
  const rings: number[] = []
  let last: number | null = 0
  for (let f = 1; f <= hz * seconds; f++) {
    const now = (f * 1000) / hz
    const dt = frameSeconds(now, last)
    last = now
    if (stepBloom(s, kick(s.t), dt)) rings.push(s.t)
  }
  return { s, rings }
}

test('rings stay under three a second on a 120 Hz screen (the flash limit)', () => {
  for (const hz of [60, 120, 144]) {
    const { rings } = run(hz, 10)
    for (let i = 1; i < rings.length; i++) {
      assert.ok(rings[i]! - rings[i - 1]! > RING_GAP_S - 1e-9, `${hz} Hz: rings ${rings[i - 1]} and ${rings[i]}`)
    }
    assert.ok(rings.length / 10 < 3, `${hz} Hz: ${rings.length} rings in 10 s`)
  }
})

test('the clock runs at real speed whatever the screen', () => {
  assert.ok(Math.abs(run(60, 5).s.t - 5) < 1e-6)
  assert.ok(Math.abs(run(120, 5).s.t - 5) < 1e-6)
})

test('easing reaches the same place in the same time at 60 and 120 Hz', () => {
  // A bass note held for half a second: both screens must be at the same point
  // of the swell after it, or a 120 Hz screen breathes twice as fast.
  const ease = (hz: number) => {
    const s = newBloom()
    for (let f = 0; f < hz / 2; f++) stepBloom(s, 1, 1 / hz)
    return s
  }
  const a = ease(60), b = ease(120)
  assert.ok(Math.abs(a.bassVis - b.bassVis) < 0.01, `${a.bassVis} vs ${b.bassVis}`)
  assert.ok(Math.abs(a.bassEnv - b.bassEnv) < 0.01, `${a.bassEnv} vs ${b.bassEnv}`)
  assert.ok(a.bassVis > 0.9 && a.bassEnv > 0.9, 'it does swell')
})

test('at 60 fps the rates are exactly the old per-frame numbers', () => {
  assert.ok(Math.abs(easeFor(0.09, 1 / 60) - 0.09) < 1e-12)
  assert.ok(Math.abs(decayFor(0.952, 1 / 60) - 0.952) < 1e-12)
  // two 120 Hz frames equal one 60 Hz frame
  assert.ok(Math.abs(decayFor(0.952, 1 / 120) ** 2 - 0.952) < 1e-12)
})

test('a stalled frame does not leap', () => {
  assert.equal(frameSeconds(5000, 1000), 0.1)
  assert.equal(frameSeconds(1000, null), 1 / 60)
  assert.equal(frameSeconds(1000, 1000), 1 / 60)
})
