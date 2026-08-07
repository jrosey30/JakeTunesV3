import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestForPlaylist, suggestFromVibeHits, type SuggestibleTrack } from '../../renderer/utils/playlistSuggest.ts'

let nextId = 1
function t(over: Partial<SuggestibleTrack>): SuggestibleTrack {
  return { id: nextId++, title: `Song ${nextId}`, artist: 'Nobody', genre: '', year: 2000, ...over }
}

test('empty playlist → no suggestions', () => {
  assert.deepEqual(suggestForPlaylist([], [t({})], 5), [])
})

test('tracks already on the playlist are never suggested', () => {
  const a = t({ artist: 'Turnstile', genre: 'Hardcore' })
  const b = t({ artist: 'Turnstile', genre: 'Hardcore' })
  const picks = suggestForPlaylist([a], [a, b], 5)
  assert.equal(picks.length, 1)
  assert.equal(picks[0].id, b.id)
})

test('artist affinity outranks genre-only affinity', () => {
  const pl = [t({ artist: 'Turnstile', genre: 'Hardcore', year: 2021 })]
  const sameArtist = t({ artist: 'Turnstile', genre: 'Punk', year: 1999 })
  const sameGenre = t({ artist: 'Scowl', genre: 'Hardcore', year: 2021 })
  const picks = suggestForPlaylist(pl, [sameGenre, sameArtist], 5)
  assert.equal(picks[0].id, sameArtist.id)
  assert.equal(picks[1].id, sameGenre.id)
})

test('non-fitting tracks (no artist/genre/era overlap) are excluded entirely', () => {
  const pl = [t({ artist: 'Turnstile', genre: 'Hardcore', year: 2021 })]
  const noise = t({ artist: 'Mozart', genre: 'Classical', year: 1788 })
  assert.deepEqual(suggestForPlaylist(pl, [noise], 5), [])
})

test('audioMissing tracks are excluded', () => {
  const pl = [t({ artist: 'Turnstile', genre: 'Hardcore' })]
  const missing = t({ artist: 'Turnstile', genre: 'Hardcore', audioMissing: true })
  assert.deepEqual(suggestForPlaylist(pl, [missing], 5), [])
})

test('variety: 5 distinct artists when the pool has enough', () => {
  const pl = [t({ artist: 'Turnstile', genre: 'Hardcore', year: 2021 })]
  const lib = [
    ...Array.from({ length: 5 }, () => t({ artist: 'Turnstile', genre: 'Hardcore', year: 2021 })),
    t({ artist: 'Scowl', genre: 'Hardcore', year: 2021 }),
    t({ artist: 'Gel', genre: 'Hardcore', year: 2022 }),
    t({ artist: 'Spy', genre: 'Hardcore', year: 2021 }),
    t({ artist: 'Drug Church', genre: 'Hardcore', year: 2018 }),
    t({ artist: 'Militarie Gun', genre: 'Hardcore', year: 2023 }),
  ]
  const picks = suggestForPlaylist(pl, lib, 5)
  assert.equal(picks.length, 5)
  assert.equal(new Set(picks.map(p => p.artist)).size, 5, 'all 5 picks should be different artists')
})

test('variety: relaxes the per-artist cap only when artists are scarce', () => {
  const pl = [t({ artist: 'Turnstile', genre: 'Hardcore', year: 2021 })]
  const lib = [
    ...Array.from({ length: 8 }, () => t({ artist: 'Turnstile', genre: 'Hardcore', year: 2021 })),
    ...Array.from({ length: 4 }, () => t({ artist: 'Scowl', genre: 'Hardcore', year: 2021 })),
    ...Array.from({ length: 4 }, () => t({ artist: 'Gel', genre: 'Hardcore', year: 2022 })),
  ]
  // only 3 distinct artists but several tracks each; limit 5 → cap relaxes evenly to ≤2
  const picks = suggestForPlaylist(pl, lib, 5)
  assert.equal(picks.length, 5)
  const maxPer = Math.max(...[...new Set(picks.map(p => p.artist))]
    .map(a => picks.filter(p => p.artist === a).length))
  assert.ok(maxPer <= 2, `expected ≤2 per artist after relaxation, got ${maxPer}`)
})

