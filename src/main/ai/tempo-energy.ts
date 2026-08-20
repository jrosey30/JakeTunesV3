/**
 * Grounded tempo / key / Camelot text folded into embed + mood vectors.
 * Pure — no Electron / disk — so unit tests can import it.
 *
 * ⚠️ TWIN: scripts/brain-trainer.mjs tempoEnergy() — keep in lockstep.
 */

export interface TempoEnergyInput {
  bpm?: number
  keyRoot?: string
  keyMode?: string
  camelotKey?: string
  /** 0..1 from Essentia key vote. Weak keys stay out of the brain text. */
  keyConfidence?: number | string | null
}

/** Below this, key/mode adjectives and Camelot stay OUT of embed text. */
export const KEY_CONFIDENCE_FLOOR = 0.45

/**
 * Measured 2026-07-26 against the real library; key-confidence gate added
 * 2026-08-20. See embeddings.ts buildEmbeddingText for how this line is used.
 */
export function tempoEnergyText(t: TempoEnergyInput): string {
  const b = Number(t.bpm) || 0
  if (b <= 0) return ''
  const tempo =
    b < 88 ? 'slow, spacious, downtempo'
    : b < 100 ? 'relaxed, loping mid-tempo'
    : b < 112 ? 'steady mid-tempo groove'
    : b < 122 ? 'brisk, forward-moving'
    : b < 134 ? 'fast, driving, propulsive'
    : 'very fast, urgent, relentless'

  const parts = [`tempo: ${Math.round(b)} BPM, ${tempo}`]

  const root = (t.keyRoot || '').trim()
  const mode = (t.keyMode || '').trim().toLowerCase()
  const confRaw = t.keyConfidence
  const conf = confRaw == null || confRaw === '' ? null : Number(confRaw)
  const keyTrusted = conf == null || (Number.isFinite(conf) && conf >= KEY_CONFIDENCE_FLOOR)
  if (keyTrusted && (mode === 'minor' || mode === 'major')) {
    parts.push(mode === 'minor'
      ? `key: ${root} minor — darker, moody, melancholy, introspective`
      : `key: ${root} major — brighter, warmer, open, resolved`)
  }

  const fast = b >= 122
  const slow = b < 100
  const minor = keyTrusted && mode === 'minor'
  parts.push('good for: ' + (
    fast && minor ? 'driving late-night, workout, intense focus'
    : fast ? 'workout, running, parties, daytime energy'
    : slow && minor ? 'late night, rainy day, winding down, solitude'
    : slow ? 'morning, relaxing, background, easy listening'
    : 'focus, walking, everyday listening'
  ))

  const cam = (t.camelotKey || '').trim()
  if (keyTrusted && cam) parts.push(`camelot ${cam}`)
  return parts.join(' · ')
}
