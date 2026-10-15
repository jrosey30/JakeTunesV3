// Brief 181 — the OLD hand-synced text twins, mechanically extracted from
// JakeTunesV3 main 12bb43b (trainer: scripts/brain-trainer.mjs; app:
// src/main/ai/embeddings.ts + tempo-energy.ts + mood-index.ts) BEFORE the
// single-sourcing, frozen as the byte-equality reference for
// embedding-text.test.mjs. Do not edit — if the canonical texts ever
// legitimately change, that change is a re-embed event (TEMPO_ENCODING_VERSION
// and friends), not a quiet edit of the reference.
import { genreWithParents } from '../../src/common/mood-genre-line.ts'
const KEY_CONFIDENCE_FLOOR = 0.45
function tempoEnergy(t) {
  const b = Number(t.bpm) || 0
  if (b <= 0) return ''   // no bpm → say nothing (never fabricate)
  const tempo =
    b < 88 ? 'slow, spacious, downtempo'
    : b < 100 ? 'relaxed, loping mid-tempo'
    : b < 112 ? 'steady mid-tempo groove'
    : b < 122 ? 'brisk, forward-moving'
    : b < 134 ? 'fast, driving, propulsive'
    : 'very fast, urgent, relentless'

  const parts = [`tempo: ${Math.round(b)} BPM, ${tempo}`]

  const root = String(t.keyRoot || '').trim()
  const mode = String(t.keyMode || '').trim().toLowerCase()
  // ⚠️ TWIN: src/main/ai/embeddings.ts KEY_CONFIDENCE_FLOOR + tempoEnergyText
  const KEY_CONFIDENCE_FLOOR = 0.45
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

  const cam = String(t.camelotKey || '').trim()
  if (keyTrusted && cam) parts.push(`camelot ${cam}`)
  return parts.join(' · ')
}
function moodText(t, d) {
  const lines = []
  const dd = String(d || '').trim()
  if (dd) lines.push(`sound and mood: ${dd}`)
  const te = tempoEnergy(t); if (te) lines.push(te)
  const g = genreWithParents(String(t.genre || '')); if (g) lines.push(`genre: ${g}`)   // shared with the app (mood-genre-line.ts)
  return lines.join('\n')
}
function baseText(t) {
  const lines = [`${(t.artist || '?').trim()} — ${(t.title || '?').trim()}`]
  if (t.album) lines.push(`album: ${String(t.album).trim()}${t.year ? ` (${t.year})` : ''}`)
  else if (t.year) lines.push(`year: ${t.year}`)
  if (t.genre) lines.push(`genre: ${String(t.genre).trim()}`)
  return lines.join('\n')
}
function tempoEnergyText(t) {
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
function buildEmbeddingText(t) {
  const lines = []
  const artist = (t.artist || '').trim()
  const title = (t.title || '').trim()
  const album = (t.album || '').trim()
  const genre = (t.genre || '').trim()
  const year = t.year ? String(t.year).trim() : ''
  lines.push(`${artist || '?'} — ${title || '?'}`)
  if (album) lines.push(`album: ${album}${year ? ` (${year})` : ''}`)
  if (!album && year) lines.push(`year: ${year}`)
  if (genre) lines.push(`genre: ${genre}`)
  return lines.join('\n')
}
function buildMoodText(t, descriptor) {
  const lines = []
  const d = (descriptor || '').trim()
  if (d) lines.push(`sound and mood: ${d}`)
  const te = tempoEnergyText(t)
  if (te) lines.push(te)
  // Leaf + its family/umbrella, from the ONE shared function the trainer
  // also uses (2026-10-13) — "Synthpop (New Wave & Synth, Pop)".
  const genre = genreWithParents(t.genre || '')
  if (genre) lines.push(`genre: ${genre}`)
  return lines.join('\n')
}
export { tempoEnergy as oldTrainerTempo, moodText as oldTrainerMood, baseText as oldTrainerBase,
         tempoEnergyText as oldAppTempo, buildEmbeddingText as oldAppBase, buildMoodText as oldAppMood }
