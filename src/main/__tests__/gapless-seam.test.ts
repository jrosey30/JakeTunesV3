/**
 * Source-shape lock: gapless tail trim is wired at the seam, not in
 * the crossfade path, and useAudio stays a two-line consumer.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const useAudio = readFileSync(join(ROOT, 'renderer/hooks/useAudio.ts'), 'utf-8')
const seam = readFileSync(join(ROOT, 'renderer/audio/seamScheduler.ts'), 'utf-8')
const timing = readFileSync(join(ROOT, 'renderer/audio/gapless-timing.ts'), 'utf-8')

describe('gapless tail trim wiring', () => {
  test('useAudio subtracts outgoing padding from msUntilEnd', () => {
    assert.match(useAudio, /remainingMsUntilMusicEnd/,
      'seam msUntilEnd is no longer passed through remainingMsUntilMusicEnd — tail pad plays as silence again')
    assert.match(useAudio, /tailTrimSecForUrl/,
      'outgoing URL pad lookup missing — album track 1 cannot contribute tail trim')
    assert.match(useAudio, /prefetchGaplessTrim/,
      'outgoing trim is not prefetched at next-track decode — first seam of an album has no pad number')
  })

  test('crossfade does not use tail-trim remaining', () => {
    const xf = useAudio.indexOf('Crossfade trigger:')
    assert.notEqual(xf, -1, 'crossfade trigger marker missing')
    const slice = useAudio.slice(xf, xf + 1200)
    assert.doesNotMatch(slice, /remainingMsUntilMusicEnd/,
      'crossfade path is now subtracting gapless tail pad — modes must stay mutually exclusive')
  })

  test('BufferSource.start is given a usable play duration (offset + duration)', () => {
    assert.match(seam, /incomingPlayDurationSec/,
      'scheduleAbsoluteStart no longer computes a play duration — incoming tail pad is not trimmed')
    assert.match(seam, /source\.start\(absoluteStartTime, offset, playDur\)/,
      'source.start no longer passes (when, offset, duration) — scheduler is not using usable duration')
  })

  test('tail trim is flag-gated and defaults on', () => {
    assert.match(timing, /export const USE_GAPLESS_TAIL_TRIM = true/,
      'USE_GAPLESS_TAIL_TRIM default changed — confirm product intent before updating')
  })
})
