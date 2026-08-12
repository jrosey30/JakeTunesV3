/**
 * Gapless seam timing — tail pad subtracted from Howler remaining,
 * usable duration fed to BufferSource.start.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  USE_GAPLESS_TAIL_TRIM,
  MAX_TAIL_TRIM_SEC,
  clampPaddingSec,
  remainingMsUntilMusicEnd,
  usableDurationSec,
  incomingPlayDurationSec,
  trimSecsFromProbe,
} from '../../renderer/audio/gapless-timing.ts'

describe('flag defaults to on (gapless is the product default; crossfade is opt-in)', () => {
  it('USE_GAPLESS_TAIL_TRIM is true', () => {
    assert.equal(USE_GAPLESS_TAIL_TRIM, true)
  })
  it('caps padding at 80 ms', () => {
    assert.equal(MAX_TAIL_TRIM_SEC, 0.080)
  })
})

describe('remainingMsUntilMusicEnd', () => {
  it('subtracts encoder padding from Howler remaining', () => {
    // 250 ms rAF window, 20 ms AAC pad → seam 20 ms earlier.
    assert.equal(remainingMsUntilMusicEnd(250, 0.020), 230)
  })

  it('is a no-op when padding is 0 or missing', () => {
    assert.equal(remainingMsUntilMusicEnd(250, 0), 250)
    assert.equal(remainingMsUntilMusicEnd(250, NaN), 250)
    assert.equal(remainingMsUntilMusicEnd(250, -1), 250)
  })

  it('does not go to zero — seam still fires "now" if we are already in the pad', () => {
    assert.equal(remainingMsUntilMusicEnd(10, 0.020), 1)
    assert.equal(remainingMsUntilMusicEnd(0, 0.020), 1)
  })

  it('clamps absurd padding so a misread cannot eat the last beat', () => {
    // 500 ms claimed pad → 80 ms cap; 250 - 80 = 170.
    assert.equal(remainingMsUntilMusicEnd(250, 0.5), 170)
    assert.equal(clampPaddingSec(0.5), 0.080)
  })

  it('is identity when the flag is off (head-trim-only rollback)', () => {
    assert.equal(remainingMsUntilMusicEnd(250, 0.020, false), 250)
    assert.equal(remainingMsUntilMusicEnd(10, 0.020, false), 10)
  })

  it('matches Jake\'s measured 4–23 ms tail on a typical remaining window', () => {
    const pad4 = 4 / 1000
    const pad23 = 23 / 1000
    assert.equal(remainingMsUntilMusicEnd(250, pad4), 246)
    assert.equal(remainingMsUntilMusicEnd(250, pad23), 227)
  })
})

describe('usableDurationSec / incomingPlayDurationSec', () => {
  it('strips head delay and tail padding from the decoded buffer length', () => {
    const delay = 2112 / 44100
    const pad = 206 / 44100
    const usable = usableDurationSec(180, delay, pad)
    assert.ok(Math.abs(usable - (180 - delay - pad)) < 1e-12)
    assert.equal(incomingPlayDurationSec(180, delay, pad), usable)
  })

  it('ignores tail when the flag is off, still subtracts head delay', () => {
    const delay = 0.048
    const pad = 0.020
    assert.ok(Math.abs(usableDurationSec(180, delay, pad, false) - (180 - delay)) < 1e-12)
  })

  it('floors at 0 for degenerate buffers', () => {
    assert.equal(usableDurationSec(0, 0.05, 0.02), 0)
    assert.equal(usableDurationSec(0.01, 0.05, 0.02), 0)
    assert.equal(usableDurationSec(NaN, 0, 0), 0)
  })
})

describe('trimSecsFromProbe', () => {
  it('prefers the precomputed seconds fields', () => {
    assert.deepEqual(
      trimSecsFromProbe({ delaySec: 0.048, paddingSec: 0.02, delaySamples: 1, paddingSamples: 1, sampleRate: 44100 }),
      { delaySec: 0.048, paddingSec: 0.02 },
    )
  })

  it('falls back to samples / sampleRate (legacy IPC without paddingSec)', () => {
    const t = trimSecsFromProbe({ delaySamples: 2112, paddingSamples: 206, sampleRate: 44100 })
    assert.ok(Math.abs(t.delaySec - 2112 / 44100) < 1e-12)
    assert.ok(Math.abs(t.paddingSec - 206 / 44100) < 1e-12)
  })

  it('is zeros for null / empty probes — today\'s untrimmed seam', () => {
    assert.deepEqual(trimSecsFromProbe(null), { delaySec: 0, paddingSec: 0 })
    assert.deepEqual(trimSecsFromProbe({}), { delaySec: 0, paddingSec: 0 })
  })
})
