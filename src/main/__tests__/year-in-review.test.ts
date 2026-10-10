/**
 * Year in Review facts (src/common/year-in-review.ts) — Class A only: plays
 * and library records, evidence attached, coverage stated.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildYearInReview, localParts } from '../../common/year-in-review.ts'
import type { Listen } from '../../common/listening-history.ts'

const L = (ts: string, artist: string, title: string, kind: Listen['kind'] = 'play', extra: Partial<Listen> = {}): Listen =>
  ({ ts, device: 'laptop', kind, pct: kind === 'play' ? 100 : 10, artist, title, album: `${title} LP`, genre: 'Rock', ...extra })

describe('calendar facts are in Jake\'s zone', () => {
  it('a 03:30 UTC play is the evening before in New York', () => {
    const p = localParts('2026-10-10T03:30:00Z')
    assert.equal(p.date, '2026-10-09')
    assert.equal(p.hour, 23)
    assert.equal(p.weekday, 5)
  })
})

describe('the facts', () => {
  const library = [
    { id: 1, title: 'Taxes', artist: 'Geese', album: 'Getting Killed', duration: 197000, dateAdded: '2026-06-01T12:00:00Z', rating: 5, source: 'streamrip' },
    { id: 2, title: 'Cobra', artist: 'Geese', album: 'Getting Killed', duration: 180000, dateAdded: '2026-06-01T12:00:00Z', source: 'streamrip' },
    { id: 3, title: 'Hey Jude', artist: 'The Beatles', album: 'Past Masters', duration: 431000, dateAdded: '2025-03-01T12:00:00Z', rating: 5 },
    // The collection moving into JakeTunes: a 2026 add date, no store source.
    { id: 4, title: 'Something', artist: 'The Beatles', album: 'Abbey Road', duration: 182000, dateAdded: '2026-04-20T12:00:00Z', rating: 5 },
  ]
  const listens: Listen[] = [
    L('2026-06-02T16:00:00Z', 'Geese', 'Taxes', 'play', { trackId: 1 }),
    L('2026-06-03T16:00:00Z', 'Geese', 'Taxes', 'play', { trackId: 1 }),
    L('2026-06-04T16:00:00Z', 'Geese', 'Taxes', 'play', { trackId: 1 }),
    L('2026-06-04T17:00:00Z', 'Geese', 'Cobra', 'play', { trackId: 2 }),
    L('2026-06-10T16:00:00Z', 'The Beatles', 'Hey Jude', 'play', { trackId: 3, pct: 50 }),
    L('2026-06-10T17:00:00Z', 'The Beatles', 'Hey Jude', 'skip'),
    L('2026-06-10T17:05:00Z', 'Geese', 'Cobra', 'glance'),
    L('2026-06-10T17:06:00Z', 'Geese', 'Cobra', 'mechanical'),
    L('2025-12-31T16:00:00Z', 'The Beatles', 'Hey Jude', 'play', { trackId: 3 }),
  ]
  const yir = buildYearInReview({
    year: 2026, listens, library,
    concerts: [
      { artist: 'Geese', album: 'Forest Hills', createdAt: '2026-10-09T00:45:00Z', notes: 'I was there.', mergedTrackId: 99 },
      { artist: 'Old', album: 'Show', createdAt: '2025-05-01T00:00:00Z' },
    ],
    mixtapes: [{ title: 'METAL VOL 1', createdAt: '2026-08-09T00:00:00Z', songs: 19 }, { title: 'old', createdAt: '2025-01-01T00:00:00Z', songs: 3 }],
  })

  it('counts plays only, this year only', () => {
    assert.equal(yir.totals.plays, 5)
    assert.deepEqual(yir.honesty, { skips: 1, glances: 1, mechanical: 1, realSkipRate: Math.round((1 / 6) * 10000) / 10000 })
  })

  it('tops rank by plays; minutes follow length × share played', () => {
    assert.deepEqual(yir.topSongs[0], { name: 'Taxes', artist: 'Geese', plays: 3, minutes: (197000 * 3) / 60000 })
    assert.equal(yir.topArtists[0].name, 'Geese')
    assert.equal(yir.topArtists[0].plays, 4)
    assert.equal(yir.totals.minutes, Math.round((197000 * 3 + 180000 + 431000 * 0.5) / 60000))
    assert.equal(yir.totals.minutesKnownFor, 5)
  })

  it('days, streak and the biggest day', () => {
    assert.equal(yir.totals.daysListened, 4)
    assert.deepEqual(yir.totals.longestStreak, { days: 3, from: '2026-06-02', to: '2026-06-04' })
    assert.deepEqual(yir.totals.biggestDay, { date: '2026-06-04', plays: 2, firstHour: 12, lastHour: 13 })
  })

  it('on repeat: the most plays one song got inside a week', () => {
    assert.deepEqual(yir.onRepeat, { artist: 'Geese', title: 'Taxes', plays: 3, weekOf: '2026-06-02' })
  })

  it('discoveries: only what came in through a JakeTunes store this year — an import is not a find', () => {
    assert.deepEqual(yir.discoveries.newArtists.map((a) => a.name), ['Geese'])
    assert.equal(yir.discoveries.foundTotal, 2)
    assert.deepEqual(yir.discoveries.foundByMonth, { '06': 2 })
  })

  it('starred class: found this year and 4+ stars — a starred import does not count', () => {
    assert.equal(yir.starredClass.count, 1)
    assert.equal(yir.starredClass.top[0].name, 'Taxes')
  })

  it('coverage says which months the history does not reach', () => {
    assert.deepEqual(yir.coverage.monthsBeforeHistory, ['01', '02', '03', '04', '05'])
    assert.deepEqual(yir.coverage.monthsWithPlays, ['06'])
    assert.equal(yir.months[0].topArtist?.name, 'Geese')
  })

  it('concerts and tapes are this year\'s', () => {
    assert.deepEqual(yir.concerts.map((c) => c.album), ['Forest Hills'])
    assert.equal(yir.concerts[0].notes, 'I was there.')
    assert.deepEqual(yir.mixtapes.map((m) => m.title), ['METAL VOL 1'])
  })
})
