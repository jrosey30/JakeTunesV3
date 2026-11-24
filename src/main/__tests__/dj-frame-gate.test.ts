import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advise, type DeckReading } from '../../renderer/dj/coach.ts'
import { coachFrameKey, nextPlaying, waveFrameKey } from '../../renderer/dj/frameGate.ts'

// The DJ page used to render the whole view every animation frame while a deck
// played. These tests drive the same gates the frame loop uses over simulated
// frames and count how many renders they would ask for.

const deck = (o: Partial<DeckReading> = {}): DeckReading => ({
  loaded: true, playing: true, position: 0, bpm: 120, beatOffset: 0, rate: 1,
  bassKilled: false, ...o,
})

/** Renders the coach gate asks for over `seconds` at `hz`, both decks at 120 BPM. */
function coachRenders(seconds: number, hz: number, incoming: Partial<DeckReading>): number {
  let last = ''
  let renders = 0
  const start = incoming.position ?? 10
  for (let f = 0; f < seconds * hz; f++) {
    const t = f / hz
    const inPos = incoming.playing === false ? start : start + t
    const key = coachFrameKey(advise(deck({ position: 30 + t }), deck({ ...incoming, position: inPos })))
    if (key !== last) { renders++; last = key }
  }
  return renders
}

test('waiting to drop in: the countdown renders at its own tenths, not 60 a second', () => {
  const r = coachRenders(10, 60, { playing: false, position: 10 })
  // 10 s of a countdown shown to 0.1 s is about 100 changes; it was 600.
  assert.ok(r <= 110, `renders ${r}`)
  assert.ok(r >= 90, `the countdown still moves (${r})`)
})

test('locked in phase with the bass out: nothing on screen moves, so nothing renders', () => {
  const r = coachRenders(10, 60, { bassKilled: true, position: 30 })
  // bass-swap shows a countdown again; locked + bring-in shows none
  const still = coachRenders(10, 60, { position: 30 })
  assert.equal(still, 1)
  assert.ok(r <= 110, `renders ${r}`)
})

test('a faster screen asks for no more renders than a 60 Hz one', () => {
  const a = coachRenders(5, 60, { playing: false, position: 10 })
  const b = coachRenders(5, 120, { playing: false, position: 10 })
  assert.ok(Math.abs(a - b) <= 2, `60 Hz ${a}, 120 Hz ${b}`)
})

test('the coach key moves when what it prints moves', () => {
  const a = advise(deck({ position: 30 }), deck({ playing: false }))
  const b = advise(deck({ position: 30.2 }), deck({ playing: false }))
  assert.notEqual(coachFrameKey(a), coachFrameKey(b))
  const c = advise(deck({ position: 30.01 }), deck({ playing: false }))
  assert.equal(coachFrameKey(a), coachFrameKey(c))
  // drift is shown to 0.01 beat
  const d1 = advise(deck(), deck({ position: 0.1 }))
  const d2 = advise(deck(), deck({ position: 0.11 }))
  assert.notEqual(coachFrameKey(d1), coachFrameKey(d2))
})

test('playing state: the same object when unchanged, a new one when a deck starts', () => {
  const s = { A: true, B: false }
  assert.equal(nextPlaying(s, true, false), s)
  const n = nextPlaying(s, true, true)
  assert.notEqual(n, s)
  assert.deepEqual(n, { A: true, B: true })
})

test('waveform redraws only when the played edge crosses a pixel', () => {
  const base = { duration: 200, cssWidth: 400, cssHeight: 60, dpr: 2, cuePoint: 0, peaks: 1400, bpm: 120, beatOffset: 0 }
  let last = ''
  let draws = 0
  for (let f = 0; f < 600; f++) {               // 10 s at 60 Hz
    const k = waveFrameKey({ ...base, position: f / 60 })
    if (k !== last) { draws++; last = k }
  }
  // 800 device px over 200 s = 4 px a second: about 40 draws in 10 s, not 600.
  assert.ok(draws <= 42 && draws >= 38, `draws ${draws}`)
  // a cue or a resize redraws at once
  const k = waveFrameKey({ ...base, position: 5 })
  assert.notEqual(k, waveFrameKey({ ...base, position: 5, cuePoint: 5 }))
  assert.notEqual(k, waveFrameKey({ ...base, position: 5, cssWidth: 401 }))
})
