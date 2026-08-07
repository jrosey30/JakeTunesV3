import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  creditKindOf, buildLibraryIndex, evaluateCredit, computeStandings,
  computeAlbumCredits, albumKeyOfStrings, type CreditRecord,
} from '../friend-standings-core.ts'
import { friendOfNote } from '../friend-imports-core.ts'
import { recoNorm } from '../reco-match.ts'

const LIB = [
  { title: 'Pareidolia', artist: 'Ken Pomeroy', album: 'Cruel Joke' },
  { title: 'Stranger', artist: 'Ken Pomeroy', album: 'Cruel Joke' },
  { title: 'Coyote', artist: 'Ken Pomeroy', album: 'Cruel Joke' },
  { title: 'Body Funk', artist: 'Purple Disco Machine', album: 'Soulmatic' },
]

const songCredit = (o: Partial<CreditRecord> = {}): CreditRecord => ({
  recoId: 'r1', friend: 'Joey Levine', kind: 'song',
  label: 'Body Funk — Purple Disco Machine',
  keys: [`${recoNorm('Body Funk')}|${recoNorm('Purple Disco Machine')}`],
  creditedAt: '2026-08-01T00:00:00Z', ...o,
})

const albumCredit = (o: Partial<CreditRecord> = {}): CreditRecord => ({
  recoId: 'r2', friend: 'Lorin Bloom', kind: 'album',
  label: 'Cruel Joke — Ken Pomeroy',
  albumKey: albumKeyOfStrings('Cruel Joke', 'Ken Pomeroy')!,
  n0: 3, creditedAt: '2026-08-02T00:00:00Z', ...o,
})

// ── Jake's rules, verbatim ──────────────────────────────────────────────────

test('song imported and kept = 1 point', () => {
  const lib = buildLibraryIndex(LIB)
  assert.deepEqual(
    { status: evaluateCredit(songCredit(), lib).status, points: evaluateCredit(songCredit(), lib).points },
    { status: 'kept', points: 1 },
  )
})

test('album imported and intact = 5 points', () => {
  const lib = buildLibraryIndex(LIB)
  const e = evaluateCredit(albumCredit(), lib)
  assert.equal(e.status, 'kept')
  assert.equal(e.points, 5)
})

test('deleted song = minus 1', () => {
  const lib = buildLibraryIndex(LIB.filter((t) => t.title !== 'Body Funk'))
  const e = evaluateCredit(songCredit(), lib)
  assert.equal(e.status, 'deleted')
  assert.equal(e.points, -1)
})

test('album fully deleted = minus 1 (not minus 5)', () => {
  const lib = buildLibraryIndex(LIB.filter((t) => t.album !== 'Cruel Joke'))
  const e = evaluateCredit(albumCredit(), lib)
  assert.equal(e.status, 'deleted')
  assert.equal(e.points, -1)
})

test('album with one song deleted but the rest kept counts as ONE SONG = 1 point', () => {
  // Jake: "if i delete a song from the album a friend sent me, but kept the
  // other songs from that album... it counts as 1 song (so 1 point)"
  const lib = buildLibraryIndex(LIB.filter((t) => t.title !== 'Stranger'))
  const e = evaluateCredit(albumCredit(), lib)
  assert.equal(e.status, 'partial')
  assert.equal(e.points, 1)
})

test('an album that GREW since credit still scores 5', () => {
  // Deluxe reissue adds tracks; more than the snapshot is not a deletion.
  const lib = buildLibraryIndex([...LIB, { title: 'Bonus', artist: 'Ken Pomeroy', album: 'Cruel Joke' }])
  assert.equal(evaluateCredit(albumCredit(), lib).points, 5)
})

test('legacy credits are +1 flat and can never go negative', () => {
  // Pre-standings credits carry no identity — we cannot honestly claim a song
  // we never fingerprinted was deleted, so they never turn into −1.
  const lib = buildLibraryIndex([])
  const e = evaluateCredit(songCredit({ legacy: true, keys: undefined }), lib)
  assert.equal(e.status, 'legacy')
  assert.equal(e.points, 1)
})

// ── standings assembly ─────────────────────────────────────────────────────

