/**
 * The main brain's text is PLAIN (2026-10-10): artist — title, album (year),
 * genre tag. Since Brief 181 there is ONE implementation —
 * src/common/embedding-text.ts — consumed by the desktop
 * (src/main/ai/embeddings.ts buildEmbeddingText, src/main/ai/mood-index.ts
 * buildMoodText, src/main/ai/tempo-energy.ts tempoEnergyText) and by the
 * homemini trainer (scripts/brain-trainer.mjs). It used to be hand-synced
 * twins in those files, held together by ⚠️ TWIN comments and this test's
 * source-shape pins; the twins had already drifted on untrimmed string
 * fields (the trainer interpolated a padded year raw, the app trimmed it).
 *
 * Byte-equality of the single source against BOTH frozen pre-181
 * implementations is guarded by scripts/__tests__/embedding-text.test.mjs;
 * this suite pins the wiring (every consumer delegates, nobody redefines)
 * and the plain shape. Source-level for embeddings.ts / mood-index.ts /
 * the trainer: those modules have load-time side effects (Electron; the
 * trainer reads its API key), so their shapes are pinned here instead of
 * imported.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseText, moodText } from '../../common/embedding-text.ts'
import { tempoEnergyText } from '../ai/tempo-energy.ts'

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
const canonical = readFileSync(join(root, 'src/common/embedding-text.ts'), 'utf8')
const canonicalBase = body(canonical, 'export function baseText(')
const embeddingsSrc = readFileSync(join(root, 'src/main/ai/embeddings.ts'), 'utf8')
const moodIndexSrc = readFileSync(join(root, 'src/main/ai/mood-index.ts'), 'utf8')
const tempoEnergySrc = readFileSync(join(root, 'src/main/ai/tempo-energy.ts'), 'utf8')
const trainerSrc = readFileSync(join(root, 'scripts/brain-trainer.mjs'), 'utf8')
const enriched = body(trainerSrc, 'function enrichedText(')

const lineKinds = (fn: string): string[] => [...fn.matchAll(/lines\.push\(`([a-z]+)?/g)].map((m) => m[1] ?? 'artist—title')
  .concat(/lines\.push\(`\$\{artist/.test(fn) ? ['artist—title'] : [])

describe('the main brain text is plain, from ONE source (Brief 181)', () => {
  it('canonical baseText: only artist — title, album (year) / year, genre', () => {
    for (const banned of ['subgenre', 'members', 'loved', 'tempoEnergy', 'plays', 'sound and mood', 'meaning']) {
      assert.equal(canonicalBase.includes(banned), false, `canonical baseText mentions ${banned}`)
    }
    assert.deepEqual([...new Set(lineKinds(canonicalBase))].sort(), ['album', 'artist—title', 'genre', 'year'])
  })

  it('desktop buildEmbeddingText delegates to the canonical baseText', () => {
    const fn = body(embeddingsSrc, 'export function buildEmbeddingText(')
    assert.match(fn, /return baseText\(t\)/)
  })

  it('desktop buildMoodText delegates to the canonical moodText', () => {
    const fn = body(moodIndexSrc, 'export function buildMoodText(')
    assert.match(fn, /return moodText\(t, descriptor\)/)
  })

  it('tempo-energy.ts is a re-export shim, not an implementation', () => {
    assert.match(tempoEnergySrc, /export \{ tempoEnergyText, KEY_CONFIDENCE_FLOOR, type TempoEnergyInput \} from '\.\.\/\.\.\/common\/embedding-text\.ts'/)
    assert.equal(tempoEnergySrc.includes('function tempoEnergyText('), false)
  })

  it('trainer imports the canonical texts and defines none of the twins', () => {
    assert.match(trainerSrc, /from '\.\.\/src\/common\/embedding-text\.ts'/)
    for (const fn of ['function baseText(t)', 'function moodText(t, d)', 'function tempoEnergy(t)']) {
      assert.equal(trainerSrc.includes(fn), false, `trainer still defines ${fn}`)
    }
  })

  it('trainer: every main re-embed goes through baseText (descriptors and meaning stay out)', () => {
    assert.match(enriched, /return baseText\(t\)/)
    assert.equal(/sound and mood|meaning:/.test(enriched), false)
  })

  it('the mood text still carries the descriptor (vibe searches route there)', () => {
    const s = moodText({ genre: 'Rock', bpm: 100 }, 'warm and loud')
    assert.match(s, /sound and mood: warm and loud/)
    assert.match(s, /genre: Rock/)
  })

  it('runtime: the tempo-energy shim serves the canonical function', () => {
    const t = { bpm: 128, keyRoot: 'A', keyMode: 'minor', camelotKey: '8A', keyConfidence: 0.9 }
    assert.equal(tempoEnergyText(t), 'tempo: 128 BPM, fast, driving, propulsive · key: A minor — darker, moody, melancholy, introspective · good for: driving late-night, workout, intense focus · camelot 8A')
    assert.match(baseText({ artist: 'A', title: 'T', album: 'Alb', year: 1999, genre: 'Rock' }), /A — T\nalbum: Alb \(1999\)\ngenre: Rock/)
  })
})