test('rotate pages deeper into the pool (different leading pick)', () => {
  const pl = [t({ artist: 'Turnstile', genre: 'Hardcore', year: 2021 })]
  const lib = Array.from({ length: 12 }, (_, i) => t({ artist: `Band ${i}`, genre: 'Hardcore', year: 2021, playCount: 12 - i }))
  const page0 = suggestForPlaylist(pl, lib, 5, 0)
  const page1 = suggestForPlaylist(pl, lib, 5, 1)
  assert.equal(page0.length, 5)
  assert.equal(page1.length, 5)
  assert.notEqual(page0[0].id, page1[0].id)
})

test('deterministic: same inputs → same picks', () => {
  const pl = [t({ artist: 'Turnstile', genre: 'Hardcore', year: 2021 })]
  const lib = Array.from({ length: 20 }, (_, i) => t({ artist: `Band ${i % 6}`, genre: 'Hardcore', year: 2018 + (i % 5) }))
  assert.deepEqual(
    suggestForPlaylist(pl, lib, 5, 0).map(p => p.id),
    suggestForPlaylist(pl, lib, 5, 0).map(p => p.id),
  )
})

// ── suggestFromVibeHits: seat eligibility + refresh rotation ──────────────
// Jake, 2026-08-07: "pool dos sometimes suggests like pantera or rage
// against the machine" (a 1-song outlier corner bought a guaranteed strip
// seat) and "refresh ... eliminates songs from the recommendations as i
// keep pressing. cant happen" (unwrapped rotate ran off the pools).

function vibeFixture() {
  const playlist: SuggestibleTrack[] = Array.from({ length: 10 }, (_, i) => ({ id: 1000 + i, title: `pool ${i}`, artist: `chill${i}`, genre: 'Chill' }))
  const chillLib: SuggestibleTrack[] = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `groove ${i}`, artist: `artist${i}`, genre: 'Chill' }))
  const metalLib: SuggestibleTrack[] = [
    { id: 90, title: 'Walk', artist: 'Pantera', genre: 'Metal' },
    { id: 91, title: 'Bulls on Parade', artist: 'Rage Against the Machine', genre: 'Metal' },
  ]
  const hits = [
    ...chillLib.map((tr, i) => ({ trackId: tr.id, score: 0.8 - i * 0.01, cluster: 0 })),
    ...metalLib.map((tr, i) => ({ trackId: tr.id, score: 0.85 - i * 0.01, cluster: 1 })),
  ]
  return { playlist, library: [...chillLib, ...metalLib], hits }
}

test('a 1-seed outlier cluster earns NO seat on a real playlist', () => {
  const { playlist, library, hits } = vibeFixture()
  const picks = suggestFromVibeHits(playlist, library, hits, 5, 0, [9, 1])
  assert.equal(picks.length, 5)
  assert.ok(!picks.some((p) => p.genre === 'Metal'), 'no metal from the 1-seed corner')
})

test('a genuine 2+ seed corner keeps its seat (eclectic playlists still surface corners)', () => {
  const { playlist, library, hits } = vibeFixture()
  const picks = suggestFromVibeHits(playlist, library, hits, 5, 0, [8, 2])
  assert.ok(picks.some((p) => p.genre === 'Metal'), 'real corner represented')
})

test('tiny playlists keep every cluster — each song IS the vibe', () => {
  const { library, hits } = vibeFixture()
  const tiny: SuggestibleTrack[] = Array.from({ length: 4 }, (_, i) => ({ id: 1000 + i, title: `s${i}`, artist: `a${i}` }))
  const picks = suggestFromVibeHits(tiny, library, hits, 5, 0, [3, 1])
  assert.ok(picks.some((p) => p.genre === 'Metal'))
})

test('refresh NEVER empties the strip — rotate wraps forever', () => {
  const { playlist, library, hits } = vibeFixture()
  for (let rotate = 0; rotate < 40; rotate++) {
    const picks = suggestFromVibeHits(playlist, library, hits, 5, rotate, [9, 1])
    assert.equal(picks.length, 5, `rotate=${rotate} must still fill the strip`)
  }
})

test('an ECLECTIC playlist (no dominant vibe) keeps every corner', () => {
  const { playlist, library, hits } = vibeFixture()
  // Five vibes, none holding half the playlist — nothing gets dropped.
  const picks = suggestFromVibeHits(playlist, library, hits, 5, 0, [3, 2, 2, 2, 1])
  assert.ok(picks.some((p) => p.genre === 'Metal'), 'no vibe dropped on a mosaic playlist')
})
