import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseOrbitSeed,
  resolveOrbitSeedIds,
  filterOrbitNeighbors,
  ORBIT_ABS_FLOOR,
} from '../ai/orbit-quality.ts'

function axis(i: number, dim = 8): Float32Array {
  const v = new Float32Array(dim)
  v[i] = 1
  return v
}

describe('parseOrbitSeed', () => {
  it('reads orbit-of subtitle / Because You Played title', () => {
    assert.deepEqual(
      parseOrbitSeed("Because You Played Robson Jo...", "In the orbit of 'Ginga'"),
      { kind: 'title', query: 'Ginga' },
    )
    assert.deepEqual(
      parseOrbitSeed('Because You Played Robson Jorge & Lincoln Olivetti', ''),
      { kind: 'artist', query: 'Robson Jorge & Lincoln Olivetti' },
    )
    assert.equal(parseOrbitSeed('1970s, Your Version', 'The 1970s corner of your library'), null)
  })
})

describe('resolveOrbitSeedIds', () => {
  const lib = [
    { id: 1, title: 'Ginga', artist: 'Robson Jorge & Lincoln Olivetti' },
    { id: 2, title: 'Brazao', artist: 'Robson Jorge & Lincoln Olivetti' },
    { id: 3, title: 'Sir Psycho Sexy', artist: 'Red Hot Chili Peppers' },
    { id: 4, title: 'Cool Buzz', artist: 'Violet Grohl' },
  ]

  it('resolves a song title seed and a truncated artist seed', () => {
    assert.deepEqual(
      resolveOrbitSeedIds({ kind: 'title', query: 'Ginga' }, lib),
      [1],
    )
    const artistHits = resolveOrbitSeedIds({ kind: 'artist', query: 'Robson Jo' }, lib)
    assert.deepEqual(artistHits.sort(), [1, 2])
  })
})

describe('filterOrbitNeighbors', () => {
  it('keeps tight neighbors and floors RHCP-grade false matches', () => {
    // Seed on axis 0 (Brazilian groove). True neighbors share axis 0.
    // RHCP / Violet sit on orthogonal axes — cosine 0 against the seed.
    const seed = axis(0)
    const candidates = [
      { trackId: 1, vec: axis(0) },             // Ginga itself
      { trackId: 2, vec: axis(0) },             // same lane
      { trackId: 3, vec: axis(1) },             // RHCP — orthogonal
      { trackId: 4, vec: axis(2) },             // Violet — orthogonal
    ]
    const kept = filterOrbitNeighbors([seed], candidates, {
      alwaysKeep: new Set([1]),
    })
    const ids = kept.map((k) => k.trackId)
    assert.ok(ids.includes(1), 'seed track stays')
    assert.ok(ids.includes(2), 'same-lane neighbor stays')
    assert.equal(ids.includes(3), false, 'RHCP floored out')
    assert.equal(ids.includes(4), false, 'Violet Grohl floored out')
  })

  it('absolute floor rejects the weak ~0.5 band playlist-vibes documented', () => {
    const seed = axis(0)
    // Mix seed with a little axis-1 bleed so cosine is ~0.5
    const weak = new Float32Array(8)
    weak[0] = Math.SQRT1_2
    weak[1] = Math.SQRT1_2
    const sim = weak[0] // cos with axis(0) = 0.707... wait SQRT1_2 ≈ 0.707
    // Build a weaker one: 0.5 on axis 0, rest noise normalized
    const weak2 = new Float32Array(8)
    weak2[0] = 0.5
    weak2[1] = Math.sqrt(1 - 0.25)
    const kept = filterOrbitNeighbors([seed], [{ trackId: 9, vec: weak2 }])
    assert.ok(ORBIT_ABS_FLOOR > 0.5)
    // cos(seed, weak2) = 0.5 → below abs floor
    assert.equal(kept.length, 0, `score 0.5 must die under floor ${ORBIT_ABS_FLOOR}`)
    void sim
  })
})
