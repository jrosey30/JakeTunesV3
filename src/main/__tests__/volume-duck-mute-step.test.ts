// V7 steady (2026-11-24): ducking is its own stage (Jake's volume and the saved
// value never move), mute remembers the level, one volume step everywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VOLUME_STEP, DUCK_LEVEL, stepVolume, toggleMute, outputVolume, duckAt, duckWatch, DUCK_ORPHAN_MS, rememberLevel, MUTE_RESTORE_FLOOR, MUTE_RESTORE_DEFAULT } from '../../renderer/audio/volumeModel.ts'

const src = (p: string) => readFileSync(join(import.meta.dirname, '../../renderer', p), 'utf8')

test('the speakers get volume times duck; a duck never changes the volume itself', () => {
  assert.equal(outputVolume(0.8, 1), 0.8)
  assert.ok(Math.abs(outputVolume(0.8, DUCK_LEVEL) - 0.12) < 1e-9)
  assert.equal(outputVolume(0.6, 0), 0)
  assert.equal(outputVolume(1.4, 2), 1, 'clamped')
  // A whole duck down and back up: the user value is an input, never an output.
  const user = 0.7
  const levels = [] as number[]
  for (let i = 1; i <= 20; i++) levels.push(duckAt(1, DUCK_LEVEL, i, 20))
  for (let i = 1; i <= 30; i++) levels.push(duckAt(DUCK_LEVEL, 1, i, 30))
  assert.equal(levels[19], DUCK_LEVEL)
  assert.equal(levels.at(-1), 1)
  assert.equal(outputVolume(user, levels.at(-1)!), user, 'back to exactly Jake\'s level')
})

test('duckAt ramps linearly and lands on the target', () => {
  assert.equal(duckAt(1, 0.15, 0, 20), 1)
  assert.ok(Math.abs(duckAt(1, 0.15, 10, 20) - 0.575) < 1e-9)
  assert.equal(duckAt(1, 0.15, 25, 20), 0.15)
})

