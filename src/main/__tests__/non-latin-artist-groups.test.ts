/**
 * Artist grouping: which primaries the model is shown (2026-10-11) — the
 * pattern of non-latin-keys.test.ts.
 *
 * tokenize stripped to [a-z0-9]: accented names fell apart ("Björk" → "bj",
 * "rk", both too short), "Benét" became "ben" and matched any Ben, and
 * Hebrew and Cyrillic names were erased. In-memory only (it picks the names
 * sent to the model; every proposal still needs Jake's approval).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeArtistCandidates } from '../artist-groups-core.ts'

const BERRY = 'ברי סחרוף'          // Berry Sakharof
const HADAG = 'הדג נחש'            // Hadag Nahash
const MOLCHAT = 'Молчат Дома'      // Molchat Doma
const KINO = 'Кино'

const lib = (...artists: string[]) => artists.map((artist) => ({ artist }))
const primariesFor = (...artists: string[]): string[] => computeArtistCandidates(lib(...artists)).primaries

describe('computeArtistCandidates — the primaries offered for each joint tag', () => {
  it('a Hebrew or Cyrillic joint credit brings its own primary, and only it', () => {
    assert.deepEqual(primariesFor(`${BERRY} & Rockfour`, BERRY, HADAG, 'Rockfour'), ['Rockfour', BERRY])
    assert.deepEqual(primariesFor(`${MOLCHAT} feat. ${KINO}`, MOLCHAT, KINO, HADAG), [KINO, MOLCHAT])
  })
  it('a two-letter Hebrew name is a whole name, not noise', () => {
    assert.deepEqual(primariesFor(`דג & ${BERRY}`, 'דג', BERRY, HADAG), [BERRY, 'דג'])
  })
  it('accented names fold instead of falling apart', () => {
    assert.deepEqual(primariesFor('Björk & Brodsky Quartet', 'Björk', 'Radiohead'), ['Björk'])
    assert.deepEqual(primariesFor('Beyoncé & JAY-Z', 'Beyonce', 'JAY-Z'), ['Beyonce', 'JAY-Z'])
  })
  it('"Benét" is no longer "ben" — a different Ben is not offered', () => {
    assert.deepEqual(primariesFor('Ben Folds & Regina Spektor', 'Donny Benét', 'Ben Folds'), ['Ben Folds'])
  })
  it('Latin rules hold: short words and stopwords still never match', () => {
    assert.deepEqual(primariesFor('DJ Shadow & Cut Chemist', 'DJ Koze', 'Cut Chemist'), ['Cut Chemist'])
    assert.deepEqual(primariesFor('Bruce Springsteen & The E Street Band', 'Bruce Springsteen', 'The Band'), ['Bruce Springsteen'])
  })
})
