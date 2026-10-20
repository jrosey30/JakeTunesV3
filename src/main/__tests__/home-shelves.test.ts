/**
 * Home shelves rules (2026-10-20) — the three rows under launch page "G".
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/__tests__/homeShelves.test.ts — same cases, same rulebook.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listeningALot, recentlyAddedAlbums, hiddenGems, isGemEligible, tallyPlays, dailyShuffle, localDayKey,
  addedLabel, playsLabel, DAY_MS, SHELF_MAX, RECENT_ALBUMS_MAX,
  type ShelfTrack, type ShelfPlay, type ShelfRules,
} from '../../common/home-shelves.ts'
import { isTop25Rankable } from '../../common/top25-rankable.ts'

const NOW = Date.UTC(2026, 9, 20, 16, 0, 0)
const daysAgo = (n: number): string => new Date(NOW - n * DAY_MS).toISOString()
const at = (n: number, id: number | string): ShelfPlay => ({ id, ts: NOW - n * DAY_MS - 60_000 })
const many = (count: number, n: number, id: number | string): ShelfPlay[] => Array.from({ length: count }, (_, i) => at(n + i * 0.01, id))
const MIN = 60_000
const rules = (hidden: Array<number | string> = []): ShelfRules => ({ hidden: new Set(hidden.map(String)), rankable: (t) => isTop25Rankable(t) })
const keyOf = (t: ShelfTrack): string => `${String(t.albumArtist || t.artist).toLowerCase()}|||${String(t.album).toLowerCase()}`
const song = (id: number, o: Partial<ShelfTrack> = {}): ShelfTrack => ({
  id, title: `Song ${id}`, artist: 'Artist', album: 'Album', genre: 'Indie Rock', duration: 3 * MIN, rating: 0, playCount: 0, dateAdded: daysAgo(400), ...o,
})

// ── Listening a lot ────────────────────────────────────────────────────────

test('listening a lot: most plays in 30 days, ties → most recent play, at least 2 plays', () => {
  const tracks = [song(1), song(2), song(3), song(4)]
  const plays = [...many(5, 2, 1), ...many(3, 6, 2), ...many(3, 1, 3), at(1, 4)]
  const out = listeningALot(tracks, plays, NOW, rules())
  assert.deepEqual(out.map((e) => [e.id, e.plays]), [['1', 5], ['3', 3], ['2', 3]])
  assert.equal(playsLabel(out[0]!.plays), '5 plays')
  assert.equal(playsLabel(1), '1 play')
})

test('listening a lot: plays older than 30 days and plays in the future do not count', () => {
  const tracks = [song(1), song(2)]
  const plays = [...many(9, 31, 1), at(29, 2), at(29.5, 2), { id: 2, ts: NOW + DAY_MS }]
  const out = listeningALot(tracks, plays, NOW, rules())
  assert.deepEqual(out.map((e) => [e.id, e.plays]), [['2', 2]])
})

test('the one-minute rule: a sub-minute song never ranks, however often it plays', () => {
  const tracks = [song(1, { duration: 45_000 }), song(2), song(3, { duration: 0 })]
  const plays = [...many(20, 1, 1), ...many(3, 1, 2), ...many(2, 1, 3)]
  const out = listeningALot(tracks, plays, NOW, rules())
  assert.deepEqual(out.map((e) => e.id), ['2', '3'], 'unknown duration stays rankable')
})

test('concerts never appear: a merged full show and its setlist songs are skipped', () => {
  const tracks = [song(1), song(2), song(3)]
  const plays = [...many(9, 1, 1), ...many(8, 1, 2), ...many(2, 1, 3)]
  assert.deepEqual(listeningALot(tracks, plays, NOW, rules([1, 2])).map((e) => e.id), ['3'])
})

test('listening a lot holds at most 10', () => {
  const tracks = Array.from({ length: 14 }, (_, i) => song(i + 1))
  const plays = tracks.flatMap((t) => many(2 + Number(t.id), 1, t.id))
  const out = listeningALot(tracks, plays, NOW, rules())
  assert.equal(out.length, SHELF_MAX)
  assert.equal(out[0]!.id, '14')
})

// ── Recently added ─────────────────────────────────────────────────────────

test('recently added: one entry per album, newest song decides, newest first', () => {
  const tracks = [
    song(1, { artist: 'Geese', album: 'Getting Killed', dateAdded: daysAgo(5) }),
    song(2, { artist: 'Geese', album: 'Getting Killed', dateAdded: daysAgo(2) }),
    song(3, { artist: 'Ween', album: 'Quebec', dateAdded: daysAgo(3) }),
    song(4, { artist: 'Ween', album: 'Quebec', dateAdded: daysAgo(3) }),
    song(5, { artist: 'Mon Rovîa', album: 'Heavy Foot', dateAdded: daysAgo(1) }),
  ]
  const out = recentlyAddedAlbums(tracks, rules(), keyOf)
  assert.deepEqual(out.map((a) => [a.album, a.ids]), [['Heavy Foot', ['5']], ['Getting Killed', ['1', '2']], ['Quebec', ['3', '4']]])
  assert.equal(out[1]!.addedMs, Date.parse(daysAgo(2)))
  assert.match(addedLabel(out[0]!.addedMs), /^Added [A-Z][a-z]{2} \d{1,2}$/)
})

test('recently added: the grouping key is the app\'s own; untitled songs never form a fake album', () => {
  const tracks = [
    song(1, { artist: 'A', album: '', dateAdded: daysAgo(1) }),
    song(2, { artist: 'B', album: 'Unknown Album', dateAdded: daysAgo(1) }),
    song(3, { artist: 'C', album: '  ', dateAdded: daysAgo(1) }),
    song(4, { artist: 'Various Artists', album: 'Now 99', dateAdded: daysAgo(2) }),
    song(5, { artist: 'Someone', albumArtist: 'Various Artists', album: 'Now 99', dateAdded: daysAgo(2) }),
    song(6, { artist: 'X', album: 'No Date', dateAdded: null }),
  ]
  const out = recentlyAddedAlbums(tracks, rules(), keyOf)
  assert.deepEqual(out.map((a) => [a.key, a.ids]), [['various artists|||now 99', ['4', '5']]])
  // A different app key (the phone backend's case-preserving one) groups its own way.
  const caseKey = (t: ShelfTrack): string => `${t.albumArtist || t.artist}|||${t.album}`
  assert.equal(recentlyAddedAlbums([...tracks, song(7, { artist: 'Various artists', album: 'Now 99', dateAdded: daysAgo(2) })], rules(), caseKey).length, 2)
})

test('recently added: concert tracks and all-sub-minute albums are skipped; at most 5', () => {
  const tracks = [
    song(1, { artist: 'Geese', album: 'Live at Forest Hills', dateAdded: daysAgo(1) }),
    song(2, { artist: 'Intro Guy', album: 'Skits', duration: 30_000, dateAdded: daysAgo(1) }),
    ...Array.from({ length: 7 }, (_, i) => song(10 + i, { artist: `Band ${i}`, album: `LP ${i}`, dateAdded: daysAgo(2 + i) })),
  ]
  const out = recentlyAddedAlbums(tracks, rules([1]), keyOf)
  assert.equal(out.length, RECENT_ALBUMS_MAX)
  assert.deepEqual(out.map((a) => a.album), ['LP 0', 'LP 1', 'LP 2', 'LP 3', 'LP 4'])
})

// ── You should listen to more (hidden gems) ────────────────────────────────

test('hidden gem eligibility: ≤ 2 lifetime plays, none in 90 days, not added in 30 days, unstarred, ≥ 1 min, not a concert', () => {
  const tracks = [
    song(1),                                      // eligible
    song(2, { playCount: 3 }),                    // library count says 3
    song(3),                                      // history says 3
    song(4),                                      // played 40 days ago
    song(5, { dateAdded: daysAgo(10) }),          // recently added
    song(6, { rating: 1 }),                       // starred already
    song(7, { duration: 40_000 }),                // under a minute
    song(8),                                      // concert-owned
    song(9, { lastPlayedAt: NOW - 20 * DAY_MS }), // desktop's own last play
    song(10, { playCount: 2 }),                   // two old plays: still a gem
    song(11, { dateAdded: null }),                // unknown age: not "recent"
  ]
  const plays = [...many(3, 200, 3), at(40, 4), at(120, 10)]
  const tally = tallyPlays(plays, NOW)
  const r = rules([8])
  assert.deepEqual(tracks.filter((t) => isGemEligible(t, tally, NOW, r)).map((t) => t.id), [1, 10, 11])
})

/** A small library with real taste signal: starred albums, played artists. */
function gemLibrary(): { tracks: ShelfTrack[]; plays: ShelfPlay[] } {
  const tracks: ShelfTrack[] = []
  let id = 1
  // Geese — Getting Killed: 3 starred + 2 unplayed → "the rest of this album"-style facts.
  for (let i = 0; i < 3; i++) tracks.push(song(id++, { artist: 'Geese', album: 'Getting Killed', rating: 1, playCount: 20 }))
  tracks.push(song(id++, { title: 'Taxes', artist: 'Geese', album: 'Getting Killed' }))          // 4
  // Fat Dog: one starred song on another album.
  tracks.push(song(id++, { title: 'King of the Slugs', artist: 'Fat Dog', album: 'WOOF.', rating: 1, playCount: 30 })) // 5
  tracks.push(song(id++, { title: 'Wither', artist: 'Fat Dog', album: 'Peace Dog' }))            // 6
  // Steely Dan: played a lot, never starred.
  tracks.push(song(id++, { title: 'Do It Again', artist: 'Steely Dan', album: "Can't Buy A Thrill", genre: 'Jazz Rock', playCount: 40 })) // 7
  tracks.push(song(id++, { title: 'Peg', artist: 'Steely Dan', album: 'Aja', genre: 'Jazz Rock' }))                                       // 8
  // A new jazz-rock artist with no history of its own → genre neighbours.
  tracks.push(song(id++, { title: 'Glide', artist: 'Newcomer', album: 'First', genre: 'Jazz Rock' }))                                     // 9
  // Nobody: no stars, no plays, genre with no played peers → no reason, never shown.
  tracks.push(song(id++, { title: 'Silent', artist: 'Nobody', album: 'Void', genre: 'Drone' }))                                           // 10
  return { tracks, plays: [] }
}

