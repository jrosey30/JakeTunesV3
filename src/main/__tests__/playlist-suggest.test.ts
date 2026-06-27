import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestForPlaylist, type SuggestibleTrack } from '../../renderer/utils/playlistSuggest.ts'

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
