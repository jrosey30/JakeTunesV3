import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeArtistCandidates, parseGroupingResponse, parseRelatedArtists } from '../artist-groups-core.ts'

describe('artist-groups-core — computeArtistCandidates', () => {
  it('picks marker tags as candidates + token-sharing primaries', () => {
    const tracks = [
      ...Array(22).fill({ artist: 'Paul McCartney & Wings' }),
      ...Array(45).fill({ artist: 'Paul McCartney' }),
      { artist: 'Paul McCartney & Stevie Wonder' },
      ...Array(10).fill({ artist: 'AC/DC' }),
      ...Array(5).fill({ artist: 'Radiohead' }),
    ]
    const { candidates, primaries } = computeArtistCandidates(tracks)
    const tags = candidates.map((c) => c.tag)
    assert.ok(tags.includes('Paul McCartney & Wings'))
    assert.ok(tags.includes('Paul McCartney & Stevie Wonder'))
    assert.ok(tags.includes('AC/DC'))           // "/" is a marker → candidate (AI calls it standalone)
    assert.ok(!tags.includes('Paul McCartney'))  // no marker → not a candidate
    assert.ok(primaries.includes('Paul McCartney'))  // shares "paul"/"mccartney" with a candidate
    assert.ok(!primaries.includes('Radiohead'))      // no token overlap with any candidate
  })

  it('sorts candidates by track count desc', () => {
    const tracks = [...Array(3).fill({ artist: 'A & B' }), ...Array(9).fill({ artist: 'C & D' })]
    const { candidates } = computeArtistCandidates(tracks)
    assert.equal(candidates[0].tag, 'C & D')
  })
})

describe('artist-groups-core — parseGroupingResponse', () => {
  it('parses a code-fenced array', () => {
    const out = parseGroupingResponse('```json\n[{"tag":"Wings","type":"persona","canonical":"Paul McCartney","why":"his band"}]\n```')
    assert.equal(out.length, 1)
    assert.equal(out[0].canonical, 'Paul McCartney')
  })

  it('downgrades a persona with no / identity canonical to standalone (not actionable)', () => {
    const out = parseGroupingResponse('[{"tag":"Wings","type":"persona"},{"tag":"X","type":"persona","canonical":"X"}]')
    assert.equal(out[0].type, 'standalone')
    assert.equal(out[1].type, 'standalone')
  })

  it('keeps collaboration contributors', () => {
    const out = parseGroupingResponse('[{"tag":"A & B","type":"collaboration","contributors":["A","B"],"why":"duet"}]')
    assert.deepEqual(out[0].contributors, ['A', 'B'])
  })

  it('returns [] on garbage / empty', () => {
    assert.deepEqual(parseGroupingResponse('no json here'), [])
    assert.deepEqual(parseGroupingResponse(''), [])
  })
})

describe('artist-groups-core — parseRelatedArtists', () => {
  it('parses {name,relation} and dedupes by name (case-insensitive)', () => {
    const out = parseRelatedArtists('[{"name":"The Beatles","relation":"band"},{"name":"John Lennon","relation":"member"},{"name":"the beatles","relation":"band"}]')
    assert.deepEqual(out.map((r) => r.name), ['The Beatles', 'John Lennon'])
    assert.equal(out[0].relation, 'band')
  })
  it('whitelists relations — drops collaborator/bandmate (producers, minor members) and skips nameless', () => {
    const out = parseRelatedArtists('[{"name":"George Martin","relation":"collaborator"},{"name":"Pete Best","relation":"bandmate"},{"name":"Wings","relation":"sideProject"},{"name":"Turnstile","relation":"similar"},{"relation":"band"}]')
    assert.deepEqual(out.map((r) => r.name), ['Wings', 'Turnstile'])
  })
  it('returns [] on garbage', () => {
    assert.deepEqual(parseRelatedArtists('nope'), [])
  })
})
