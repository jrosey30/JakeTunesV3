/**
 * Source-shape lock: every useAudio() instance reads playback and library
 * state through ONE module-wide snapshot, never a per-instance useRef.
 *
 * Why (2026-10-31, Perfecth seams 21 + 22): the Howl callbacks, the rAF
 * loop and runNaturalEnd belong to whichever instance's playTrack started
 * the lineage — a view's. A per-instance ref is refreshed only while that
 * view renders; navigate away and it freezes while its closures keep
 * driving playback. The gapless preload then read queue[frozenIndex + 1]
 * — the song already playing — so gaplessNextTrack never matched the real
 * next track and the seam fell to standard-advance: the wrong buffer was
 * hard-stopped and the next song loaded cold, ~0.5 s of silence.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const useAudio = readFileSync(join(ROOT, 'renderer/hooks/useAudio.ts'), 'utf-8')

describe('useAudio shared state snapshot', () => {
  test('playback state is read through the module-wide snapshot, not a per-instance ref', () => {
    assert.doesNotMatch(useAudio, /const stateRef = useRef\(/,
      'a per-instance stateRef is back — a view unmount freezes the seam chain on a stale queueIndex')
    assert.match(useAudio, /const stateRef = sharedStateRef/,
      'useAudio no longer reads playback state through sharedStateRef')
  })

  test('library tracks are read through the module-wide snapshot too (natural-end play counts)', () => {
    assert.doesNotMatch(useAudio, /const tracksRef = useRef\(/,
      'a per-instance tracksRef is back — natural-end play counts read a frozen library')
    assert.match(useAudio, /const tracksRef = sharedTracksRef/,
      'useAudio no longer reads library tracks through sharedTracksRef')
  })

  test('a standard-advance seam names the preloaded track and the due track', () => {
    const i = useAudio.indexOf("path: 'standard-advance'")
    assert.notEqual(i, -1, 'standard-advance branch marker missing')
    const slice = useAudio.slice(i, i + 400)
    assert.match(slice, /preload:/, 'standard-advance log no longer names the preloaded track')
    assert.match(slice, /next:/, 'standard-advance log no longer names the due track')
  })
})
