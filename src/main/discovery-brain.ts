/**
 * Discovery Brain — score NEW-music radar candidates against the REAL taste
 * brain instead of genre heuristics.
 *
 * Why this exists (2026-07-14): the radar's "match %" was genre-spine affinity
 * — Vince Staples read 100% for weeks because "rap matches Jake's rap spine",
 * while the actual brain (embeddings + starred taste + lyrics meaning) never
 * touched Discovery. Now every candidate is embedded into the SAME 1536-d
 * space as the library (via buildEmbeddingText's voice) and scored by cosine
 * similarity against Jake's taste exemplars: the tracks he starred or plays
 * heavily. The % on a Discovery card is finally the brain's opinion.
 *
 * Scoring: mean of the top-K cosines vs the exemplar set (a candidate only
 * needs to sit near SOME corner of Jake's taste, not its average — the
 * daily-mixes lesson: never score against a mean centroid of everything).
 */
import { embedTexts, getEmbeddingsMap, cosine } from './ai/embeddings.ts'

export interface BrainScoreTrack {
  id?: number
  rating?: number
  playCount?: number
}

export interface BrainScorable {
  artist: string
  title: string
  genre?: string
  year?: string
}

/** Pick the exemplar track ids that define "Jake's taste": starred first,
 *  then heavy rotation. Capped so the cosine pass stays cheap. */
export function pickTasteExemplars(tracks: BrainScoreTrack[], cap = 400): number[] {
  const scored = tracks
    .filter((t) => typeof t.id === 'number' && ((t.rating ?? 0) >= 4 || (t.playCount ?? 0) >= 6))
    .map((t) => ({ id: t.id as number, w: (t.rating ?? 0) * 10 + Math.min(t.playCount ?? 0, 40) }))
    .sort((a, b) => b.w - a.w)
  return scored.slice(0, cap).map((s) => s.id)
}

/** Map a raw top-K cosine (empirically ~0.25 weak … ~0.60 soulmate in this
 *  space) onto a human-readable 40–99%. Calibration, not decoration: 100%
 *  is unreachable by design — the brain never claims certainty about music
 *  Jake hasn't heard. */
export function cosineToPct(c: number): number {
  const pct = 40 + ((c - 0.25) / 0.3) * 59
  return Math.max(40, Math.min(99, Math.round(pct)))
}

/**
 * Score candidates against the taste brain. Returns brainPct per candidate
 * (aligned with input order), or null if the brain isn't usable (no key, no
 * exemplar embeddings) — callers fall back to the heuristic score.
 */
export async function brainMatchCandidates(
  candidates: BrainScorable[],
  libraryTracks: BrainScoreTrack[],
  topK = 5,
): Promise<number[] | null> {
  if (candidates.length === 0) return []
  try {
    const embMap = await getEmbeddingsMap()
    if (embMap.size === 0) return null
    const exemplarIds = pickTasteExemplars(libraryTracks)
    const exemplars: Float32Array[] = []
    for (const id of exemplarIds) {
      const v = embMap.get(id)
      if (v) exemplars.push(v)
    }
    if (exemplars.length < 20) return null   // not enough taste signal yet

    // Same textual voice as the library vectors so the cosines are honest.
    const texts = candidates.map((c) => {
      const lines = [`${c.artist} — ${c.title}`]
      if (c.year) lines.push(`year: ${c.year}`)
      if (c.genre) lines.push(`genre: ${c.genre}`)
      return lines.join('\n')
    })
    const vecs = await embedTexts(texts)
    return vecs.map((v) => {
      if (!v) return 40
      const sims: number[] = []
      for (const e of exemplars) sims.push(cosine(v, e))
      sims.sort((a, b) => b - a)
      const k = Math.min(topK, sims.length)
      let sum = 0
      for (let i = 0; i < k; i++) sum += sims[i]
      return cosineToPct(sum / k)
    })
  } catch {
    return null   // embed failure → heuristic fallback, never a crash
  }
}
