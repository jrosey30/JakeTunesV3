/**
 * The artist page's Live section as a poster wall (Jake 2026-10-18, on the
 * Geese page: "needs to be displayed via poster presentation"). Which live
 * items, in what order, and one tile per show: a declared concert's merged
 * track and constituents (promoted ones included) never also appear as an
 * album anywhere on the page.
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  declaredConcerts, concertTrackIds, parseConcertMeta, firstNightMs,
  type ConcertSetLike, type ConcertTrackLike,
} from '../../common/concert-meta.ts'
import {
  withoutConcertTracks, concertsByPersona, buildLiveWall, withLiveWall, liveAlbumMeta,
} from '../../common/artist-live-wall.ts'
import { groupByReleaseKind } from '../../common/release-sections.ts'
import { classifyRelease, type ReleaseKind } from '../../common/release-kind.ts'

interface T extends ConcertTrackLike { id: number; title: string; artist: string; album: string; year: number }
interface Group { name: string; year: number; tracks: T[] }

let nextId = 1
function album(artist: string, name: string, year: number, titles: string[]): T[] {
  return titles.map((title) => ({ id: nextId++, title, artist, album: name, year }))
}
function merged(artist: string, show: string, year: number): T {
  return { id: nextId++, title: `${show} — Full Set`, artist, album: `${show} (Live Set)`, year }
}
function setOf(tracks: T[], m: T, extra: Partial<ConcertSetLike> = {}): ConcertSetLike {
  return { mergedTrackId: m.id, cues: tracks.map((t) => ({ trackId: t.id, title: t.title, artist: t.artist })), ...extra }
}
/** The page's album grouping: one group per album name, over the given rows. */
function groups(rows: T[]): Group[] {
  const m = new Map<string, Group>()
  for (const t of rows) {
    const k = t.album.toLowerCase()
    const g = m.get(k) ?? { name: t.album, year: t.year, tracks: [] }
    g.tracks.push(t)
    m.set(k, g)
  }
  return [...m.values()].sort((a, b) => b.year - a.year)
}
/** Same projection as useRegularLibraryTracks / libraryHiddenTrackIds. */
function regular(rows: T[], sets: Record<string, ConcertSetLike>): T[] {
  const ids = new Set(rows.map((t) => t.id))
  const hidden = new Set<number>()
  for (const e of Object.values(sets)) {
    if (!ids.has(e.mergedTrackId)) continue
    hidden.add(e.mergedTrackId)
    const promoted = new Set(e.promotedTrackIds || [])
    for (const c of e.cues) if (!promoted.has(c.trackId)) hidden.add(c.trackId)
  }
  return rows.filter((t) => !hidden.has(t.id))
}
const kindByTitle = (g: Group): ReleaseKind => classifyRelease({ album: g.name, declaredTrackCount: g.tracks.length }).kind

// ── Geese, as the library has it: two declared shows, six studio releases.
const geeseStudio = [
  ...album('Geese', 'Getting Killed', 2025, ['Trinidad', 'Cobra', 'Husbands', 'Au Pays du Cocaine', 'Islands of Men', '100 Horses', 'Taxes', 'Bow Down', 'Half Real', 'Long Island City Here I Come', 'Getting Killed']),
  ...album('Geese', 'Baby', 2024, ['Baby']),
  ...album('Geese', '3D Country', 2023, ['2122', '3D Country', 'Cowboy Nudes', 'Undoer', 'Gravity Blues', 'I See Myself', 'Mysterious Love', 'Crusades', 'St. Elmo', 'Domoto', 'Tomorrow\'s Crusades']),
  ...album('Geese', '4D Country', 2023, ['Jesse', 'Art of War', 'Killing My Borrowed Time', 'Mysterious Love (Alt)', 'Undoer (Alt)']),
]
const aliveSongs = album('Geese', 'Alive & In Person', 2024, ['2122 (Live)', 'Jesse (Live)', 'Cowboy Nudes (Live)', 'Domoto (Live)', 'Gravity Blues (Live)', 'I See Myself (Live)', '3D Country (Live)'])
const aliveMerged = merged('Geese', 'Alive & In Person', 2024)
const forestShow = 'Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026)'
const forestSongs = album('Geese', forestShow, 2026, ['Long Island City Here I Come', 'Cobra', 'Husbands', 'Trinidad'])
const forestMerged = merged('Geese', forestShow, 2026)
const geeseSets: Record<string, ConcertSetLike> = {
  'geese|||alive & in person': setOf(aliveSongs, aliveMerged, {
    promotedTrackIds: [],
    concert: { venue: 'The Diamond Mine Recording Studio', city: 'Queens, NY', date: '2023 (exact date not published)' },
  }),
  [`geese|||${forestShow.toLowerCase()}`]: setOf(forestSongs, forestMerged, {
    promotedTrackIds: [],
    concert: { venue: 'Forest Hills Stadium', city: 'Queens, NY', date: 'October 3, 2026', poster: '' },
  }),
}
const geeseLibrary = [...geeseStudio, ...aliveSongs, aliveMerged, ...forestSongs, forestMerged]
const geeseById = new Map(geeseLibrary.map((t) => [t.id, t] as const))

