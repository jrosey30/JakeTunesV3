/**
 * Pill count-up / countdown must tick as one clock.
 *
 * Jake, 2026-08-13, Daily Mix 2 on workmini: elapsed read 1:03:37 while
 * remaining read -28:19. Same mix, same numbers (they add to 1:31:56) but
 * one side had rolled to H:MM:SS and the other had not — plus the tape
 * path still floored remaining independently, which is the Brief 025
 * drift daily mixes inherit because a mix IS a tape session.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { formatScrubberClock } from '../../common/scrubber-clock.ts'

describe('scrubber clock pair', () => {
  test('Brief 025: floors once so elapsed + remaining === floor(duration)', () => {
    const c = formatScrubberClock(4.6, 75.4)
    assert.equal(c.elapsed, '0:04')
    assert.equal(c.remaining, '1:11')
  })

  test('tape path: independent remaining-floor would drop a second', () => {
    // elapsedMs=3813600, totalMs=5516500 — the old
    // floor((total - elapsed) / 1000) yields 1702, off by one.
    const c = formatScrubberClock(3813.6, 5516.5)
    assert.equal(c.elapsed, '1:03:33')
    assert.equal(c.remaining, '0:28:23')
  })

  test('hour-long mix formats both sides as H:MM:SS', () => {
    // The Daily Mix 2 screenshot: 1:03:37 into a ~1:32 mix.
    const c = formatScrubberClock(3817, 5516)
    assert.equal(c.elapsed, '1:03:37')
    assert.equal(c.remaining, '0:28:19')
  })

  test('sub-hour tracks stay M:SS on both sides', () => {
    const c = formatScrubberClock(83, 210)
    assert.equal(c.elapsed, '1:23')
    assert.equal(c.remaining, '2:07')
  })

  test('clamps when position overshoots duration', () => {
    const c = formatScrubberClock(180.4, 180.1)
    assert.equal(c.elapsed, '3:00')
    assert.equal(c.remaining, '0:00')
  })

  test('non-finite values render as 0:00 / 0:00', () => {
    const c = formatScrubberClock(Number.NaN, Number.POSITIVE_INFINITY)
    assert.equal(c.elapsed, '0:00')
    assert.equal(c.remaining, '0:00')
  })
})
