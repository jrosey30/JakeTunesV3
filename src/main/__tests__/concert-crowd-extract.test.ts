import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidateStarts, scoreWindow, CLIP_SECONDS } from '../concert-crowd-extract.ts'

test('candidates cover every seam, both edges, and stay inside the show', () => {
  const cues = [0, 200_000, 450_000]
  const total = 700_000
  const c = candidateStarts(cues, total)
  assert.ok(c.length > 20)
  assert.ok(c.every((s) => s >= 0 && s <= total / 1000 - CLIP_SECONDS))
  assert.ok(c.includes(199) && c.includes(210), 'just after the first seam')
  assert.ok(!c.includes(190), 'never back inside the previous song')
  assert.ok(c.includes(449) && c.includes(460), 'just after the second seam')
  assert.ok(c.includes(0), 'the walk-on')
  assert.ok(c.includes(693), 'the walk-off')
  assert.deepEqual(candidateStarts([0], 3_000), [], 'too short → nothing')
})

test('a broadband room at a sane level beats music, silence, and the mix', () => {
  const room = scoreWindow({ startSec: 0, flatness: 0.42, flatnessSd: 0.05, rmsDb: -26, rmsSd: 1.2 })
  const music = scoreWindow({ startSec: 0, flatness: 0.08, flatnessSd: 0.03, rmsDb: -14, rmsSd: 2.5 })
  assert.equal(music, -Infinity, 'tonal = music = never a room')
  const silence = scoreWindow({ startSec: 0, flatness: 0.9, flatnessSd: 0.0, rmsDb: -60, rmsSd: 0 })
  const loudMix = scoreWindow({ startSec: 0, flatness: 0.40, flatnessSd: 0.05, rmsDb: -8, rmsSd: 1 })
  const jumpy = scoreWindow({ startSec: 0, flatness: 0.42, flatnessSd: 0.30, rmsDb: -26, rmsSd: 9 })
  assert.ok(room > music, 'room beats music')
  assert.equal(silence, -Infinity, 'silence is out')
  assert.ok(room > loudMix, 'room beats the mix')
  assert.ok(room > jumpy, 'steady beats jumpy')
  assert.ok(room >= 1.0, 'a real room clears the floor')
})