describe('declared concerts — one reading for the Concerts page and the artist page', () => {
  test('band from the first cue, show without "(Live Set)", grounded venue/date, empty poster ignored', () => {
    const cs = declaredConcerts(geeseSets, (id) => geeseById.get(id))
    assert.deepEqual(cs.map((c) => [c.band, c.show, c.venue, c.city, c.date, c.poster]), [
      ['Geese', 'Alive & In Person', 'The Diamond Mine Recording Studio', 'Queens, NY', '2023 (exact date not published)', undefined],
      ['Geese', forestShow, 'Forest Hills Stadium', 'Queens, NY', 'October 3, 2026', undefined],
    ])
    assert.equal(cs[1].when, Date.UTC(2026, 9, 3))
    assert.equal(cs[0].year, 2024)
  })

  test('a set whose merged track is gone is not declared', () => {
    const stale = { ...geeseSets, 'x|||gone': { mergedTrackId: 99_999, cues: [{ trackId: geeseStudio[0].id }] } }
    assert.equal(declaredConcerts(stale, (id) => geeseById.get(id)).length, 2)
    assert.equal(concertTrackIds(stale, (id) => geeseById.has(id)).has(geeseStudio[0].id), false,
      'a stale set must not swallow an ordinary album')
  })

  test('no override: venue/date only from the "(Live at|from VENUE, DATE)" tag or a dated show name', () => {
    assert.deepEqual(parseConcertMeta('Show', 'Song (Live at Paradiso, November 25, 1991)'), { venue: 'Paradiso', date: 'November 25, 1991' })
    assert.deepEqual(parseConcertMeta('Go to Nassau: May 15 & 16, 1980', 'Jack Straw'), { venue: undefined, date: 'May 15 & 16, 1980' })
    assert.deepEqual(parseConcertMeta('Alive 2007', 'Robot Rock'), { venue: undefined, date: undefined })
    assert.equal(firstNightMs('July 17, 18 & 21, 2009'), Date.UTC(2009, 6, 17))
    assert.equal(firstNightMs(undefined), Number.POSITIVE_INFINITY)
  })
})

describe('one tile per show', () => {
  test('Geese: the Live wall is the two shows, newest first; no album anywhere carries a concert track', () => {
    const concerts = declaredConcerts(geeseSets, (id) => geeseById.get(id))
    const ids = concertTrackIds(geeseSets, (id) => geeseById.has(id))
    const shown = withoutConcertTracks(groups(regular(geeseLibrary, geeseSets)), ids)
    const sections = withLiveWall(groupByReleaseKind(shown, kindByTitle), concertsByPersona(concerts, ['Geese']).get('Geese') ?? [])
    assert.deepEqual(sections.map((s) => s.label), ['Albums', 'EPs', 'Singles', 'Live'])
    const live = sections.find((s) => s.kind === 'live')!
    assert.deepEqual(live.items, [])
    assert.deepEqual(live.wall!.map((t) => t.type === 'concert' ? t.concert.show : t.album.name), [forestShow, 'Alive & In Person'])
    for (const s of sections) for (const g of s.items) for (const t of g.tracks) {
      assert.equal(ids.has(t.id), false, `${g.name} shows concert track ${t.title}`)
    }
  })

  test('a show reimported song by song (every constituent promoted) is still ONE tile — its concert', () => {
    nextId = 5000
    const unplugged = album('Nirvana', 'MTV Unplugged in New York', 1994, ['About a Girl', 'Come as You Are', 'Jesus Doesn\'t Want Me for a Sunbeam'])
    const unpluggedMerged = merged('Nirvana', 'MTV Unplugged in New York', 1994)
    const nevermind = album('Nirvana', 'Nevermind', 1991, ['Smells Like Teen Spirit', 'In Bloom', 'Come as You Are', 'Breed', 'Lithium', 'Polly', 'Territorial Pissings'])
    const lib = [...unplugged, unpluggedMerged, ...nevermind]
    const byId = new Map(lib.map((t) => [t.id, t] as const))
    const sets = { 'nirvana|||mtv unplugged in new york': setOf(unplugged, unpluggedMerged, { promotedTrackIds: unplugged.map((t) => t.id) }) }
    // The regular library shows the promoted songs again — and the title says live.
    const regularGroups = groups(regular(lib, sets))
    assert.deepEqual(regularGroups.map((g) => g.name).sort(), ['MTV Unplugged in New York', 'Nevermind'])
    const ids = concertTrackIds(sets, (id) => byId.has(id))
    const shown = withoutConcertTracks(regularGroups, ids)
    assert.deepEqual(shown.map((g) => g.name), ['Nevermind'])
    assert.equal(shown[0], regularGroups.find((g) => g.name === 'Nevermind'), 'an untouched album keeps its identity')
    const sections = withLiveWall(groupByReleaseKind(shown, kindByTitle), declaredConcerts(sets, (id) => byId.get(id)))
    const live = sections.find((s) => s.kind === 'live')!
    assert.equal(live.wall!.length, 1)
    assert.equal(live.wall![0].type, 'concert')
  })

  test('a mixed album keeps only its own songs; a stray concert song never makes a second tile', () => {
    const g = { name: 'Odds', year: 2000, tracks: [{ id: 1 }, { id: 2 }] }
    assert.deepEqual(withoutConcertTracks([g], new Set([2])).map((x) => x.tracks.map((t) => t.id)), [[1]])
    assert.deepEqual(withoutConcertTracks([g], new Set([1, 2])), [])
    assert.deepEqual(withoutConcertTracks([g], new Set()), [g])
  })
})