test('hidden gems: grounded reasons only — stars, plays, genre peers; no reason, no pick', () => {
  const { tracks, plays } = gemLibrary()
  const out = hiddenGems(tracks, plays, NOW, rules(), () => 0.5, { day: '2026-10-20' })
  const why = new Map(out.map((g) => [g.id, g.reason]))
  assert.equal(why.get('4'), 'You starred the rest of this album')
  assert.equal(why.get('6'), 'You starred “King of the Slugs” by Fat Dog')
  assert.equal(why.get('8'), 'You’ve played Steely Dan 40 times')
  assert.equal(why.get('9'), 'Jazz Rock, like your Steely Dan')
  assert.equal(why.has('10'), false, 'no groundable reason → not shown')
  assert.equal(out.every((g) => !['1', '2', '3', '5', '7'].includes(g.id)), true, 'starred / well-played songs are not gems')
})

test('hidden gems: "Various Artists" is never a reason or a genre peer', () => {
  const tracks = [
    song(1, { artist: 'DJ A', albumArtist: 'Various Artists', album: 'Mix 1', genre: 'House', playCount: 50 }),
    song(2, { artist: 'Jigitz', album: 'Club', genre: 'House', playCount: 20 }),
    song(3, { artist: 'Newbie', album: 'Debut', genre: 'House' }),
    song(4, { artist: 'DJ B', albumArtist: 'Various Artists', album: 'Mix 2', genre: 'Techno', rating: 1 }),
    song(5, { artist: 'DJ C', albumArtist: 'Various Artists', album: 'Mix 3', genre: 'Techno' }),
  ]
  const why = new Map(hiddenGems(tracks, [], NOW, rules(), () => 1, { day: 'd' }).map((g) => [g.id, g.reason]))
  assert.equal(why.get('3'), 'House, like your Jigitz')
  assert.equal(why.has('5'), false, 'a compilation with no stars of its own has nothing true to say')
})

