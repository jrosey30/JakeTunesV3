/**
 * The main brain's text is PLAIN (2026-10-10): artist — title, album (year),
 * genre tag — in BOTH twins, the homemini trainer (scripts/brain-trainer.mjs
 * baseText / enrichedText) and the desktop (src/main/ai/embeddings.ts
 * buildEmbeddingText, used for new imports between trainer runs). Vectors from
 * the two must live in one space. The measurements behind the recipe are in
 * embeddings.ts. Source-level: both modules have load-time side effects
 * (Electron; the trainer reads its API key), so the shapes are pinned here.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '..')
const body = (src: string, header: string): string => {
  const i = src.indexOf(header)
  assert.ok(i >= 0, `missing ${header}`)
  let depth = 0
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1)
  }
  throw new Error(`unterminated ${header}`)
}
const desktop = body(readFileSync(join(root, 'src/main/ai/embeddings.ts'), 'utf8'), 'export function buildEmbeddingText(')
const trainerSrc = readFileSync(join(root, 'scripts/brain-trainer.mjs'), 'utf8')
const trainer = body(trainerSrc, 'function baseText(t) {')
const enriched = body(trainerSrc, 'function enrichedText(')

const lineKinds = (fn: string): string[] => [...fn.matchAll(/lines\.push\(`([a-z]+)?/g)].map((m) => m[1] ?? 'artist—title')
  .concat(/const lines = \[`\$\{/.test(fn) ? ['artist—title'] : [])

describe('the main brain text is plain, in both twins', () => {
  it('desktop: only artist — title, album (year) / year, genre', () => {
    for (const banned of ['subgenre', 'members', 'loved', 'tempoEnergy', 'plays', 'sound and mood', 'meaning']) {
      assert.equal(desktop.includes(banned), false, `desktop buildEmbeddingText mentions ${banned}`)
    }
    assert.deepEqual([...new Set(lineKinds(desktop))].sort(), ['album', 'artist—title', 'genre', 'year'])
  })

  it('trainer: baseText is the same plain shape', () => {
    for (const banned of ['subgenre', 'members', 'loved', 'tempoEnergy', 'plays', 'sound and mood', 'meaning']) {
      assert.equal(trainer.includes(banned), false, `trainer baseText mentions ${banned}`)
    }
    assert.deepEqual([...new Set(lineKinds(trainer))].sort(), ['album', 'artist—title', 'genre', 'year'])
  })

  it('trainer: every main re-embed goes through baseText (descriptors and meaning stay out)', () => {
    assert.match(enriched, /return baseText\(t\)/)
    assert.equal(/sound and mood|meaning:/.test(enriched), false)
  })

  it('the mood index still carries the descriptor (vibe searches route there)', () => {
    const mood = body(trainerSrc, 'function moodText(t, d) {')
    assert.match(mood, /sound and mood/)
  })
})