test('wiring: the Toolbar ducks through setDuck and never touches the volume', () => {
  const tb = src('components/playback/Toolbar.tsx')
  assert.doesNotMatch(tb, /setVolume\(/, 'no duck path may move Jake\'s volume')
  assert.doesNotMatch(tb, /savedVolumeRef/)
  assert.match(tb, /setDuck\(g\)/)
  const ua = src('hooks/useAudio.ts')
  assert.match(ua, /const setDuck = useCallback/)
  const setDuck = ua.slice(ua.indexOf('const setDuck = useCallback'), ua.indexOf('}, [])', ua.indexOf('const setDuck = useCallback')))
  assert.doesNotMatch(setDuck, /SET_VOLUME/, 'the duck is never dispatched (or saved)')
  // Every level a howl is given comes through outVolume(), so a duck holds across seams.
  let seen = 0
  for (const m of ua.matchAll(/(fadeInHowl|ensureHowlAudible|snapHowlOutputVolume)\((\w+), ([\w.]+)/g)) {
    if (m.index! < ua.indexOf('let duckGain')) continue // the helpers' own definitions
    seen++
    assert.ok(['outVolume', 'outputVolume', 'targetVol'].includes(m[3]), `${m[0]} must go through the duck`)
  }
  assert.ok(seen >= 8, `expected the howl level sites, saw ${seen}`)
  assert.doesNotMatch(ua, /targetVol = stateRef\.current\.volume/)
  assert.equal((ua.match(/const targetVol = outVolume\(\)/g) || []).length, 2, 'both crossfade targets are ducked')
})

test('mute remembers the level, and the speaker brings it back', () => {
  const muted = toggleMute(0.65, 0.3)
  assert.deepEqual(muted, { volume: 0, lastAudible: 0.65 })
  assert.deepEqual(toggleMute(muted.volume, muted.lastAudible), { volume: 0.65, lastAudible: 0.65 })
  assert.equal(toggleMute(0, 0).volume, 0.5, 'nothing to remember: a sensible level, not silence')
  const vs = src('components/playback/VolumeSlider.tsx')
  assert.doesNotMatch(vs, /onClick=\{\(\) => setVolume\(0\)\}/)
  assert.match(vs, /toggleMute\(/)
})

test('one volume step everywhere: 5%, on a clean grid, clamped', () => {
  assert.equal(VOLUME_STEP, 0.05)
  assert.equal(stepVolume(0.5, 1), 0.55)
  assert.equal(stepVolume(0.5, -1), 0.45)
  assert.equal(stepVolume(0.98, 1), 1)
  assert.equal(stepVolume(0.02, -1), 0)
  let v = 0
  for (let i = 0; i < 7; i++) v = stepVolume(v, 1)
  assert.equal(v, 0.35, 'no float drift')
  const app = src('App.tsx')
  assert.doesNotMatch(app, /volume \+ 0\.1|volume - 0\.1|v \+ 0\.05|v - 0\.05/)
  assert.equal((app.match(/stepVolume\(/g) || []).length, 4, 'arrow keys and the menu use the same step')
})

test('a duck with no voice over it is lifted after the orphan time, never while a voice plays', () => {
  let q: number | null = null
  let r = duckWatch(q, DUCK_LEVEL, false, 0); q = r.quietSince
  assert.equal(r.lift, false)
  r = duckWatch(q, DUCK_LEVEL, false, DUCK_ORPHAN_MS - 1); q = r.quietSince
  assert.equal(r.lift, false)
  r = duckWatch(q, DUCK_LEVEL, false, DUCK_ORPHAN_MS)
  assert.equal(r.lift, true, 'an orphaned duck lifts')
  // A voice playing resets the quiet clock.
  q = duckWatch(null, DUCK_LEVEL, false, 0).quietSince
  q = duckWatch(q, DUCK_LEVEL, true, 5000).quietSince
  assert.equal(q, null)
  assert.equal(duckWatch(q, DUCK_LEVEL, false, DUCK_ORPHAN_MS + 100).lift, false, 'the clock restarted at the voice')
  for (let t = 0; t <= 60_000; t += 1000) assert.equal(duckWatch(0, DUCK_LEVEL, true, t).lift, false)
  assert.equal(duckWatch(0, 1, false, 60_000).lift, false, 'no duck, nothing to lift')
})

test('wiring: any volume change of Jake\'s lifts the duck; the watchdog runs while ducked; Toolbar drops its ramp', () => {
  const ua = src('hooks/useAudio.ts')
  const sv = ua.slice(ua.indexOf('const setVolume = useCallback'), ua.indexOf('const setDuck = useCallback'))
  assert.match(sv, /if \(duckGain < 1\) \{\s*duckGain = 1/, 'setVolume must lift the duck')
  assert.match(sv, /DUCK_LIFTED_EVENT/)
  const sd = ua.slice(ua.indexOf('const setDuck = useCallback'), ua.indexOf('}, [])', ua.indexOf('const setDuck = useCallback')))
  assert.match(sd, /if \(duckGain < 1\) armDuckWatch\(\)/)
  assert.match(ua, /duckWatch\(duckQuietSince, duckGain, isTalkOverPlaying\(\), Date\.now\(\)\)/)
  assert.match(ua, /if \(r\.lift\) liftDuck\('orphan'\)/)
  const tb = src('components/playback/Toolbar.tsx')
  const on = tb.slice(tb.indexOf('const onLifted'), tb.indexOf('window.addEventListener(DUCK_LIFTED_EVENT'))
  assert.match(on, /clearFade\(\)/)
  assert.match(on, /duckRef\.current = 1/)
  assert.match(on, /isFadedRef\.current = false/)
  const eq = src('audio/eq.ts')
  for (const fn of ['attachClipToBroadcast', 'attachAnnouncerToBroadcast']) {
    const body = eq.slice(eq.indexOf(`export function ${fn}(`))
    assert.match(body.slice(0, 120), /registerTalkClip\(audio\)/, `${fn} must register the clip before any early return`)
  }
})

test('unmute never brings back a level below the floor (a slider dragged to ~1%)', () => {
  assert.equal(rememberLevel(0.6, 0.01), 0.6, 'a 1% release is not remembered')
  assert.equal(rememberLevel(0.6, 0.3), 0.3)
  assert.equal(rememberLevel(0.6, MUTE_RESTORE_FLOOR), MUTE_RESTORE_FLOOR)
  // Muting at 1% keeps the earlier good level.
  assert.deepEqual(toggleMute(0.01, 0.7), { volume: 0, lastAudible: 0.7 })
  // Whatever was remembered, unmute is never below the floor.
  assert.equal(toggleMute(0, 0.02).volume, MUTE_RESTORE_DEFAULT)
  const vs = src('components/playback/VolumeSlider.tsx')
  assert.doesNotMatch(vs, /if \(state\.volume > 0\) lastAudibleRef\.current = state\.volume/, 'not recorded on every render')
  assert.match(vs, /lastAudibleRef\.current = rememberLevel\(lastAudibleRef\.current, getPercent\(ev\.clientX\)\)/)
})
