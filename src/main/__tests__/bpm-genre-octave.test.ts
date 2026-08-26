import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { genreOctaveFix } from '../bpm-genre-octave.ts'

describe('genreOctaveFix — only where the tempo convention is hard', () => {
  test('doubles a halved house track (Jake’s actual case)', () => {
    assert.equal(genreOctaveFix({ id: 10838, bpm: 64, genre: 'House' }), 128)
    assert.equal(genreOctaveFix({ id: 2, bpm: 63.3, genre: 'Deep House' }), 126.6)
  })

  test('NEVER touches punk — the trap that wrecked the old script', () => {
    // fix-bpm-octaves.mjs wanted blink-182 at 191-204. First Date is ~158.
    assert.equal(genreOctaveFix({ id: 3, bpm: 95.7, genre: 'Punk' }), null)
    assert.equal(genreOctaveFix({ id: 4, bpm: 78, genre: 'Pop-Punk' }), null)
    assert.equal(genreOctaveFix({ id: 5, bpm: 102.1, genre: 'Punk' }), null)
  })

  test('leaves a plausible dance tempo alone', () => {
    assert.equal(genreOctaveFix({ id: 6, bpm: 124, genre: 'House' }), null)
    assert.equal(genreOctaveFix({ id: 7, bpm: 128, genre: 'Techno' }), null)
  })

  test('refuses when doubling would overshoot the genre band', () => {
    // 80 -> 160 is too fast for house; do not guess.
    assert.equal(genreOctaveFix({ id: 8, bpm: 80, genre: 'House' }), null)
  })

  test('no genre, no opinion', () => {
    assert.equal(genreOctaveFix({ id: 9, bpm: 64, genre: '' }), null)
    assert.equal(genreOctaveFix({ id: 10, bpm: 64, genre: 'Rock' }), null)
  })
})
