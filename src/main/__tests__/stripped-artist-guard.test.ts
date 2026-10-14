/**
 * The "The"-stripped artist guard (E6, rag-route.ts; brain-eval
 * PROPOSAL-p2-stripped-artist-guard, variant S2): "beatles songs" reaches The
 * Beatles, but a band named like an ordinary word ("doors", "cars") only
 * claims a query that is clearly about the band.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { queryNamesArtist, buildStrippedArtists, strippedVariant, isOrdinaryWord, restoreStrippedArtist } from '../ai/rag-route.ts'

const keys = ['the beatles', 'the clash', 'the cure', 'the doors', 'the smiths', 'the police', 'the killers', 'the cars',
  'the beat', 'the band', 'the sleeping', 'the faint', 'the zombies', 'the animals', 'the rolling stones', 'the weeknd', 'the jam']
const words = new Set(['clash', 'cure', 'door', 'smith', 'police', 'killer', 'car', 'beat', 'band', 'sleeping', 'faint', 'zombie', 'animal'])
const set = new Set(keys)
const stripped = buildStrippedArtists(keys, words)
const routesToArtist = (q: string): boolean => queryNamesArtist(q, set, stripped)

describe('band searches without "The" reach the band', () => {
  for (const q of ['clash songs', 'cure songs', 'doors songs', 'smiths songs', 'police', 'killers songs', 'beatles tracks',
    'play some doors', 'music by the cars', 'songs by cars', 'best smiths songs', 'something like the beatles but sadder']) {
    it(q, () => assert.equal(routesToArtist(q), true))
  }
  it('a plain-name band matches anywhere in the query', () => {
    assert.equal(routesToArtist('a weeknd-style late night playlist'), true, 'the fold reads the hyphen as a space')
    assert.equal(routesToArtist('late night weeknd vibes'), true)
    assert.equal(routesToArtist('rolling stones deep cuts'), true)
  })
})

describe('vibe searches with ordinary words stay vibe searches (the 12 the naive version hijacked 10 of)', () => {
  for (const q of ['music for sleeping', 'songs with a heavy beat', 'big band music', 'songs about cars', 'faint dreamy vocals',
    'something to cure a bad mood', 'halloween party zombies and monsters', 'upbeat dance beat', 'animals and nature sounds',
    'behind closed doors vibes', 'driving music', 'late night chill']) {
    it(q, () => assert.equal(routesToArtist(q), false))
  }
})

describe('the sorting rules', () => {
  it('short and genre-word variants never route; no "the" no variant', () => {
    assert.equal(strippedVariant('the jam'), null)
    assert.equal(strippedVariant('the house'), null)
    assert.equal(strippedVariant('beatles'), null)
    assert.equal(strippedVariant('the beatles'), 'beatles')
  })
  it('plurals of ordinary words count as ordinary; multi-word variants never do', () => {
    assert.equal(isOrdinaryWord('doors', words), true)
    assert.equal(isOrdinaryWord('beatles', words), false)
    assert.equal(isOrdinaryWord('rolling stones', words), false)
  })
  it('with no dictionary every single-word variant is cautious (template-only)', () => {
    const cautious = buildStrippedArtists(keys, null)
    assert.equal(queryNamesArtist('beatles tracks', set, cautious), true)
    assert.equal(queryNamesArtist('late night beatles vibes', set, cautious), false)
    assert.equal(queryNamesArtist('rolling stones deep cuts', set, cautious), true, 'multi-word stays plain')
  })
  it('without the stripped set, behavior is exactly as before', () => {
    assert.equal(queryNamesArtist('beatles songs', set), false)
    assert.equal(queryNamesArtist('the beatles songs', set), true)
  })
})

describe('the band is searched under its real name', () => {
  it('a bare name gets its "the" back; anything else is untouched', () => {
    assert.equal(restoreStrippedArtist('clash songs', set, stripped), 'the clash songs')
    assert.equal(restoreStrippedArtist('Play some Doors', set, stripped), 'play some the doors')
    assert.equal(restoreStrippedArtist('late night weeknd vibes', set, stripped), 'late night the weeknd vibes')
    assert.equal(restoreStrippedArtist('The Clash songs', set, stripped), 'The Clash songs')
    assert.equal(restoreStrippedArtist('songs about cars', set, stripped), 'songs about cars')
  })
})

describe('wired into the live router', () => {
  it('pickRetrievalIndex passes the stripped set', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'ai', 'rag-retrieval.ts'), 'utf8')
    assert.match(src, /queryNamesArtist\(query, await ragLibraryArtistSet\(\), await ragStrippedArtists\(\)\)/)
  })
  it('the embed text goes through restoreStrippedArtist on main-routed queries', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'ai', 'rag-retrieval.ts'), 'utf8')
    assert.match(src, /route === 'main' \? restoreStrippedArtist\(query/)
  })
})
