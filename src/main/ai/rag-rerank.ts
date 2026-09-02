/**
 * rag-rerank — second-stage reordering after cosine retrieval.
 *
 * 6.0 Phase 3c. The production-path eval (brain-eval, 2026-09-01) measured
 * the mood route at 0.24–0.48 recall on vibe queries while artist/decade
 * routes sat at 0.72–1.00: cosine alone under-ranks on-genre tracks that
 * sit just below the top-k. The reranker over-fetches, then adds a small
 * lexical bonus when the query literally names the track's genre family
 * ("heavy…" ↔ "Heavy Metal", "jazzy" ↔ "Jazz"), and re-slices.
 *
 * Pure functions — no I/O, unit-tested. Weight was chosen by sweeping the
 * production-path eval (see brain-eval/score_log.jsonl 2026-09-01 rows);
 * JT_RERANK_GENRE_W overrides it for lab runs only.
 *
 * ⚠️ TWIN: backend/src/util/ragRerank.ts in ~/JakeTunesMobile — same math,
 * two runtimes, per src/common/mix-brain-twin.ts discipline.
 */

import { foldAccents } from '../../common/fold-text.ts'

export const RERANK_OVERFETCH = 4          // candidates considered = k × this (cap below)
export const RERANK_POOL_CAP = 400
export const RERANK_GENRE_W = Number(process.env.JT_RERANK_GENRE_W ?? '0.08')
/** Subgenre-lexicon anchor bonus (2026-09-02): a track by an in-era anchor
 *  artist for the named style ("yacht rock" → Steely Dan '77). Larger than
 *  the genre bonus on purpose — the whole point is to lift tracks the vector
 *  spaces rank 80th into the top 25 when the user literally named the style. */
export const RERANK_ANCHOR_W = Number(process.env.JT_RERANK_ANCHOR_W ?? '0.12')

// Words that appear in vibe queries without naming a genre.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'songs', 'song', 'music', 'tracks', 'track',
  'vibes', 'vibe', 'late', 'night', 'that', 'this', 'some', 'from', 'into',
])

const fold = (s: string): string => foldAccents(String(s || '').toLowerCase())

/** Query tokens worth matching against genre text: folded, ≥3 chars, non-stopword. */
export function rerankQueryTokens(query: string): string[] {
  return fold(query)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t))
}

/**
 * 1 when any query token names the track's genre family, else 0.
 * Bidirectional containment with a ≥4-char guard on the shorter side so
 * "jazzy" ↔ "jazz" and "heavy" ↔ "heavy metal" both hit while short
 * accidental substrings ("pop" in "popular") stay conservative: 3-char
 * tokens must match a whole genre word exactly.
 */
export function genreLexicalFit(tokens: string[], genreText: string): number {
  const g = fold(genreText)
  if (!g) return 0
  const gWords = g.split(/[^a-z0-9]+/).filter(Boolean)
  for (const t of tokens) {
    for (const w of gWords) {
      if (t === w) return 1
      if (t.length >= 4 && w.length >= 4 && (t.includes(w) || w.includes(t))) return 1
    }
  }
  return 0
}

/**
 * Reorder an over-fetched hit list by cosine + genre bonus; slice to k.
 * Returns hits with the BLENDED score so downstream ordering stays
 * consistent with what ranked them.
 */
export function rerankHits(
  query: string,
  hits: Array<{ trackId: number; score: number }>,
  genreById: Map<number, string>,
  k: number,
  weight: number = RERANK_GENRE_W,
  opts?: { anchorIds?: Set<number>; anchorWeight?: number },
): Array<{ trackId: number; score: number }> {
  const anchors = opts?.anchorIds
  const aw = anchors && anchors.size > 0 ? (opts?.anchorWeight ?? RERANK_ANCHOR_W) : 0
  if ((weight <= 0 && aw <= 0) || hits.length <= 1) return hits.slice(0, k)
  const tokens = rerankQueryTokens(query)
  if (tokens.length === 0 && aw <= 0) return hits.slice(0, k)
  return hits
    .map((h) => ({
      trackId: h.trackId,
      score: h.score
        + (weight > 0 && tokens.length > 0 ? weight * genreLexicalFit(tokens, genreById.get(h.trackId) || '') : 0)
        + (aw > 0 && anchors!.has(h.trackId) ? aw : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}
