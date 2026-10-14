/**
 * embedding-text.ts — THE single source of truth for the brain's texts
 * (Brief 181).
 *
 * Until this module, `baseText` / `moodText` / `tempoEnergy` existed as
 * hand-synced twins in scripts/brain-trainer.mjs (the nightly trainer) and
 * src/main/ai/ (the app: embeddings.ts buildEmbeddingText, mood-index.ts
 * buildMoodText, tempo-energy.ts tempoEnergyText), held together by
 * "⚠️ TWIN" comments and a source-shape test. The twins had already
 * drifted: on untrimmed string fields (a whitespace-padded year, a
 * whitespace-only album) the trainer interpolated raw values while the app
 * trimmed first, so the two writers produced different texts — different
 * vectors — for the same track.
 *
 * Now both sides import THESE functions:
 *   trainer:  scripts/brain-trainer.mjs  (baseText / moodText / tempoEnergy)
 *   app:      src/main/ai/embeddings.ts  (buildEmbeddingText → baseText)
 *             src/main/ai/mood-index.ts  (buildMoodText → moodText)
 *             src/main/ai/tempo-energy.ts (re-exports tempoEnergyText)
 *
 * Canonical semantics are the app's trim-first ones. NO-OP PROOF
 * (docs/briefs/181-single-source-text-twins.md): old-vs-new over the
 * fixture corpus — byte-identical to BOTH old implementations on every
 * input with trimmed-or-absent fields, and byte-identical to the old app
 * implementation on 100% of fixtures including the untrimmed class (where
 * the old twins disagreed with each other, so no single "before" existed).
 * The byte-equality guard lives in scripts/__tests__/embedding-text.test.mjs
 * and src/main/__tests__/brain-text.test.ts.
 *
 * NOT covered by this module (deliberate): the mobile backend's
 * identityText (JakeTunesMobile backend/src/util/embeddingsSupplement.ts)
 * is a THIRD twin in another repo, verified against the trainer's baseText
 * by Brief 159's test — that guard stays as-is; this brief removes the
 * desktop/trainer twin only.
 *
 * Pure — no Electron, no disk, no network — so every consumer and test can
 * import it. The genre line of the mood text is itself shared code
 * (mood-genre-line.ts, single-sourced 2026-10-13).
 */
import { genreWithParents } from './mood-genre-line.ts'

export interface TempoEnergyInput {
  bpm?: number
  keyRoot?: string
  keyMode?: string
  camelotKey?: string
  /** 0..1 from Essentia key vote. Weak keys stay out of the brain text. */
  keyConfidence?: number | string | null
}

export interface EmbeddingTextInput extends TempoEnergyInput {
  artist?: string
  title?: string
  album?: string
  genre?: string
  year?: number | string
}

/** Below this, key/mode adjectives and Camelot stay OUT of embed text. */
export const KEY_CONFIDENCE_FLOOR = 0.45

/**
 * Grounded tempo/energy/use-case from REAL library bpm + genre. The literary
 * "sound and mood" descriptor alone scored ~random (0.47 AUC) on tempo queries
 * like "fast workout music" / "mellow late-night" — the brain had no idea what
 * was fast or slow despite bpm sitting right in the library. Appending this
 * lifts mood retrieval +0.32/+0.36 AUC (validated /tmp/validate_mood.py 2026-06-26).
 * Rewritten 2026-07-26: the old line described all 8,730 tracks with 10 distinct
 * strings (33% identical, 60% with no energy statement, 259 self-contradicting
 * because a genre regex overrode the measured tempo). Now: bpm thresholds
 * calibrated to this library's real 72-152 spread, plus key/mode — 100% covered
 * by audio analysis and never previously used. 504 distinct descriptions.
 * Key-confidence gate added 2026-08-20.
 * (Bump the trainer's TEMPO_ENCODING_VERSION when this output changes.)
 */
export function tempoEnergy(t: TempoEnergyInput): string {
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

/** The app-side name for tempoEnergy (src/main/ai/tempo-energy.ts re-exports it). */
export { tempoEnergy as tempoEnergyText }

/**
 * The MAIN brain's text — PLAIN since 2026-10-10: artist — title, album
 * (year), genre tag. Measured that day on the whole library (scratch
 * re-embeds, real trainer): the sound-and-mood descriptors, lyrics meaning,
 * tempo, AI subgenre path, members and play-count lines blurred genre and
 * era — 10 nearest other-artist neighbours in the same genre family
 * 72.3% → 80.9% plain; rock queries pulling electronic neighbours
 * 7.0% → 3.4%; retrieval suite 0.736 → 0.788; playlist suggestions on-genre
 * Rocksurgence 90→96%, Dinner Party 67→80%, Pool Dos 75→89%. Vibe searches
 * lose nothing: the router sends them to the MOOD index (rag-retrieval
 * pickRetrievalIndex), which keeps the descriptors — the production-path
 * eval scored identically. Removing only the AI subgenre line changed
 * nothing (72.3 → 70.9%), so it was not the cause.
 */
export function baseText(t: EmbeddingTextInput): string {
  const lines: string[] = []
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

/**
 * The mood index's text — the brain's second ear (vibe-only, identity
 * stripped). Validated on the brain-eval branch (mood_index_proto.py):
 * vibe recall 0.756→0.900. Empty string when the track has nothing
 * vibe-worthy yet — callers skip embedding those.
 */
export function moodText(t: EmbeddingTextInput, descriptor?: string): string {
  const lines: string[] = []
  const d = (descriptor || '').trim()
  if (d) lines.push(`sound and mood: ${d}`)
  const te = tempoEnergy(t)
  if (te) lines.push(te)
  const g = genreWithParents(t.genre || '')
  if (g) lines.push(`genre: ${g}`)
  return lines.join('\n')
}