test('hidden gems: album star counts and the strongest fact wins', () => {
  const tracks = [
    song(1, { artist: 'X', album: 'A', rating: 1 }), song(2, { artist: 'X', album: 'A', rating: 1 }),
    song(3, { artist: 'X', album: 'A' }), song(4, { artist: 'X', album: 'A' }),
    song(5, { artist: 'Y', album: 'B', rating: 1, title: 'Opener' }), song(6, { artist: 'Y', album: 'B' }),
    song(7, { artist: 'Z', album: 'C', rating: 1 }), song(8, { artist: 'Z', album: 'D', rating: 1 }), song(9, { artist: 'Z', album: 'E' }),
  ]
  const why = new Map(hiddenGems(tracks, [], NOW, rules(), () => 1, { day: 'd' }).map((g) => [g.id, g.reason]))
  assert.equal(why.get('3'), 'You starred 2 songs on this album')
  assert.equal(why.get('6'), 'You starred “Opener” on this album')
  assert.equal(why.get('9'), 'You starred 2 Z songs')
})

test('hidden gems: ranked by the injected taste score, the top of the pool rotates daily and holds all day', () => {
  const tracks: ShelfTrack[] = []
  for (let a = 0; a < 30; a++) {
    tracks.push(song(1000 + a, { artist: `Band ${a}`, album: `LP ${a}`, rating: 1 }))
    tracks.push(song(2000 + a, { artist: `Band ${a}`, album: `LP ${a}` }))
  }
  const score = (t: ShelfTrack): number => Number(t.id) / 10_000
  const day1 = hiddenGems(tracks, [], NOW, rules(), score, { day: '2026-10-20' })
  const again = hiddenGems(tracks, [], NOW, rules(), score, { day: '2026-10-20' })
  const day2 = hiddenGems(tracks, [], NOW, rules(), score, { day: '2026-10-21' })
  assert.equal(day1.length, SHELF_MAX)
  assert.deepEqual(again.map((g) => g.id), day1.map((g) => g.id), 'stable within a day')
  assert.notDeepEqual(day2.map((g) => g.id), day1.map((g) => g.id), 'fresh the next day')
  // A small pool: only the best-scored songs ever rotate in.
  const top = hiddenGems(tracks, [], NOW, rules(), score, { day: '2026-10-22', pool: 10 })
  assert.deepEqual(top.map((g) => g.id).sort(), Array.from({ length: 10 }, (_, i) => String(2020 + i)))
  assert.deepEqual(dailyShuffle([1, 2, 3, 4, 5], 'x'), dailyShuffle([1, 2, 3, 4, 5], 'x'))
  assert.match(localDayKey(NOW), /^\d{4}-\d{2}-\d{2}$/)
})

