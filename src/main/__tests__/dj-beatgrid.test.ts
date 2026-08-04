import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beatPeriod, beatTime, nearestBeatIndex, beatOffsetSeconds, quantize,
  beatsInRange, syncRate, crossfadeGains, camelotCompatible, parseCamelot, tempoDistance,
} from '../../renderer/dj/beatgrid.ts'

test('beat period is seconds per beat', () => {
  assert.equal(beatPeriod(120), 0.5)
  assert.equal(beatPeriod(60), 1)
  assert.equal(beatPeriod(0), 0)          // no divide-by-zero escaping into timing maths
  assert.equal(beatPeriod(NaN), 0)
})

test('the grid is anchored at the offset, not at zero', () => {
  // Anchoring at 0.000s is wrong for nearly every real file, and being a few
  // tens of ms out is the difference between a locked mix and an audible flam.
  assert.equal(beatTime(0, 120, 0.32), 0.32)
  assert.equal(beatTime(4, 120, 0.32), 2.32)
})

test('nearest beat and its signed distance', () => {
  assert.equal(nearestBeatIndex(2.26, 120, 0), 5)         // 2.26 -> beat at 2.5? no: 4.52 -> 5
  assert.ok(Math.abs(beatOffsetSeconds(2.55, 120, 0) - 0.05) < 1e-9)   // late
  assert.ok(beatOffsetSeconds(2.45, 120, 0) < 0)                        // early
})

test('quantize snaps to the grid', () => {
  assert.ok(Math.abs(quantize(2.44, 120, 0) - 2.5) < 1e-9)
  assert.ok(Math.abs(quantize(2.44, 120, 0.1) - 2.6) < 1e-9)
})

test('beatsInRange stays inside the window and cannot run away', () => {
  const b = beatsInRange(1, 3, 120, 0)
  assert.ok(b.every((t) => t >= 1 && t <= 3))
  assert.equal(b.length, 5)                                 // 1.0 1.5 2.0 2.5 3.0
  assert.equal(beatsInRange(0, 1e9, 120, 0).length, 4096)    // hard cap holds
  assert.deepEqual(beatsInRange(5, 1, 120), [])              // inverted range
  assert.deepEqual(beatsInRange(0, 10, 0), [])               // bad bpm
})

test('syncRate matches tempos and refuses absurd stretches', () => {
  assert.ok(Math.abs(syncRate(120, 126) - 1.05) < 1e-9)
  assert.equal(syncRate(60, 180), 1.25)     // clamped, not 3x
  assert.equal(syncRate(180, 60), 0.75)
  assert.equal(syncRate(0, 120), 1)
})

test('crossfader holds perceived level across the throw', () => {
  const mid = crossfadeGains(0)
  // Equal power: the two gains square-sum to 1 everywhere, so the blend does
  // not dip ~3 dB in the middle the way a linear fader does.
  for (const pos of [-1, -0.5, 0, 0.37, 1]) {
    const g = crossfadeGains(pos)
    assert.ok(Math.abs(g.a * g.a + g.b * g.b - 1) < 1e-9, `not equal-power at ${pos}`)
  }
  assert.ok(Math.abs(mid.a - mid.b) < 1e-9)
  assert.ok(Math.abs(crossfadeGains(-1).a - 1) < 1e-9)
  assert.ok(Math.abs(crossfadeGains(1).b - 1) < 1e-9)
  assert.ok(Math.abs(crossfadeGains(-5).a - 1) < 1e-9)   // clamped
})

test('camelot compatibility follows the wheel', () => {
  assert.ok(camelotCompatible('8A', '8A'))     // same key
  assert.ok(camelotCompatible('8A', '9A'))     // +1
  assert.ok(camelotCompatible('8A', '7A'))     // -1
  assert.ok(camelotCompatible('8A', '8B'))     // relative major
  assert.ok(camelotCompatible('12A', '1A'))    // wraps 12 -> 1
  assert.ok(camelotCompatible('1A', '12A'))
  assert.ok(!camelotCompatible('8A', '2A'))    // across the wheel
  assert.ok(!camelotCompatible('8A', '9B'))    // letter change AND step
  assert.ok(!camelotCompatible('8A', undefined))
})

test('camelot parsing rejects nonsense rather than guessing', () => {
  assert.deepEqual(parseCamelot('11B'), { n: 11, letter: 'B' })
  assert.deepEqual(parseCamelot(' 3a '), { n: 3, letter: 'A' })
  assert.equal(parseCamelot('13A'), null)
  assert.equal(parseCamelot('0A'), null)
  assert.equal(parseCamelot('8C'), null)
  assert.equal(parseCamelot('Am'), null)
})

test('tempoDistance ranks how hard a blend would be', () => {
  assert.ok(tempoDistance(120, 122) < tempoDistance(120, 140))
  assert.equal(tempoDistance(120, 0), Infinity)
})
