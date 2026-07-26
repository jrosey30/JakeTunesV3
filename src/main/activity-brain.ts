/**
 * Brain-powered activity-set fit — the taste model finally decides which
 * songs make an activity sync, instead of BPM + genre heuristics alone.
 *
 * Jake (2026-07-23): "get better at picking 1000 songs — you pick a lot of
 * shit and miss on a lot of shit." The old picker scored purely on BPM band,
 * a genre regex, and play count, so a track TAGGED "house" at 130 BPM beat a
 * track Jake actually loves that happened to lack a genre tag. The brain
 * (embeddings + starred/heavy-rotation taste) never voted. Now it does.
 *
 * Two signals, both read from the SAME 1536-d embedding space as the library
 * (so the cosines are honest):
 *   tasteFit — how close a track sits to Jake's taste CORNERS. His taste
 *              exemplars (starred + heavy rotation) are k-means'd into a
 *              handful of centroids and a track scores its BEST cosine to any
 *              one of them — a song only needs to hug SOME corner of his
 *              taste, never the mean (the daily-mixes lesson: never score
 *              against a single global centroid).
 *   ctxFit   — how close a track sits to THIS activity's steer: a query
 *              vector embedded from the activity + energy + the free-text
 *              note. Present only when the embed call succeeds.
 *
 * tasteFit needs ONLY precomputed embeddings, so it works fully offline;
 * ctxFit is folded in when a query vector is supplied. The result is a
 * per-track fit in 0..1 that selectWorkoutSyncSet blends into its score and
 * uses to floor out the bottom-taste "shit".
 *
 * ⚠️ Reuses kmeansCentroids + cosine from playlist-vibes / ai/embeddings —
 * same math as the playlist quality-floor Jake approved (playlist-vibes.ts).
 */
import { kmeansCentroids, cosine } from './playlist-vibes.ts'

export interface BrainFitInput {
  /** Ids of the eligible pool (named, non-skit) — scored in place. */
  eligibleIds: number[]
  /** trackId → 1536-d embedding (from getEmbeddingsMap). */
  embById: Map<number, Float32Array>
  /** Taste exemplar ids (starred + heavy rotation, from pickTasteExemplars). */
  exemplarIds: number[]
  /** Optional steer vector (activity + note embedded). Absent = taste only. */
  queryVec?: Float32Array | null
  /** Taste centroid count. */
  tasteK?: number
}

export interface BrainFitResult {
  /** trackId → blended fit 0..1 (taste, or taste+ctx when a query is given). */
  fitById: Map<number, number>
  /** trackId → taste-only fit 0..1 (drives the floor). */
  tasteById: Map<number, number>
  /** false = too little taste signal to trust — caller ignores the brain. */
  usable: boolean
}

const TASTE_W = 0.6
const CTX_W = 0.4
const MIN_EXEMPLARS = 20

export function computeActivityBrainFit(inp: BrainFitInput): BrainFitResult {
  const fitById = new Map<number, number>()
  const tasteById = new Map<number, number>()

  const exemplarVecs: Float32Array[] = []
  for (const id of inp.exemplarIds) {
    const v = inp.embById.get(id)
    if (v) exemplarVecs.push(v)
  }
  // Not enough starred/heavy-rotation taste to trust — bail so the caller
  // falls back to the heuristic picker rather than scoring against noise.
  if (exemplarVecs.length < MIN_EXEMPLARS) return { fitById, tasteById, usable: false }

  const k = Math.max(1, Math.min(inp.tasteK ?? 8, exemplarVecs.length))
  const centroids = kmeansCentroids(exemplarVecs, k)
  const q = inp.queryVec || null

  for (const id of inp.eligibleIds) {
    const v = inp.embById.get(id)
    // No embedding for this track (≈2% of the library, not yet described) —
    // leave it OUT of both maps so selection judges it on heuristics alone
    // and the taste floor can't cut it for a signal it never had.
    if (!v) continue
    let taste = -1
    for (const c of centroids) {
      const s = cosine(v, c)
      if (s > taste) taste = s
    }
    if (taste < 0) taste = 0
    tasteById.set(id, taste)
    let fit = taste
    if (q) {
      const ctx = cosine(v, q)
      fit = TASTE_W * taste + CTX_W * ctx
    }
    fitById.set(id, fit)
  }
  return { fitById, tasteById, usable: true }
}

/** Percentile (0..1) of a numeric list — the taste-floor threshold helper. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))
  return sorted[idx]
}