test('hidden gems: no two from the same artist while the pool allows, then albums, then anything', () => {
  const tracks: ShelfTrack[] = [song(1, { artist: 'Solo', album: 'One', rating: 1 })]
  for (let i = 0; i < 6; i++) tracks.push(song(10 + i, { artist: 'Solo', album: i < 3 ? 'One' : 'Two' }))
  tracks.push(song(30, { artist: 'Duo', album: 'Pair', rating: 1 }), song(31, { artist: 'Duo', album: 'Pair' }))
  const out = hiddenGems(tracks, [], NOW, rules(), () => 1, { day: '2026-10-20', limit: 5 })
  const artistOf = (id: string): string => String(tracks.find((t) => String(t.id) === id)!.artist)
  assert.deepEqual(out.slice(0, 2).map((g) => artistOf(g.id)).sort(), ['Duo', 'Solo'])
  assert.equal(out.length, 5)
})

test('hidden gems: concerts, sub-minute songs and recent adds never appear, whatever their score', () => {
  const tracks = [
    song(1, { artist: 'G', album: 'L', rating: 1 }),
    song(2, { artist: 'G', album: 'L' }),
    song(3, { artist: 'G', album: 'L', duration: 50_000 }),
    song(4, { artist: 'G', album: 'L', dateAdded: daysAgo(3) }),
  ]
  const out = hiddenGems(tracks, [], NOW, rules([2]), () => 1, { day: 'd' })
  assert.deepEqual(out, [])
})
