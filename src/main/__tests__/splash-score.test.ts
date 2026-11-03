import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOOM_ATTACK_MS,
  NOTE_ONSET_MS,
  NOTE_RING_MS,
  launchScore,
  songOrigin,
} from '../../common/splash-score.ts'
import {
  ERA_FADE_MS,
  ERA_STEP_MS,
  SPLASH_ERAS,
  T_ASSEMBLE,
  T_LINEAGE,
  T_LIT,
  T_SETTLE,
  eraAt,
  eraStartMs,
} from '../../common/splash-eras.ts'

// The launch song is scored to the logo lineage (2026-11-03, Jake: "the
// launching page song needs to flow better with the logo evolution"). These
// pin the relationship between the picture and the song, so neither can move
// without the other.

const score = launchScore()

test('every mark has exactly one note, oldest mark first', () => {
  assert.deepEqual(score.cues.map((c) => c.era), SPLASH_ERAS.map((e) => e.key))
})

test("each note starts just inside its mark's dissolve", () => {
  score.cues.forEach((cue, i) => {
    assert.equal(cue.atMs, eraStartMs(i) + NOTE_ONSET_MS)
    // At the note's onset, the boot is showing that mark dissolving in (or
    // holding), not the one before it.
    const frame = eraAt(cue.atMs - T_LINEAGE)
    assert.equal(frame.index, i, `cue ${cue.note} lands on era ${frame.index}, not ${i}`)
    assert.ok(NOTE_ONSET_MS < ERA_FADE_MS, 'the note starts inside the dissolve')
  })
})

test('the notes walk on the marks’ beat — one step apart, no second tempo', () => {
  for (let i = 1; i < score.cues.length; i++) {
    assert.equal(score.cues[i]!.atMs - score.cues[i - 1]!.atMs, ERA_STEP_MS)
  }
})

test("the melody is Jake's welcome, carried on up the E major triad", () => {
  assert.deepEqual(score.cues.map((c) => c.note), ['E3', 'G#3', 'B3', 'E4', 'G#4'])
  // The first three are the pitches the welcome has played since June 2026.
  assert.deepEqual(score.cues.slice(0, 3).map((c) => c.freq), [164.81, 207.65, 246.94])
  for (let i = 1; i < score.cues.length; i++) assert.ok(score.cues[i]!.freq > score.cues[i - 1]!.freq, 'it rises')
  // Every pitch is E, G# or B (within a cent of equal temperament).
  const pc = (f: number): number => ((Math.round(12 * Math.log2(f / 440)) % 12) + 12) % 12
  for (const c of score.cues) assert.ok([7, 11, 2].includes(pc(c.freq)), `${c.note} is in the E major triad`)
})

test('the sound evolves the way the marks do', () => {
  assert.deepEqual(score.cues.map((c) => c.color), ['warm', 'music-box', 'brush', 'chip', 'pixel'])
})

test("the chord's attack peaks on the note's light, after the last mark lands", () => {
  assert.equal(score.bloomAtMs + BLOOM_ATTACK_MS, T_LIT)
  assert.ok(score.bloomAtMs > T_ASSEMBLE - 120, 'the chord comes as the light rises, not before the mark is in')
  assert.ok(score.bloomAtMs < T_SETTLE)
  assert.ok(score.bloomAtMs > score.cues[score.cues.length - 1]!.atMs)
})

test('every note rings on under the next and into the bloom', () => {
  assert.equal(score.ringMs, NOTE_RING_MS)
  for (const c of score.cues) assert.ok(c.atMs + score.ringMs > score.bloomAtMs + 1000, `${c.note} is still ringing at the bloom`)
})

test('the song outlasts its curtain before its audio closes', () => {
  assert.ok(score.endMs >= score.bloomAtMs + 4400)
})

// ── songOrigin: the audio clock's time of the boot's 0 ──

test('with a live output timestamp the boot maps exactly onto the audio clock', () => {
  // The sample at context 1.200 s is heard at performance 5000 ms; the boot began at 4900 ms.
  const t0 = songOrigin({ contextTime: 1.2, performanceTime: 5000, currentTime: 1.21, nowPerfMs: 5010 }, 4900, 190)
  assert.ok(Math.abs(t0 - 1.1) < 1e-9)
})

test('without one it falls back to currentTime', () => {
  const t0 = songOrigin({ contextTime: 0, performanceTime: 0, currentTime: 2, nowPerfMs: 3050 }, 3000, 190)
  assert.ok(Math.abs(t0 - 1.95) < 1e-9)
})

test('never a negative time — Web Audio throws on one and the song would not play at all', () => {
  // A context that is 0.05 s old when the boot is already 0.12 s in (found in the harness).
  const t0 = songOrigin({ contextTime: 0, performanceTime: 0, currentTime: 0.05, nowPerfMs: 1120 }, 1000, 190)
  assert.ok(t0 >= 0)
})

test('a first note already past is shifted to start whole, not clipped', () => {
  // The boot began 0.5 s ago; the first note (0.19 s) has passed on the mapped clock.
  const t0 = songOrigin({ contextTime: 3, performanceTime: 9500, currentTime: 3, nowPerfMs: 9500 }, 9000, 190)
  assert.ok(t0 + 0.19 >= 3 + 0.02 - 1e-9)
})