test('standings rank by points and keep zero-point friends on the board', () => {
  const ledger = {
    'joey levine': { name: 'Joey Levine', adds: 1, tossed: 0 },
    'lorin bloom': { name: 'Lorin Bloom', adds: 11, tossed: 9 },
    'quiet friend': { name: 'Quiet Friend', adds: 3, tossed: 3 },
  }
  const rows = computeStandings([songCredit(), albumCredit()], ledger, LIB)
  assert.deepEqual(rows.map((r) => r.name), ['Lorin Bloom', 'Joey Levine', 'Quiet Friend'])
  assert.deepEqual(rows.map((r) => r.points), [5, 1, 0])
  assert.equal(rows[2].credits.length, 0, 'winless friend still listed')
})

// Jake's rule (2026-08-07): "dan sent a podcast so he should not show in
// standings until he sends a legitimate song. that is the rule." A ledger
// entry with zero adds/credits/tosses = nothing legitimate ever landed —
// hidden from the board entirely, reappears on the first real song.
test('a friend with no legitimate song sent does not appear at all', () => {
  const ledger = {
    'lorin bloom': { name: 'Lorin Bloom', adds: 13, tossed: 9 },
    'dan gottlieb': { name: 'Dan Gottlieb', adds: 0, tossed: 0 },
  }
  const rows = computeStandings([], ledger, LIB)
  assert.deepEqual(rows.map((r) => r.name), ['Lorin Bloom'])
})

test('a friend whose only import was deleted goes NEGATIVE on the board', () => {
  const lib = LIB.filter((t) => t.title !== 'Body Funk')
  const rows = computeStandings([songCredit()], { 'joey levine': { name: 'Joey Levine' } }, lib)
  assert.equal(rows[0].points, -1)
})

// ── album credit detection (the sweep side) ────────────────────────────────

test('album reco earns credit only when matching tracks arrived AFTER the reco', () => {
  const recos = [
    { id: 'a1', kind: 'album', album: 'Cruel Joke', artist: 'Ken Pomeroy', note: 'from Lorin Bloom', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'a2', kind: 'album', album: 'Soulmatic', artist: 'Purple Disco Machine', note: 'from Joey Levine', createdAt: '2026-08-01T00:00:00Z' },
  ]
  const tracks = [
    { title: 'Pareidolia', artist: 'Ken Pomeroy', album: 'Cruel Joke', dateAdded: '2026-08-02T00:00:00Z' },
    { title: 'Stranger', artist: 'Ken Pomeroy', album: 'Cruel Joke', dateAdded: '2026-08-02T00:00:00Z' },
    // Soulmatic was owned BEFORE Joey sent it — proves nothing about his ear.
    { title: 'Body Funk', artist: 'Purple Disco Machine', album: 'Soulmatic', dateAdded: '2026-07-01T00:00:00Z' },
  ]
  const hits = computeAlbumCredits(recos, tracks, new Set(), friendOfNote)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].recoId, 'a1')
  assert.equal(hits[0].friend, 'Lorin Bloom')
  assert.equal(hits[0].n0, 2)
})

test('already-credited and artist-less album recos are skipped', () => {
  const recos = [
    { id: 'a1', kind: 'album', album: 'Cruel Joke', artist: 'Ken Pomeroy', note: 'from Lorin Bloom', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'a3', kind: 'album', album: 'Greatest Hits', artist: '', note: 'from Lorin Bloom', createdAt: '2026-08-01T00:00:00Z' },
  ]
  const tracks = [
    { title: 'Pareidolia', artist: 'Ken Pomeroy', album: 'Cruel Joke', dateAdded: '2026-08-02T00:00:00Z' },
    { title: 'Hit', artist: 'Somebody', album: 'Greatest Hits', dateAdded: '2026-08-02T00:00:00Z' },
  ]
  const hits = computeAlbumCredits(recos, tracks, new Set(['a1']), friendOfNote)
  assert.equal(hits.length, 0, 'a1 already credited; a3 has no artist')
})

test('kind detection matches the renderer precedence', () => {
  assert.equal(creditKindOf({ kind: 'album', song: 'X' }), 'album')
  assert.equal(creditKindOf({ song: 'X' }), 'song')
  assert.equal(creditKindOf({ album: 'Y' }), 'album')
  assert.equal(creditKindOf({}), null)
})
