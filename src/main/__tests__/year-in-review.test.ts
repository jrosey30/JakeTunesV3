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

  it('range: artists and current-tag genres played, and the widest day (Jake 10/29: variety)', () => {
    // Plays: Geese ×4 (Jun 2, 3, 4 ×2), Beatles ×1 (Jun 10). Every listen is tagged Rock in the
    // log; the library carries no genre, so the logged tag counts.
    assert.equal(yir.range.artists, 2)
    assert.equal(yir.range.genres, 1)
    // June 4 has two Geese plays, June 10 one Beatles play: both one genre, one artist each → the earlier day.
    assert.deepEqual(yir.range.widestDay, { date: '2026-06-02', genres: 1, artists: 1, plays: 1 })
    const wide = buildYearInReview({
      year: 2026, library: [{ id: 7, title: 'Song', artist: 'X', genre: 'Shoegaze' }],
      listens: [
        L('2026-07-01T16:00:00Z', 'A', 'a', 'play', { genre: 'Rock' }),
        L('2026-07-02T16:00:00Z', 'A', 'a', 'play', { genre: 'Rock' }),
        L('2026-07-02T17:00:00Z', 'B', 'b', 'play', { genre: 'Jazz' }),
        // The song's current tag wins over the retired one in the log.
        L('2026-07-02T18:00:00Z', 'X', 'Song', 'play', { genre: 'Rock', trackId: 7 }),
        L('2026-07-02T19:00:00Z', 'B', 'b', 'skip', { genre: 'Polka' }),
      ],
    })
    assert.deepEqual(wide.range, { artists: 3, genres: 3, widestDay: { date: '2026-07-02', genres: 3, artists: 3, plays: 3 } })
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
    const { byHour, topByHour, top, ...day } = yir.totals.biggestDay
    assert.deepEqual(day, { date: '2026-06-04', plays: 2, firstHour: 12, lastHour: 13 })
    // The hour strip: that day's plays by local hour, each hour's top song (12:00 Taxes, 13:00 Cobra).
    assert.equal(byHour?.length, 24)
    assert.equal(byHour?.[12], 1)
    assert.equal(byHour?.[13], 1)
    assert.deepEqual(topByHour?.[12], { artist: 'Geese', title: 'Taxes' })
    assert.deepEqual(topByHour?.[13], { artist: 'Geese', title: 'Cobra' })
    assert.equal(topByHour?.[3], null)
    assert.deepEqual(top, { artist: 'Geese', title: 'Taxes' }, 'a tie keeps the first played')
  })

  it('the calendar: every day with music, its plays and its most-played song', () => {
    assert.deepEqual(yir.calendar?.['2026-06-04'], { plays: 2, artist: 'Geese', title: 'Taxes' })
    assert.deepEqual(yir.calendar?.['2026-06-10'], { plays: 1, artist: 'The Beatles', title: 'Hey Jude' })
    assert.deepEqual(Object.keys(yir.calendar ?? {}), ['2026-06-02', '2026-06-03', '2026-06-04', '2026-06-10'])
  })

  it('on repeat: the most plays one song got inside a week', () => {
    assert.deepEqual(yir.onRepeat, { artist: 'Geese', title: 'Taxes', plays: 3, weekOf: '2026-06-02' })
  })

  it('discoveries: only what came in through a JakeTunes store this year — an import is not a find', () => {
    assert.deepEqual(yir.discoveries.newArtists.map((a) => a.name), ['Geese'])
    assert.equal(yir.discoveries.foundTotal, 2)
    assert.deepEqual(yir.discoveries.foundByMonth, { '06': 2 })
  })

  it('starred class: found this year and starred — a starred import does not count', () => {
    assert.equal(yir.starredClass.count, 1)
    assert.equal(yir.starredClass.top[0].name, 'Taxes')
  })

  it('the star is binary: a legacy 2-star find is starred, an unstarred find is not (Jake 10/12)', () => {
    const legacy = library.map((t) => (t.id === 2 ? { ...t, rating: 2 } : t))
    const y = buildYearInReview({ year: 2026, listens, library: legacy })
    assert.equal(y.starredClass.count, 2)
    assert.deepEqual(y.starredClass.top.map((s) => s.name), ['Taxes', 'Cobra'])
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

describe('nothing under a minute ranks (Jake 9/2 for Top 25; every ranking 10/11)', () => {
  it('a 16-second intro played a lot never takes a top-song or song-of-the-month slot — its plays still count', () => {
    const library = [
      { id: 1, title: '...Unless', artist: 'MUNA', album: 'Dancing on the Wall', duration: 16000, dateAdded: '2026-02-01T12:00:00Z' },
      { id: 2, title: 'Silk Chiffon', artist: 'MUNA', album: 'MUNA', duration: 205000, dateAdded: '2026-02-01T12:00:00Z' },
    ]
    const listens: Listen[] = [
      ...[1, 2, 3, 4, 5].map((d) => L(`2026-03-0${d}T16:00:00Z`, 'MUNA', '...Unless', 'play', { trackId: 1 })),
      L('2026-03-06T16:00:00Z', 'MUNA', 'Silk Chiffon', 'play', { trackId: 2 }),
    ]
    const r = buildYearInReview({ year: 2026, listens, library } as never)
    assert.deepEqual(r.topSongs.map((s: { name: string }) => s.name), ['Silk Chiffon'])
    assert.equal(r.topArtists[0].plays, 6, 'every play still counts for the artist')
  })
})

describe('the starred class ranks no song under a minute (Jake 10/11)', () => {
  it('a starred 16-second find is left off the list entirely, not sunk to the bottom — the tally still counts it', () => {
    const library = [
      { id: 1, title: '...Unless', artist: 'MUNA', album: 'Dancing on the Wall', duration: 16000, dateAdded: '2026-06-01T12:00:00Z', rating: 5, source: 'streamrip' },
      { id: 2, title: 'Silk Chiffon', artist: 'MUNA', album: 'MUNA', duration: 205000, dateAdded: '2026-06-01T12:00:00Z', rating: 5, source: 'streamrip' },
      // Unknown length stays rankable (never punish missing metadata).
      { id: 3, title: 'Mystery', artist: 'MUNA', album: 'MUNA', dateAdded: '2026-06-01T12:00:00Z', rating: 5, source: 'streamrip' },
    ]
    const listens: Listen[] = [
      ...[1, 2, 3, 4, 5].map((d) => L(`2026-06-0${d}T16:00:00Z`, 'MUNA', '...Unless', 'play', { trackId: 1 })),
      L('2026-06-06T16:00:00Z', 'MUNA', 'Silk Chiffon', 'play', { trackId: 2 }),
    ]
    const y = buildYearInReview({ year: 2026, listens, library })
    assert.deepEqual(y.starredClass.top.map((s) => s.name), ['Silk Chiffon', 'Mystery'])
    assert.equal(y.starredClass.count, 3, 'the tally of starred finds is not a ranking')
  })
})

describe('the story slides\' facts (10/12)', () => {
  it('how deep: each play lands on its genre\'s iceberg layer; Soundtrack and untagged sit off the berg', () => {
    const listens = [
      L('2026-06-02T16:00:00Z', 'Nirvana', 'Lithium', 'play', { genre: 'Rock' }),
      L('2026-06-02T17:00:00Z', 'Nirvana', 'Lithium', 'play', { genre: 'Grunge' }),
      L('2026-06-02T18:00:00Z', 'Ty Segall', 'Finger', 'play', { genre: 'Garage Punk' }),
      L('2026-06-02T19:00:00Z', 'Hans Zimmer', 'Time', 'play', { genre: 'Soundtrack' }),
      L('2026-06-02T20:00:00Z', 'Nobody', 'Untitled', 'play', { genre: '' }),
    ]
    const y = buildYearInReview({ year: 2026, listens, library: [] })
    assert.equal(y.depth.layers[0], 1, 'Rock is the tip')
    assert.equal(y.depth.layers[4], 1, 'Garage Punk is the abyss')
    assert.equal(y.depth.layers.reduce((a, b) => a + b, 0), 3)
    assert.equal(y.depth.offBerg, 2)
  })

  it('the song of the year carries its own best week, not some other song\'s', () => {
    const listens = [
      ...['06-01', '06-02', '06-03', '07-20', '07-21', '07-22', '07-23'].map((d) => L(`2026-${d}T16:00:00Z`, 'TV Girl', 'Pantyhose')),
      ...['08-01', '08-01', '08-01', '08-01', '08-02', '08-02'].map((d, i) => L(`2026-${d}T1${i}:00:00Z`, 'Geese', 'Taxes')),
    ]
    const y = buildYearInReview({ year: 2026, listens, library: [] })
    assert.equal(y.topSongs[0].name, 'Pantyhose')
    assert.deepEqual(y.songOfTheYearBestWeek, { plays: 4, weekOf: '2026-07-20' })
    assert.equal(y.onRepeat?.title, 'Taxes', 'on repeat is still the whole year\'s best week')
  })
})
