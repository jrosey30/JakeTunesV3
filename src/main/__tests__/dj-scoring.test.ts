import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  judge, multiplierFor, emptyRun, applyHit, accuracy, buildPrompts, matchPrompt,
  WINDOWS, POINTS, type Prompt,
} from '../../renderer/dj/scoring.ts'

test('judgement windows are symmetric around the beat', () => {
  assert.equal(judge(0), 'perfect')
  assert.equal(judge(-WINDOWS.perfect), 'perfect')
  assert.equal(judge(WINDOWS.perfect + 0.001), 'great')
  assert.equal(judge(-WINDOWS.great), 'great')
  assert.equal(judge(WINDOWS.great + 0.001), 'good')
  assert.equal(judge(WINDOWS.good + 0.001), 'miss')
  assert.equal(judge(-5), 'miss')
})

test('a miss resets the streak; a hit extends it', () => {
  let s = emptyRun()
  s = applyHit(s, 'perfect')
  s = applyHit(s, 'great')
  assert.equal(s.streak, 2)
  s = applyHit(s, 'miss')
  assert.equal(s.streak, 0)
  assert.equal(s.best, 2, 'best streak survives the reset')
})

test('the multiplier applies from the streak BEFORE the hit', () => {
  // Scoring a hit at the multiplier it just earned would let one lucky note
  // retroactively pay out at the new tier.
  let s = emptyRun()
  for (let i = 0; i < 8; i++) s = applyHit(s, 'perfect')
  assert.equal(s.score, 8 * POINTS.perfect * 1)
  assert.equal(multiplierFor(s.streak), 2)
  s = applyHit(s, 'perfect')
  assert.equal(s.score, 8 * POINTS.perfect + POINTS.perfect * 2)
})

test('multiplier tiers cap at 4x', () => {
  assert.equal(multiplierFor(0), 1)
  assert.equal(multiplierFor(7), 1)
  assert.equal(multiplierFor(8), 2)
  assert.equal(multiplierFor(16), 3)
  assert.equal(multiplierFor(32), 4)
  assert.equal(multiplierFor(9999), 4)
})

test('a miss scores nothing', () => {
  const s = applyHit(emptyRun(), 'miss')
  assert.equal(s.score, 0)
  assert.equal(s.hits.miss, 1)
})

test('accuracy is earned over attempted, and safe when nothing was played', () => {
  assert.equal(accuracy(emptyRun()), 0)
  let s = emptyRun()
  s = applyHit(s, 'perfect')
  s = applyHit(s, 'perfect')
  assert.equal(accuracy(s), 100)
  s = applyHit(s, 'miss')
  assert.equal(accuracy(s), 67)
})

test('prompts land on phrase boundaries, not scattered beats', () => {
  // 120 BPM, 4/4: a 4-bar phrase is 16 beats = 8 seconds.
  const p = buildPrompts({ bpm: 120, from: 0, to: 40, deck: 'A' })
  assert.ok(p.length > 2)
  for (let i = 1; i < p.length; i++) {
    assert.ok(Math.abs((p[i].time - p[i - 1].time) - 8) < 1e-6, 'phrase spacing')
  }
  assert.ok(p.every((x) => x.deck === 'A'))
})

test('prompts rotate through the moves instead of hammering one key', () => {
  const p = buildPrompts({ bpm: 120, from: 0, to: 100, deck: 'B' })
  assert.ok(new Set(p.slice(0, 4).map((x) => x.action)).size === 4)
})

test('a bad BPM yields no prompts rather than an infinite chart', () => {
  assert.deepEqual(buildPrompts({ bpm: 0, from: 0, to: 100, deck: 'A' }), [])
})

test('an input matches the nearest unresolved prompt OF THAT ACTION', () => {
  const prompts: Prompt[] = [
    { id: 0, time: 10.00, action: 'bass-kill', deck: 'A' },
    { id: 1, time: 10.05, action: 'crossfade', deck: 'A' },
  ]
  const none = new Set<number>()
  // Hitting the crossfade slightly early must not consume the bass-kill that
  // sits right next to it, or the whole run desyncs from the chart.
  assert.equal(matchPrompt(prompts, none, 'crossfade', 10.01)?.id, 1)
  assert.equal(matchPrompt(prompts, none, 'bass-kill', 10.01)?.id, 0)
})

test('a resolved prompt cannot be hit twice', () => {
  const prompts: Prompt[] = [{ id: 0, time: 10, action: 'filter', deck: 'A' }]
  assert.equal(matchPrompt(prompts, new Set([0]), 'filter', 10)?.id, undefined)
})

test('an input miles from any prompt matches nothing', () => {
  const prompts: Prompt[] = [{ id: 0, time: 10, action: 'filter', deck: 'A' }]
  assert.equal(matchPrompt(prompts, new Set(), 'filter', 14), null)
})
