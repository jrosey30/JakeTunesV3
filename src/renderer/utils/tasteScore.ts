/**
 * 4.5 — THE taste model, deployed. Predicts how likely Jake is to STAR a track,
 * from his library's star-AFFINITIES: how he rated OTHER tracks by the same
 * artist / from the same album / same genre / same era.
 *
 * Why this and not the sound embedding: the 2026-06-26 study (scripts/
 * taste-experiments.py, project_brain_eval memory) settled it — taste is
 * IDENTITY, not sound. Leak-safe 5-fold CV: sound-only ~0.60–0.66; identity
 * affinity 0.78, with ALBUM the single strongest signal (0.766 alone — Jake
 * stars whole records), then artist, then genre/era. Adding the sound embedding
 * on top did nothing. So this is a pure-identity scorer: no embeddings, no
 * network, computed straight off library.json's ratings.
 *
 * STRENGTH/LIMIT: lethal for ranking music near what's already loved (mixes,
 * "songs you'd star", DJ sets). Near-blind for a BRAND-NEW artist (cold start →
 * falls back to the global prior). Do NOT use it to rank fresh-discovery
 * candidates — that's the radar's genre/era job (src/main/taste-model.ts).
 *
 * Usage: build the profile ONCE from the library, then score many tracks.
 *   const profile = buildTasteProfile(lib.tracks)
 *   const p = tasteScore(track, profile)   // 0..1, higher = more "Jake'd star it"
 */
import type { Track } from '../types'

export interface TasteProfile {
  artist: Map<string, number>
  album: Map<string, number>
  genre: Map<string, number>
  decade: Map<number, number>
  prior: number
  playMax: number   // max log1p(playCount) across the library — normalizes the playCount signal
  nowMs: number     // snapshot time, for recency
}

const isStar = (t: Track): boolean => (Number(t.rating) || 0) > 0
const artistKey = (t: Track): string => (t.albumArtist || t.artist || '?').trim().toLowerCase()
const albumKey = (t: Track): string =>
  ((t.albumArtist || t.artist || '?') + ' ::: ' + (t.album || '?')).trim().toLowerCase()
const genreKey = (t: Track): string => (t.genre || '?').trim().toLowerCase()
const decadeKey = (t: Track): number => {
  const y = Number(t.year)
  return Number.isFinite(y) && y > 0 ? Math.floor(y / 10) * 10 : 0
}

/** Smoothed star-rate per key: (#starred + k·prior) / (#total + k). The k=4
 *  pseudo-count pulls thin groups (a one-off artist) toward the global rate so
 *  a single lucky star doesn't read as certainty — the same additive smoothing
 *  the validated model used. */
function buildRate<K>(library: Track[], keyOf: (t: Track) => K, prior: number, k = 4): Map<K, number> {
  const starred = new Map<K, number>()
  const total = new Map<K, number>()
  for (const t of library) {
    const key = keyOf(t)
    if (isStar(t)) starred.set(key, (starred.get(key) || 0) + 1)
    total.set(key, (total.get(key) || 0) + 1)
  }
  const out = new Map<K, number>()
  for (const [key, n] of total) out.set(key, ((starred.get(key) || 0) + k * prior) / (n + k))
  return out
}

export function buildTasteProfile(library: Track[]): TasteProfile {
  const prior = library.length ? library.filter(isStar).length / library.length : 0
  let playMax = 0
  for (const t of library) {
    const pl = Math.log1p(Number(t.playCount) || 0)
    if (pl > playMax) playMax = pl
  }
  return {
    artist: buildRate(library, artistKey, prior),
    album: buildRate(library, albumKey, prior),
    genre: buildRate(library, genreKey, prior),
    decade: buildRate(library, decadeKey, prior),
    prior,
    playMax,
    nowMs: Date.now(),
  }
}

// 4.5 taste v4 (2026-08-23) — feature lab (scratchpad taste-feature-lab.py,
// same leak-safe 5x5 CV protocol as scripts/taste-eval.py): playINTENSITY
// (log1p(plays)/months owned) is the real behavior signal — it absorbs
// lifetime playCount (whose weight flips mildly negative as the age-noisy
// proxy it was) and lifts held-out AUC 0.8039 -> 0.8096 (+/-0.016, 25 folds).
// Skips re-tested at 6x the June data: still nothing. Exp-recency: noise.
// Weights re-derived on the full-rate basis (deployment parity).
// Re-derive via the lab; the laptop harness (taste-eval.py) now measures the
// same 7-feature model. ⚠️ TWIN: keep identical to the other tasteScore copy.
// v5 (2026-10-13, E9 + E5, Jake: "do both E9 and E6"): intensity divides by
// the SQUARE ROOT of months owned, and every weight is refit. The 10-12
// diagnosis (brain-eval experiments/evidence/E9) found plays-per-month
// drifted with the clock: identical tracks lost 0.0093 AUC just from "today"
// moving 6 weeks, and a trial listen looked like love (0.586 vs the aged-in
// summer finds). Refit on the matured-90d library (out-of-fold affinities,
// LogReg): weekly eval 0.785 -> 0.818, clock drift +0.0008, trial-vs-love
// 0.646, 5x5 CV 0.8197; fit on 8/28 data alone it scores 0.791 on the 1,214
// tracks it never saw (deployed v4: 0.772). ⚠️ TWIN: keep this line
// byte-identical to the other tasteScore copy (the nightly W guard checks).
const W = { bias: -4.577, album: 4.238, artist: 2.343, genre: 1.442, decade: 2.748, plays: -0.247, recency: 0.422, intensity: 3.311 }

/** Predicted star-probability (0..1): a logistic model over identity affinity
 *  (album > artist > genre > era) + listening behavior, learned weights. Unknown
 *  keys fall back to the prior (the cold-start floor). */
/** Months since dateAdded (fallback: 24 — an "average-aged" track). The
 *  intensity feature needs ownership age; a missing date must not zero it. */
function monthsOwned(t: Track, nowMs: number): number {
  const da = String(t.dateAdded || '')
  if (!da) return 24
  const ms = Date.parse(da)
  if (!Number.isFinite(ms)) return 24
  return Math.max(1, (nowMs - ms) / (30 * 86400000))
}

export function tasteScore(t: Track, p: TasteProfile): number {
  const al = p.album.get(albumKey(t)) ?? p.prior
  const ar = p.artist.get(artistKey(t)) ?? p.prior
  const ge = p.genre.get(genreKey(t)) ?? p.prior
  const de = p.decade.get(decadeKey(t)) ?? p.prior
  const playNorm = p.playMax > 0 ? Math.log1p(Number(t.playCount) || 0) / p.playMax : 0
  const lp = Number(t.lastPlayedAt) || 0
  const daysAgo = lp > 0 ? (p.nowMs - lp) / 86400000 : 3650
  const recencyNorm = 1 - Math.min(daysAgo, 3650) / 3650
  const intensity = Math.log1p(Number(t.playCount) || 0) / Math.sqrt(monthsOwned(t, p.nowMs))   // monthsOwned >= 1
  const z = W.bias + W.album * al + W.artist * ar + W.genre * ge + W.decade * de + W.plays * playNorm + W.recency * recencyNorm + W.intensity * intensity
  return 1 / (1 + Math.exp(-z))
}
