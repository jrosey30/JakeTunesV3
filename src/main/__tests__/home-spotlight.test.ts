/**
 * Launch page "G" spotlight rules (2026-10-18).
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/homeSpotlight.ts carries the same rules.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { livingInAlbum, artistFacts, nowDigging, headlineFor, statsLine, DAY_MS, type SpotTrack, type SpotPlay } from '../../common/home-spotlight.ts'

const NOW = Date.UTC(2026, 9, 18, 22, 0, 0)
const T: SpotTrack[] = [
  { id: 1, title: 'Taxes', artist: 'Geese', album: 'Getting Killed', dateAdded: '2026-08-09T12:00:00Z', year: 2025 },
  { id: 2, title: 'Trinidad', artist: 'Geese', album: 'Getting Killed', dateAdded: '2026-08-09T12:00:00Z', year: 2025 },
  { id: 3, title: 'Gimme Gimme Gimme', artist: 'ABBA', album: 'Greatest Hits', dateAdded: '2026-10-01T12:00:00Z', year: 1979 },
  { id: 4, title: 'Hitachi', artist: 'ADÉLA', album: 'Hitachi', dateAdded: '2026-09-05T12:00:00Z', year: 2026 },
  { id: 5, title: 'Old Fave', artist: 'Steely Dan', album: "Can't Buy A Thrill", dateAdded: '2020-01-01T12:00:00Z', year: 1972 },
  { id: 6, title: 'Comp Track', artist: 'Someone', albumArtist: 'Various Artists', album: 'Now 99', dateAdded: '2026-10-10T12:00:00Z', year: 2026 },
]
const at = (daysAgo: number, id: number): SpotPlay => ({ id, ts: NOW - daysAgo * DAY_MS - 60_000 })
const P: SpotPlay[] = [
  ...Array.from({ length: 6 }, (_, i) => at(2, 1)), at(3, 2), at(9, 1),
  at(1, 3), at(1, 3), at(1, 3), at(1, 3),
  at(4, 4), at(5, 4), at(6, 4),
  at(2, 5), at(2, 5), at(2, 5), at(2, 5), at(2, 5),
  at(1, 6), at(1, 6), at(1, 6), at(1, 6), at(1, 6), at(1, 6),
]

test('the album you are living in: most plays in 14 days, never a compilation', () => {
  const a = livingInAlbum(T, P, NOW)
  assert.ok(a)
  assert.equal(a.artist, 'Geese')
  assert.equal(a.album, 'Getting Killed')
  assert.equal(a.plays, 8)
  assert.equal(a.windowDays, 14)
})

test('nothing played enough → no spotlight (the page falls back, never invents)', () => {
  assert.equal(livingInAlbum(T, [at(1, 1), at(2, 1)], NOW), null)
})

test('artist facts: 30-day plays, top song, first heard = earliest add or play', () => {
  const f = artistFacts(T, P, NOW, 'Geese')
  assert.equal(f.plays30, 8)
  assert.deepEqual(f.topSong, { title: 'Taxes', plays: 7 })
  assert.equal(new Date(f.firstHeardTs!).toISOString().slice(0, 10), '2026-08-09')
  assert.equal(f.days.length, 30)
  assert.equal(f.days.reduce((s, n) => s + n, 0), 8)
})

test('now digging: new + not legacy + ≥3 plays, ranked by plays; legacy and old favourites stay out', () => {
  const debut = (a: string) => (a === 'ABBA' ? 1972 : a === 'Geese' ? 2018 : null)
  const d = nowDigging(T, P, NOW, { debutYear: debut })
  assert.deepEqual(d.map((e) => e.artist), ['Geese', 'ADÉLA'])
  assert.equal(d[0].debutSource, 'musicbrainz')
  assert.equal(d[1].debutSource, 'library')
})

test('copy is deterministic and only states the facts', () => {
  assert.equal(headlineFor('Geese', 81), 'Geese has your attention.')
  assert.equal(headlineFor('Geese', 16), "You can't stop playing Geese.")
  assert.equal(headlineFor('Geese', 6), "Lately, it's Geese.")
  const line = statsLine(artistFacts(T, P, NOW, 'Geese'))
  assert.equal(line, '8 plays in 30 days · “Taxes” on repeat · with you since Aug 9')
})
