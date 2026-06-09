import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLogLines, computeListeningMemory, type PlayEvent } from '../listening-memory.ts'

// Fixed "now" for determinism: a local Wednesday evening.
const NOW = new Date(2026, 5, 10, 21, 30, 0) // 2026-06-10 21:30 local (June=5)

function play(daysAgo: number, hour: number, ar: string, opts?: Partial<PlayEvent>): PlayEvent {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, hour, 15, 0)
  return { t: 'p', ts: d.toISOString(), ar, al: 'A', g: 'Soul', ti: 'T', ...opts }
}
function skip(daysAgo: number, ar: string): PlayEvent {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, 12, 0, 0)
  return { t: 's', ts: d.toISOString(), ar, ti: 'T' }
}

test('parseLogLines: skips torn/corrupt lines, keeps valid events', () => {
  const text = [
    JSON.stringify(play(0, 9, 'Curtis Mayfield')),
    'not json at all',
    '{"t":"x","ts":"2026-01-01T00:00:00Z"}', // bad type
    '{"t":"p","ts":"garbage-date"}', // bad ts
    JSON.stringify(skip(1, 'Steely Dan')),
    '{"t":"p","ts":"2026-06-01T10:00:0', // torn tail
  ].join('\n')
  const events = parseLogLines(text)
  assert.equal(events.length, 2)
  assert.equal(events[0].ar, 'Curtis Mayfield')
  assert.equal(events[1].t, 's')
})

test('streak: counts consecutive days ending today', () => {
  const events = [play(0, 9, 'A'), play(1, 9, 'A'), play(2, 9, 'A'), play(5, 9, 'A')]
  const m = computeListeningMemory(events, NOW)
  assert.equal(m.streak.currentDays, 3)
  assert.equal(m.streak.bestDays, 3)
})

test('streak: alive if last play was yesterday; broken after a full silent day', () => {
  const alive = computeListeningMemory([play(1, 9, 'A'), play(2, 9, 'A')], NOW)
  assert.equal(alive.streak.currentDays, 2)
  const broken = computeListeningMemory([play(2, 9, 'A'), play(3, 9, 'A')], NOW)
  assert.equal(broken.streak.currentDays, 0)
  assert.equal(broken.streak.bestDays, 2)
})

test('clock: hour/weekday peaks need at least 10 plays', () => {
  const few = computeListeningMemory([play(0, 21, 'A'), play(1, 21, 'A')], NOW)
  assert.equal(few.clock.peakHourLabel, null)
  const many = Array.from({ length: 12 }, (_, i) => play(i % 3, 21, 'A'))
  const m = computeListeningMemory(many, NOW)
  assert.equal(m.clock.peakHourLabel, '9 PM')
  assert.ok(m.clock.byHour[21] >= 12)
})

test('rising: 7d plays must beat the prior 23 days', () => {
  const events = [
    // New obsession: 4 plays this week, none before.
    play(0, 9, 'MJ Lenderman'), play(1, 9, 'MJ Lenderman'), play(2, 9, 'MJ Lenderman'), play(3, 9, 'MJ Lenderman'),
    // Steady staple: 2 this week, 6 in the prior window — not "rising".
    play(0, 10, 'Steely Dan'), play(1, 10, 'Steely Dan'),
    ...Array.from({ length: 6 }, (_, i) => play(10 + i, 10, 'Steely Dan')),
  ]
  const m = computeListeningMemory(events, NOW)
  assert.equal(m.rising?.artist, 'MJ Lenderman')
})

test('comeback: surfaces a 60+ day gap ended this week', () => {
  const events = [play(2, 9, 'Bill Withers'), play(80, 9, 'Bill Withers'), play(0, 9, 'Daily Artist'), play(1, 9, 'Daily Artist')]
  const m = computeListeningMemory(events, NOW)
  assert.equal(m.comeback?.artist, 'Bill Withers')
  assert.ok((m.comeback?.gapDays || 0) >= 60)
})

test('binge: max same-artist plays in one day, floor of 5', () => {
  const four = computeListeningMemory(Array.from({ length: 4 }, () => play(1, 9, 'Wings')), NOW)
  assert.equal(four.binge, null)
  const six = computeListeningMemory(Array.from({ length: 6 }, (_, i) => play(1, 9 + i, 'Wings')), NOW)
  assert.equal(six.binge?.artist, 'Wings')
  assert.equal(six.binge?.plays, 6)
})

test('totals: skip rate + distinct artists + days active', () => {
  const events = [play(0, 9, 'A'), play(0, 10, 'B'), play(1, 9, 'a'), skip(0, 'C')]
  const m = computeListeningMemory(events, NOW)
  assert.equal(m.totals.plays, 3)
  assert.equal(m.totals.skips, 1)
  assert.equal(m.totals.skipRatePct, 25)
  assert.equal(m.totals.distinctArtists, 2) // 'A' and 'a' fold together
  assert.equal(m.totals.daysActive, 2)
})

test('empty log produces a quiet, non-crashing shape', () => {
  const m = computeListeningMemory([], NOW)
  assert.equal(m.totals.plays, 0)
  assert.equal(m.streak.currentDays, 0)
  assert.equal(m.clock.peakHourLabel, null)
  assert.equal(m.rising, null)
  assert.equal(m.comeback, null)
  assert.equal(m.binge, null)
})
