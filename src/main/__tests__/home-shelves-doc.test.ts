import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHomeShelves, localHomeShelves, isEmptyShelves } from '../../common/home-shelves-doc.ts'
import { DAY_MS, type ShelfTrack } from '../../common/home-shelves.ts'
import { isTop25Rankable } from '../../common/top25-rankable.ts'

// The desktop's read of GET /api/home-shelves (JakeTunesMobile backend
// util/homeShelvesDoc.ts) and its offline twin, localHomeShelves.

const DOC = {
  version: 1,
  generatedAt: '2026-10-20T11:47:01.697Z',
  day: '2026-10-20',
  listenMore: { items: [
    { track: { id: 6011, title: 'Inside Us All', path: '/x' }, reason: 'You starred “Higher” on this album' },
    { track: { id: '6012' }, reason: 'Indie Pop, like your TV Girl and Clairo' },
    { track: { id: 'abc' }, reason: 'bad id' },
    { track: { id: 7 }, reason: '' },
  ] },
  listeningALot: { windowDays: 30, items: [
    { track: { id: 1 }, plays: 7, lastPlayedAt: '2026-10-17T15:13:00.000Z' },
    { track: { id: 2 }, plays: 'six' },
    { track: { id: 3 }, plays: 0 },
  ] },
  recentlyAdded: {
    items: [
      { album: { key: 'Mon Rovîa|||Heavy Foot', artist: 'Mon Rovîa', album: 'Heavy Foot' }, dateAdded: '2026-10-20T00:34:00.000Z', trackIds: [11, 12] },
      { album: { artist: 'X' }, dateAdded: '2026-10-19T00:00:00.000Z', trackIds: [13] },
      { album: { artist: 'Y', album: 'Z' }, dateAdded: 'not a date', trackIds: [14] },
    ],
    playlist: { id: 'ipod-recently-added', name: 'Recently Added' },
  },
}

test('parse: ids, reasons, counts and dates are kept; anything unsure is dropped, never guessed', () => {
  const d = parseHomeShelves(DOC)
  assert.ok(d)
  assert.equal(d.day, '2026-10-20')
  assert.deepEqual(d.listenMore, [
    { id: 6011, reason: 'You starred “Higher” on this album' },
    { id: 6012, reason: 'Indie Pop, like your TV Girl and Clairo' },
  ])
  assert.deepEqual(d.listeningALot, [{ id: 1, plays: 7 }])
  assert.deepEqual(d.recentlyAdded, [{ artist: 'Mon Rovîa', album: 'Heavy Foot', dateAdded: '2026-10-20T00:34:00.000Z', trackIds: [11, 12] }])
})

test('parse: wrong version / not an object → null; listenMore null stays null (the row hides)', () => {
  assert.equal(parseHomeShelves({ ...DOC, version: 2 }), null)
  assert.equal(parseHomeShelves('<html>'), null)
  assert.equal(parseHomeShelves(null), null)
  const noTaste = parseHomeShelves({ ...DOC, listenMore: null })
  assert.equal(noTaste?.listenMore, null)
  assert.equal(isEmptyShelves(parseHomeShelves({ version: 1, listenMore: null, listeningALot: { items: [] }, recentlyAdded: { items: [] } })), true)
  assert.equal(isEmptyShelves(parseHomeShelves(DOC)), false)
})

test('parse: rows are capped — 10 songs, 5 albums', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
  const d = parseHomeShelves({
    version: 1,
    listenMore: { items: many(14).map((id) => ({ track: { id }, reason: 'r' })) },
    listeningALot: { items: many(14).map((id) => ({ track: { id }, plays: 3 })) },
    recentlyAdded: { items: many(9).map((id) => ({ album: { artist: 'A', album: `L${id}` }, dateAdded: '2026-10-01T00:00:00Z', trackIds: [id] })) },
  })
  assert.equal(d?.listenMore?.length, 10)
  assert.equal(d?.listeningALot.length, 10)
  assert.equal(d?.recentlyAdded.length, 5)
})

test('local fallback: the same rulebook over this Mac\'s library + plays; no taste → no gems row', () => {
  const NOW = Date.UTC(2026, 9, 20, 16)
  const t = (id: number, o: Partial<ShelfTrack> = {}): ShelfTrack => ({
    id, title: `S${id}`, artist: 'Geese', album: 'Getting Killed', genre: 'Indie Rock', duration: 200_000, rating: 0, playCount: 0,
    dateAdded: new Date(NOW - 400 * DAY_MS).toISOString(), ...o,
  })
  const tracks = [t(1, { rating: 1 }), t(2, { rating: 1 }), t(3), t(4, { album: 'New', dateAdded: new Date(NOW - DAY_MS).toISOString() }), t(5, { duration: 30_000, album: 'Skit' })]
  const plays = [{ id: 1, ts: NOW - 1000 }, { id: 1, ts: NOW - 2000 }, { id: 5, ts: NOW - 1000 }, { id: 5, ts: NOW - 2000 }, { id: 5, ts: NOW - 3000 }]
  const base = { tracks, plays, now: NOW, rules: { hidden: new Set<string>(), rankable: (x: ShelfTrack) => isTop25Rankable(x) }, albumKeyOf: (x: ShelfTrack) => `${x.artist}|||${x.album}`.toLowerCase() }
  const d = localHomeShelves({ ...base, score: () => 0.7 })
  assert.deepEqual(d.listenMore, [{ id: 3, reason: 'You starred the rest of this album' }])
  assert.deepEqual(d.listeningALot, [{ id: 1, plays: 2 }], 'the 30-second skit never ranks')
  assert.deepEqual(d.recentlyAdded.map((a) => [a.album, a.trackIds]), [['New', [4]], ['Getting Killed', [1, 2, 3]]], 'an all-sub-minute album never shows')
  assert.equal(localHomeShelves({ ...base, score: null }).listenMore, null)
})

// On Repeat (2026-10-28): the playlist homemini publishes beside the row —
// the same ranking ON_REPEAT_SIZE deep, whose head the row is.
test('parse: On Repeat is listeningALot.playlist.trackIds; an older document falls back to the row', () => {
  const ids = Array.from({ length: 40 }, (_, i) => i + 1)
  const d = parseHomeShelves({
    ...DOC,
    listeningALot: { ...DOC.listeningALot, playlist: { id: 'jaketunes-on-repeat', name: 'On Repeat', trackIds: [...ids.map(String), 'bad', 3] } },
  })
  assert.deepEqual(d?.onRepeat, ids.slice(0, 30), 'distinct numeric ids, in order, capped at ON_REPEAT_SIZE')
  assert.deepEqual(parseHomeShelves(DOC)?.onRepeat, [1], 'no playlist yet: the row\'s own songs')
})

test('local fallback: On Repeat runs the same ranking deeper; the row is its head', () => {
  const NOW = Date.UTC(2026, 9, 20, 16)
  const tracks: ShelfTrack[] = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, title: `S${i}`, artist: `A${i}`, album: `B${i}`, duration: 200_000 }))
  const plays = tracks.flatMap((t, i) => Array.from({ length: 20 - i }, (_, k) => ({ id: t.id, ts: NOW - (k + 1) * 60_000 })))
  const d = localHomeShelves({ tracks, plays, now: NOW, rules: { hidden: new Set<string>(), rankable: (x: ShelfTrack) => isTop25Rankable(x) }, score: null, albumKeyOf: () => null })
  assert.deepEqual(d.onRepeat, tracks.map((t) => t.id))
  assert.deepEqual(d.listeningALot.map((h) => h.id), d.onRepeat.slice(0, 10))
})
