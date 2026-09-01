/** 3c reranker — pins the lexical-fit semantics the 2026-09-01 weight
 *  sweep validated (retrieval_prod 0.753 → 0.815 at w=0.08). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { genreLexicalFit, rerankHits, rerankQueryTokens } from '../ai/rag-rerank.ts'

describe('rerankQueryTokens', () => {
  test('drops stopwords and short tokens, folds case', () => {
    assert.deepEqual(rerankQueryTokens('Heavy crushing guitars and screaming'),
      ['heavy', 'crushing', 'guitars', 'screaming'])
    // every word here is a stopword ('night' included — vibe filler)
    assert.deepEqual(rerankQueryTokens('songs for the night'), [])
  })
})

describe('genreLexicalFit', () => {
  const fit = (q: string, g: string) => genreLexicalFit(rerankQueryTokens(q), g)
  test('exact word: "reggae and ska vibes" hits genre Reggae', () => {
    assert.equal(fit('sunny feel-good reggae and ska vibes', 'Reggae'), 1)
  })
  test('containment with 4-char guard: "jazzy" ↔ Jazz, "heavy" ↔ Heavy Metal', () => {
    assert.equal(fit('smooth jazzy grooves', 'Jazz'), 1)
    assert.equal(fit('heavy crushing guitars', 'Heavy Metal'), 1)
  })
  test('3-char tokens need an exact genre word — "pop" does not hit "popular"', () => {
    assert.equal(fit('pop bangers', 'Popular Novelty'), 0)
    assert.equal(fit('pop bangers', 'Pop'), 1)
  })
  test('no genre text, no fit', () => {
    assert.equal(fit('anything at all', ''), 0)
  })
})

describe('rerankHits', () => {
  const genres = new Map([[1, 'Electronic'], [2, 'Jazz'], [3, 'Metal']])
  const hits = [
    { trackId: 1, score: 0.70 },
    { trackId: 2, score: 0.67 },
    { trackId: 3, score: 0.66 },
  ]
  test('on-genre candidate below the cut gets promoted (and can overtake)', () => {
    const out = rerankHits('heavy metal riffs', hits, genres, 2, 0.08)
    // 3: 0.66 + 0.08 = 0.74 beats 1's 0.70; 2 (Jazz, no fit) drops out.
    assert.deepEqual(out.map(h => h.trackId), [3, 1])
  })
  test('weight 0 is a pure slice — cosine order preserved', () => {
    const out = rerankHits('heavy metal riffs', hits, genres, 2, 0)
    assert.deepEqual(out.map(h => h.trackId), [1, 2])
  })
  test('no matching tokens leaves cosine order intact', () => {
    const out = rerankHits('something entirely unrelated', hits, genres, 3, 0.08)
    assert.deepEqual(out.map(h => h.trackId), [1, 2, 3])
  })
  test('blended score is returned, monotonically ordered', () => {
    const out = rerankHits('jazz night', hits, genres, 3, 0.1)
    assert.equal(out[0].trackId, 2)
    for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score)
  })
})
