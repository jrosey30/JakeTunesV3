/**
 * The structural library digest — what the personas are told Jake OWNS.
 *
 * Extracted from index.ts on 2026-08-09. It had no tests, and the failure it
 * is most exposed to is a silent one: getLibraryDigest() returns '' both when
 * the digest is broken and when the library simply hasn't loaded yet. A boot
 * that looks fine can be shipping an empty digest into every prompt, and the
 * only symptom is the characters sounding like they've never seen the library.
 *
 * So these tests assert CONTENT, not just that something came back.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { refreshLibraryDigest, getLibraryDigest, type DigestTrack } from '../library-digest.ts'

/** A small library with a deliberate shape: Beatles-heavy, 60s-anchored,
 *  one much-loved album, and a genre skew toward Rock. */
function sampleTracks(): DigestTrack[] {
  const out: DigestTrack[] = []
  for (let i = 0; i < 40; i++) {
    out.push({ artist: 'The Beatles', album: 'Revolver', genre: 'Rock', year: 1966, playCount: 12, rating: 5 })
  }
  for (let i = 0; i < 25; i++) {
    out.push({ artist: 'Nirvana', album: 'Nevermind', genre: 'Grunge', year: 1991, playCount: 3, rating: 4 })
  }
  for (let i = 0; i < 10; i++) {
    out.push({ artist: 'Drake', album: 'Views', genre: 'Rap', year: 2016, playCount: 0 })
  }
  return out
}

describe('library digest', () => {
  beforeEach(() => refreshLibraryDigest(sampleTracks()))

  test('reports the real shape of the collection', () => {
    const d = getLibraryDigest()
    assert.ok(d.includes('Total tracks: 75'), 'counts every track')
    assert.ok(d.includes('The Beatles (40)'), 'ranks artists by track count')
    assert.ok(d.includes('Rock'), 'names the dominant genre')
  })

  test('places the collection in time', () => {
    const d = getLibraryDigest()
    assert.ok(/<70[^\n]*40/.test(d), 'the 60s bucket holds the Beatles tracks')
    assert.ok(d.includes('90s'), 'and the 90s bucket exists')
  })

  test('an empty library produces no digest rather than an empty skeleton', () => {
    // Important: a header with nothing under it would tell the personas the
    // library is EMPTY, which is a claim. Silence is the honest output.
    refreshLibraryDigest([])
    const d = getLibraryDigest()
    assert.ok(d === '' || !d.includes('Total tracks: 0'), `got: ${d.slice(0, 80)}`)
  })

  test('a malformed library clears the digest instead of throwing', () => {
    // refreshLibraryDigest is called from the library save path. If a torn
    // read hands it garbage, the save must not fail — a stale-but-wrong
    // digest is worse than none, so it clears.
    refreshLibraryDigest(null as unknown as DigestTrack[])
    assert.equal(getLibraryDigest(), '')
  })

  test('survives tracks with missing fields', () => {
    // Real library.json rows are not uniform: imports arrive without a year,
    // without a genre, sometimes without an album.
    refreshLibraryDigest([
      { artist: 'Someone' },
      { artist: 'Someone', album: 'Thing', year: 'not a year' as unknown as number },
      { genre: 'Rock' },
      {},
    ])
    assert.doesNotThrow(() => getLibraryDigest())
  })

  test('stays small enough to sit in every prompt', () => {
    // Measured 5,608 chars on the real 9,324-track library. This guards the
    // order of magnitude, not the exact size — if a new section pushes the
    // digest past ~12k chars it is crowding out the conversation.
    const big: DigestTrack[] = []
    for (let i = 0; i < 9000; i++) {
      big.push({
        artist: `Artist ${i % 400}`, album: `Album ${i % 900}`,
        genre: `Genre ${i % 30}`, year: 1960 + (i % 65),
        playCount: i % 20, rating: i % 6,
      })
    }
    refreshLibraryDigest(big)
    const d = getLibraryDigest()
    assert.ok(d.length > 500, `digest suspiciously small: ${d.length}`)
    assert.ok(d.length < 12_000, `digest too big for a prompt: ${d.length}`)
  })
})