describe('the wall: what, and in what order', () => {
  const c = (show: string, when: number, year = 0) => ({ albumKey: `b|||${show.toLowerCase()}`, band: 'B', show, when, year })
  const a = (name: string, year: number, first = 'Song') => ({ name, year, tracks: [{ title: first }] })

  test('concerts and live albums interleave newest first; undated last; ties concert-first then A→Z', () => {
    const wall = buildLiveWall(
      [c('Night Two', Date.UTC(2026, 9, 3)), c('Undated Tape', Number.POSITIVE_INFINITY), c('Year Only', Number.POSITIVE_INFINITY, 2019)],
      [a('Live at the Hall (Live at Carnegie Hall, December 11, 2025)', 2025), a('Rarities Live', 0), a('Alive 2019', 2019)],
    )
    assert.deepEqual(wall.map((t) => t.type === 'concert' ? t.concert.show : t.album.name), [
      'Night Two', 'Live at the Hall (Live at Carnegie Hall, December 11, 2025)', 'Year Only', 'Alive 2019', 'Undated Tape', 'Rarities Live',
    ])
  })

  test('a live album grounds venue/date from its title, then its first song, else none', () => {
    assert.deepEqual(liveAlbumMeta(a('Good Evening New York City (Live at Citi Field, NYC, 2009)', 2009)), { venue: 'Citi Field', date: 'NYC, 2009' })
    assert.deepEqual(liveAlbumMeta(a('Show', 2026, '100 Horses (Live from Forest Hills, New York, October 3rd, 2026)')), { venue: 'Forest Hills', date: 'New York, October 3rd, 2026' })
    assert.deepEqual(liveAlbumMeta(a('Alive 2007', 2007, 'Robot Rock / Oh Yeah')), { venue: undefined, date: undefined })
  })

  test('Live sits in rulebook order, labelled "Live"; a page with no live items is untouched', () => {
    const albums = [{ name: 'Studio', year: 2020, tracks: [{ title: 'x' }] }, { name: 'Greatest Hits', year: 2021, tracks: [{ title: 'y' }] }]
    const kind = (g: { name: string }): ReleaseKind => (g.name === 'Studio' ? 'album' : 'compilation')
    const base = groupByReleaseKind(albums, kind)
    assert.deepEqual(withLiveWall(base, []).map((s) => s.label), ['Albums', 'Compilations'])
    assert.equal(withLiveWall(base, []).some((s) => 'wall' in s && s.wall), false)
    const withShow = withLiveWall(base, [c('A Night', Date.UTC(2020, 0, 1))])
    assert.deepEqual(withShow.map((s) => s.label), ['Albums', 'Live', 'Compilations'])
    assert.deepEqual(withLiveWall(groupByReleaseKind([], kind), [c('Only Show', 0)]).map((s) => s.label), ['Live'])
  })

  test('a concert sits under the persona with its exact tag, else the first (main) persona', () => {
    const m = concertsByPersona([{ band: 'Paul McCartney & Wings' }, { band: 'paul mccartney' }, { band: 'McCartney' }], ['Paul McCartney', 'Paul McCartney & Wings'])
    assert.deepEqual(m.get('Paul McCartney')!.map((x) => x.band), ['paul mccartney', 'McCartney'])
    assert.deepEqual(m.get('Paul McCartney & Wings')!.map((x) => x.band), ['Paul McCartney & Wings'])
    assert.equal(concertsByPersona([{ band: 'X' }], []).size, 0)
  })
})

describe('WIRING — the pages read concerts through the shared helpers', () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, '../../renderer', p), 'utf-8')
  test('the artist page groups the REGULAR library, folds concert songs out, and walls the Live section', () => {
    const view = read('views/ArtistDetailView.tsx')
    assert.match(view, /useRegularLibraryTracks\(lib\.tracks\)/)
    assert.match(view, /declaredConcerts\(/)
    assert.match(view, /withoutConcertTracks\(persona\.albums, concertIds\)/)
    assert.match(view, /withLiveWall\(/)
    assert.match(view, /<ConcertPosterTile/)
    assert.match(view, /SET_VIEW', view: 'concert-detail'/)
  })
  test('the Concerts page reads concerts the same way and owns no second parser', () => {
    const view = read('views/ConcertsView.tsx')
    assert.match(view, /declaredConcerts\(/)
    assert.equal(/function parseConcertMeta\(/.test(view), false, 'a second, drifting concert parser is back')
  })
})
