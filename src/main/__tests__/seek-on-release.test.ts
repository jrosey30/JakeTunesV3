// V7 steady (2026-11-24): the progress bar seeks once, on release, and only one
// seek is ever in flight on the element (newest wins). Twin of the iPhone's SeekChase.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scrub, scrubIdle, knobPct, type ScrubState } from '../../renderer/audio/scrubDrag.ts'
import { newSeekChase, requestSeek, seekLanded, SEEK_STALE_MS } from '../../renderer/audio/seekChase.ts'

const src = (p: string) => readFileSync(join(import.meta.dirname, '../../renderer', p), 'utf8')

test('a drag moves the knob on every move and seeks exactly once, on release', () => {
  let s: ScrubState = scrubIdle
  const seeks: number[] = []
  for (const ev of [
    { type: 'down', pct: 0.1 }, { type: 'move', pct: 0.2 }, { type: 'move', pct: 0.35 },
    { type: 'move', pct: 0.6 }, { type: 'up', pct: 0.62 },
  ] as const) {
    const r = scrub(s, ev)
    s = r.state
    if (r.seekTo != null) seeks.push(r.seekTo)
    if (ev.type === 'move') assert.equal(knobPct(s, 30, 100), ev.pct, 'the knob follows the mouse, not the song')
  }
  assert.deepEqual(seeks, [0.62])
  assert.equal(s.dragging, false)
  assert.equal(knobPct(s, 30, 100), 0.3, 'released: the knob is the song again')
})

test('a click still seeks to where it was clicked; a cancel seeks nowhere; values are clamped', () => {
  const down = scrub(scrubIdle, { type: 'down', pct: 0.4 })
  assert.equal(down.seekTo, null)
  assert.equal(scrub(down.state, { type: 'up', pct: 0.4 }).seekTo, 0.4)
  assert.equal(scrub(down.state, { type: 'cancel' }).seekTo, null)
  assert.equal(scrub(scrubIdle, { type: 'up', pct: 0.5 }).seekTo, null, 'a release with no press is nothing')
  assert.equal(scrub(down.state, { type: 'up', pct: 1.7 }).seekTo, 1)
  assert.equal(scrub(down.state, { type: 'up', pct: -3 }).seekTo, 0)
})

test('one seek in flight: positions asked meanwhile wait, only the newest goes over when it lands', () => {
  const c = newSeekChase<string>()
  assert.equal(requestSeek(c, 10, 'a', 0), 10)
  assert.equal(requestSeek(c, 20, 'a', 100), null)
  assert.equal(requestSeek(c, 30, 'a', 200), null)
  assert.equal(requestSeek(c, 40, 'a', 300), null)
  assert.equal(seekLanded(c, 'a', 500), 40, 'only the newest')
  assert.equal(seekLanded(c, 'a', 900), null, 'nothing more waiting')
  assert.equal(requestSeek(c, 50, 'a', 1000), 50, 'idle again: goes at once')
})

test('a seek with no answer for the stale time is replaced', () => {
  const c = newSeekChase<string>()
  requestSeek(c, 10, 'a', 0)
  assert.equal(requestSeek(c, 20, 'a', SEEK_STALE_MS - 1), null)
  assert.equal(requestSeek(c, 30, 'a', SEEK_STALE_MS), 30)
})

test('a waiting position is never handed to the next song', () => {
  const c = newSeekChase<string>()
  requestSeek(c, 10, 'song1', 0)
  requestSeek(c, 99, 'song1', 50)
  assert.equal(requestSeek(c, 5, 'song2', 60), 5, 'a new song is not held by the old one\'s seek')
  assert.equal(seekLanded(c, 'song1', 70), null, 'the old song answering does nothing')
  assert.equal(seekLanded(c, 'song2', 80), null, 'and its waiting 99 is gone')
})

test('wiring: the bar seeks only through the drag model; useAudio seeks only through the chase', () => {
  const np = src('components/playback/NowPlaying.tsx')
  const handler = np.slice(np.indexOf('const handleMouseDown'), np.indexOf('const progress ='))
  assert.match(handler, /scrub\(scrubRef\.current, ev\)/)
  assert.doesNotMatch(handler, /onMove = \(ev: MouseEvent\) => seek\(/, 'no seek per mouse move')
  assert.match(np, /knobPct\(scrubState/)
  const ua = src('hooks/useAudio.ts')
  const seekFn = ua.slice(ua.indexOf('const seek = useCallback'), ua.indexOf('const setVolume = useCallback'))
  assert.match(seekFn, /requestSeek\(seekChase/)
  assert.doesNotMatch(seekFn, /sharedHowl\.seek\(/, 'seek() never hands the element a position directly')
})

test('a lost mouse-up (blur, pointercancel) lets go of the knob without seeking', () => {
  const down = scrub(scrubIdle, { type: 'down', pct: 0.2 })
  const moved = scrub(down.state, { type: 'move', pct: 0.7 })
  const c = scrub(moved.state, { type: 'cancel' })
  assert.equal(c.seekTo, null)
  assert.equal(c.state.dragging, false)
  assert.equal(knobPct(c.state, 10, 100), 0.1, 'the knob is the song again, not frozen at 0.7')
  const np = src('components/playback/NowPlaying.tsx')
  const handler = np.slice(np.indexOf('const handleMouseDown'), np.indexOf('const progress ='))
  assert.match(handler, /const onCancel = \(\) => \{ detach\(\); step\(\{ type: 'cancel' \}\) \}/)
  assert.match(handler, /window\.addEventListener\('blur', onCancel\)/)
  assert.match(handler, /window\.addEventListener\('pointercancel', onCancel\)/)
})
