import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scorePlaylistCandidates, kmeansCentroids, cosine } from '../playlist-vibes.ts'

/** Unit vector in a 8-dim space, angled between axes a and b. */
function vec(a: number, b: number, mix = 0): Float32Array {
  const v = new Float32Array(8)
  const wa = Math.cos((mix * Math.PI) / 2)
  const wb = Math.sin((mix * Math.PI) / 2)
  v[a] = wa; v[b] = wb
  return v
}

// Two real vibes (axis 0 = "groove", axis 1 = "samba") with tight seed
// packs, plus ONE outlier seed off on axis 7 ("rock"). Candidate pool:
// plenty of close groove/samba matches, and only FAR matches near the
// outlier axis (nothing in the library sounds like it).
function fixture() {
  const seeds = [
    vec(0, 2, 0.05), vec(0, 2, 0.10), vec(0, 2, 0.15), vec(0, 2, 0.08),   // groove pack
    vec(1, 3, 0.05), vec(1, 3, 0.12), vec(1, 3, 0.09),                     // samba pack
    vec(7, 6, 0.05),                                                       // the lone rock song
  ]
  const candidates: Array<[number, Float32Array]> = []
  let id = 100
  for (let i = 0; i < 15; i++) candidates.push([id++, vec(0, 2, 0.06 + i * 0.01)])   // strong groove matches
  for (let i = 0; i < 15; i++) candidates.push([id++, vec(1, 3, 0.06 + i * 0.01)])   // strong samba matches
  for (let i = 0; i < 15; i++) candidates.push([id++, vec(7, 5, 0.75 - i * 0.01)])   // WEAK rock-ish matches (mostly axis 5)
  return { seeds, candidates }
}

describe('playlist-vibes — scorePlaylistCandidates quality floor', () => {
  it('an outlier seed cluster with only weak matches serves NOTHING', () => {
    const { seeds, candidates } = fixture()
    const { hits } = scorePlaylistCandidates(seeds, candidates, null, 3)
    const servedIds = new Set(hits.map((h) => h.trackId))
    // every weak rock-ish candidate (ids 130-144) is floored out
    for (let id = 130; id < 145; id++) assert.equal(servedIds.has(id), false, `weak match ${id} must not serve`)
    // both real vibes still serve their strong matches
    assert.ok([...servedIds].some((i) => i >= 100 && i < 115), 'groove cluster serves')
    assert.ok([...servedIds].some((i) => i >= 115 && i < 130), 'samba cluster serves')
  })

  it('healthy multi-vibe playlists keep every cluster (no diversity regression)', () => {
    const { seeds, candidates } = fixture()
    // drop the outlier seed + its weak candidates → all clusters healthy
    const { hits } = scorePlaylistCandidates(seeds.slice(0, 7), candidates.slice(0, 30), null, 2)
    const clusters = new Set(hits.map((h) => h.cluster))
    assert.equal(clusters.size, 2, 'both sub-vibes represented')
  })

  it('the floor self-calibrates: uniformly weaker space still serves', () => {
    const { seeds, candidates } = fixture()
    // scale every candidate down (poorer matches across the board — e.g.
    // after a re-embed shifts the space). Median-relative floor must adapt.
    const damped: Array<[number, Float32Array]> = candidates.slice(0, 30).map(([id, v]) => {
      const w = new Float32Array(v.length)
      for (let i = 0; i < v.length; i++) w[i] = v[i] * 0.7
      w[4] = Math.sqrt(1 - 0.49) // keep unit-ish norm, off-vibe component
      return [id, w]
    })
    const { hits } = scorePlaylistCandidates(seeds.slice(0, 7), damped, null, 2)
    assert.ok(hits.length > 0, 'a uniformly-weak library still suggests its best')
  })

  it('single-vibe playlist works (k collapses to seed count)', () => {
    const seeds = [vec(0, 2, 0.05), vec(0, 2, 0.1)]
    const candidates: Array<[number, Float32Array]> = [[1, vec(0, 2, 0.07)], [2, vec(0, 2, 0.12)]]
    const { hits } = scorePlaylistCandidates(seeds, candidates, null, 5)
    assert.equal(hits.length, 2)
  })

  it('empty inputs are safe', () => {
    assert.deepEqual(scorePlaylistCandidates([], [], null, 5), { hits: [], clusterSeeds: [] })
    assert.deepEqual(scorePlaylistCandidates([vec(0, 1)], [], null, 5).hits, [])
  })

  it('global-center penalty still applies to scores', () => {
    const seeds = [vec(0, 2, 0.05), vec(0, 2, 0.1)]
    const generic = vec(0, 2, 0.07)
    const hitsNoGc = scorePlaylistCandidates(seeds, [[1, generic]], null, 1).hits
    const hitsGc = scorePlaylistCandidates(seeds, [[1, generic]], generic, 1).hits
    assert.ok(hitsGc[0].score < hitsNoGc[0].score, 'penalized when near the global center')
  })

  it('clusterSeeds reports how many playlist songs seeded each sub-vibe', () => {
    const { seeds, candidates } = fixture()
    const { clusterSeeds } = scorePlaylistCandidates(seeds, candidates, null, 3)
    assert.equal(clusterSeeds.reduce((s, n) => s + n, 0), seeds.length, 'every seed assigned')
    // The fixture's outlier is a single seed — exactly one 1-seed cluster.
    assert.ok(clusterSeeds.includes(1), 'outlier occupies its own 1-seed cluster')
  })
})

describe('playlist-vibes — kmeansCentroids', () => {
  it('separates two obvious packs', () => {
    const packA = [vec(0, 2, 0.02), vec(0, 2, 0.06), vec(0, 2, 0.1)]
    const packB = [vec(5, 6, 0.02), vec(5, 6, 0.06), vec(5, 6, 0.1)]
    const cents = kmeansCentroids([...packA, ...packB], 2)
    assert.equal(cents.length, 2)
    const simsA = cents.map((c) => cosine(packA[0], c))
    const simsB = cents.map((c) => cosine(packB[0], c))
    assert.notEqual(simsA.indexOf(Math.max(...simsA)), simsB.indexOf(Math.max(...simsB)))
  })

  it('k is clamped to the seed count', () => {
    assert.equal(kmeansCentroids([vec(0, 1)], 5).length, 1)
  })
})

// 2026-08-25 — Jake on a 7-song eclectic playlist: "only 2 suggestions?????"
// The floor is right for a playlist with one clear character; on a mosaic it
// starved the strip. The backfill must relax rather than serve an empty shelf.
describe('vibe floor backfill — an eclectic playlist still fills the strip', () => {
  it('yields a usable pool instead of a handful', () => {
    const dim = 8
    const unit = (i: number) => { const v = new Float32Array(dim); v[i % dim] = 1; return v }
    const seeds = [0, 1, 2, 3, 4].map(unit)   // five distant corners = a mosaic
    const candidates = new Map<number, Float32Array>()
    for (let i = 0; i < 120; i++) {
      const v = new Float32Array(dim)
      v[i % 5] = 0.6
      v[(i * 7) % dim] += 0.4
      candidates.set(i + 1, v)
    }
    const { hits } = scorePlaylistCandidates(seeds, candidates, null)
    assert.ok(hits.length >= 40, `expected a usable pool, got ${hits.length}`)
  })
})
