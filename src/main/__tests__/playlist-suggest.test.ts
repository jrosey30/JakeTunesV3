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

// ── Taxonomy-aware suggestions (2026-08-07, "master the songs genre by
// genre... run it with punk first"). METAL VOL 1 regression: a 4-song
// metal/punk playlist in a library thin on Metal TAGS must fill from the
// genre FAMILY (Punk subtree per Jake's umbrella rule), never from an
// equal-vibe different continent.
import { buildGenreProfile, genreFit } from '../../renderer/utils/playlistSuggest.ts'

test('genreFit: same family > same root > elsewhere (punk umbrella holds)', () => {
  const profile = buildGenreProfile([
    { id: 1, subgenrePath: 'Rock › Metal › Nu-Metal' },
    { id: 2, subgenrePath: 'Rock › Metal › Groove Metal' },
    { id: 3, subgenrePath: 'Rock › Punk › Hardcore' },
  ])
  const popPunk = genreFit({ id: 10, subgenrePath: 'Rock › Punk › Pop-Punk' }, profile)
  const classicRock = genreFit({ id: 11, subgenrePath: 'Rock › Classic Rock › Arena' }, profile)
  const synthPop = genreFit({ id: 12, subgenrePath: 'Synth-Pop › Electropop' }, profile)
  const metal = genreFit({ id: 13, subgenrePath: 'Rock › Metal › Thrash' }, profile)
  assert.ok(metal > popPunk, 'own family strongest')
  assert.ok(popPunk > classicRock, 'punk family (sibling under same root, family present in profile) beats generic root-mate')
  assert.ok(classicRock > synthPop, 'same root beats different continent')
})

test('METAL VOL 1: family fills the pool even when raw tags are thin', () => {
  const playlist: SuggestibleTrack[] = [
    { id: 1, title: 'Chop Suey!', artist: 'System Of A Down', genre: 'Metal', subgenrePath: 'Rock › Metal › Nu-Metal', year: 2001 },
    { id: 2, title: 'Before I Forget', artist: 'Slipknot', genre: 'Metal', subgenrePath: 'Rock › Metal › Nu-Metal', year: 2004 },
    { id: 3, title: 'New Noise', artist: 'Refused', genre: 'Rock', subgenrePath: 'Rock › Punk › Hardcore', year: 1998 },
    { id: 4, title: "I'm Not a Punk", artist: 'Descendents', genre: 'Punk', subgenrePath: 'Rock › Punk › Pop-Punk', year: 1982 },
  ]
  const library: SuggestibleTrack[] = [
    ...playlist,
    // Punk-family tracks whose RAW tags don't match the playlist's tags:
    { id: 20, title: 'Rise Above', artist: 'Black Flag', genre: 'Alternative', subgenrePath: 'Rock › Punk › Hardcore', year: 1981 },
    { id: 21, title: 'Astro Zombies', artist: 'Misfits', genre: 'Alternative', subgenrePath: 'Rock › Punk › Horror Punk', year: 1982 },
    { id: 22, title: 'Bleed the Freak', artist: 'Alice in Chains', genre: 'Alternative', subgenrePath: 'Rock › Grunge', year: 1990 },
    // Different continent, plausible on raw signals (year overlap):
    { id: 30, title: 'Take on Me', artist: 'a-ha', genre: 'Pop', subgenrePath: 'Synth-Pop › New Wave', year: 1985 },
    { id: 31, title: 'Blue Monday', artist: 'New Order', genre: 'Pop', subgenrePath: 'Synth-Pop › Electropop', year: 1983 },
  ]
  const picks = suggestForPlaylist(playlist, library, 5, 0)
  const ids = new Set(picks.map((p) => p.id))
  assert.ok(ids.has(20) || ids.has(21), 'punk-family candidates surface despite mismatched raw tags')
  assert.ok(!ids.has(30) && !ids.has(31), 'different-continent tracks stay out')
})
