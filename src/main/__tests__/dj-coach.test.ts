import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beatPhase, phaseDelta, isPhaseLocked, secondsToNextPhrase,
} from '../../renderer/dj/beatgrid.ts'
import { advise, assessPairing, type DeckReading } from '../../renderer/dj/coach.ts'

const deck = (o: Partial<DeckReading> = {}): DeckReading => ({
  loaded: true, playing: true, position: 0, bpm: 120, beatOffset: 0, rate: 1,
  bassKilled: false, ...o,
})

test('beat phase is where you sit inside the beat', () => {
  assert.equal(beatPhase(0, 120), 0)
  assert.equal(beatPhase(0.5, 120), 0)      // exactly one beat later
  assert.ok(Math.abs(beatPhase(0.25, 120) - 0.5) < 1e-9)
  assert.equal(beatPhase(0, 0), 0)
})

test('phase delta is signed and wraps the SHORT way', () => {
  // 0.9 of a beat late is really 0.1 early. Sending someone the long way round
  // would have them slow down to fix a deck that is already ahead.
  const d = phaseDelta(0, 120, 0, 0.45, 120, 0)
  assert.ok(d > -0.5 && d <= 0.5, `wrapped to ${d}`)
  assert.ok(Math.abs(d - 0.1) < 1e-9)
})

test('identical decks are locked', () => {
  assert.ok(isPhaseLocked(phaseDelta(3.7, 128, 0.2, 3.7, 128, 0.2)))
})

test('a deck a quarter-beat out is NOT locked', () => {
  assert.ok(!isPhaseLocked(phaseDelta(0, 120, 0, 0.125, 120, 0)))
})

test('countdown to the next phrase line', () => {
  // 120 BPM, 4/4, 4-bar phrase = 8s.
  assert.ok(Math.abs(secondsToNextPhrase(0, 120) - 0) < 1e-9)
  assert.ok(Math.abs(secondsToNextPhrase(2, 120) - 6) < 1e-9)
  assert.ok(Math.abs(secondsToNextPhrase(7.5, 120) - 0.5) < 1e-9)
  assert.equal(secondsToNextPhrase(5, 0), Infinity)
})

test('coach asks for a record before anything else', () => {
  assert.equal(advise(deck({ loaded: false }), deck({ loaded: false })).step, 'idle')
  assert.equal(advise(deck(), deck({ loaded: false })).step, 'load')
})

test('tempo is corrected before phase', () => {
  // A phase alignment made against a different tempo drifts apart within a bar,
  // so telling someone to nudge first would teach a wasted motion.
  const a = advise(deck({ bpm: 120 }), deck({ bpm: 128, playing: false }))
  assert.equal(a.step, 'tempo')
  assert.match(a.instruction, /SYNC/)
})

test('once tempo matches, it calls the phase and the DIRECTION', () => {
  // Incoming is behind -> speed up. Getting this backwards would drill the
  // wrong reflex, which is why it is asserted rather than eyeballed.
  const behind = advise(
    deck({ bpm: 120, position: 0 }),
    deck({ bpm: 120, position: -0.15 + 0.5 }),   // 0.35 -> behind by 0.3 beat
  )
  assert.equal(behind.step, 'phase')
  assert.equal(behind.nudge, 1)
  // Wording is plain-language now, but it must still name the direction and
  // point at the matching control — the nudge value alone could be right while
  // the sentence tells you to do the opposite.
  assert.match(behind.instruction, /behind/i)
  assert.match(behind.instruction, /NUDGE \+/)

  const ahead = advise(
    deck({ bpm: 120, position: 0 }),
    deck({ bpm: 120, position: 0.15 }),          // 0.3 beat early
  )
  assert.equal(ahead.step, 'phase')
  assert.equal(ahead.nudge, -1)
  assert.match(ahead.instruction, /ahead/i)
  assert.match(ahead.instruction, /NUDGE −/)
})

test('locked and in phase, it moves on to the bass', () => {
  const a = advise(deck({ bpm: 120, position: 4 }), deck({ bpm: 120, position: 4 }))
  assert.equal(a.step, 'bring-in')
  assert.match(a.why, /mud|headroom/i)
})

test('with the bass out of the way it teaches the swap on a phrase line', () => {
  const a = advise(
    deck({ bpm: 120, position: 4 }),
    deck({ bpm: 120, position: 4, bassKilled: true }),
  )
  assert.equal(a.step, 'bass-swap')
  assert.ok(typeof a.countdown === 'number')
})

test('every step explains WHY, not just what', () => {
  const steps = [
    advise(deck({ loaded: false }), deck({ loaded: false })),
    advise(deck(), deck({ loaded: false })),
    advise(deck({ bpm: 120 }), deck({ bpm: 128, playing: false })),
    advise(deck({ bpm: 120, position: 0 }), deck({ bpm: 120, position: 0.15 })),
    advise(deck({ bpm: 120, position: 4 }), deck({ bpm: 120, position: 4 })),
  ]
  for (const s of steps) {
    assert.ok(s.why && s.why.length > 25, `step ${s.step} has no real explanation`)
    assert.ok(s.instruction.length > 0)
  }
})

test('pairing assessment is honest about a bad match', () => {
  const good = assessPairing({ bpm: 120, camelotKey: '8A' }, { bpm: 121, camelotKey: '9A' })
  assert.ok(good.ok)
  assert.match(good.keyNote, /compatible/)

  const clash = assessPairing({ bpm: 120, camelotKey: '8A' }, { bpm: 121, camelotKey: '2A' })
  assert.ok(!clash.ok)
  assert.match(clash.keyNote, /clash/)

  const farApart = assessPairing({ bpm: 120, camelotKey: '8A' }, { bpm: 160, camelotKey: '8A' })
  assert.ok(!farApart.ok)
  assert.match(farApart.tempoNote, /too far/)

  const unknown = assessPairing({ bpm: 120 }, { bpm: 121 })
  assert.ok(!unknown.ok)
  assert.match(unknown.keyNote, /unknown/)
})
