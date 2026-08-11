/**
 * Tape physics — THE single implementation (main's mixtape builder AND
 * the renderer's mixing-deck live counter both import this; do not fork
 * it — that's the twin trap this file exists to prevent).
 *
 * A cassette side is EXACTLY its length. Songs record in order until the
 * tape runs out. The song that crosses the end is kept and CUT at the
 * boundary — if at least MIN_CUT_MS of tape remains for it. Everything
 * after the boundary song never records.
 */

export const MIN_CUT_MS = 20_000
/** Assumed length when a track has no known duration (≈3:30). */
export const UNKNOWN_DURATION_MS = 210_000

// ── The 2026-08-08 model ────────────────────────────────────────────────
// Jake: "all mixtapes are no longer doing side a side b. 25 songs max …
// manually made can be any playlist … as long as 25 or less songs. it can
// be a whole album if i want. my choice."
//
// A tape is now ONE sequence with a song-count limit. There is no A/B
// boundary, no minutes budget, and no boundary-song cut — fitSide() above
// still exists only to read tapes recorded under the old rules.

/** The only limit a tape has now. */
export const MAX_TAPE_SONGS = 25

/** Minimum shape this helper needs — the full Mixtape in main and renderer
 *  both satisfy it, which is why this lives here and not next to either. */
export interface TapeLike {
  tracks?: number[]
  sideA?: number[]
  sideB?: number[]
}

/**
 * What's on the tape, in play order — THE one answer.
 *
 * New tapes carry `tracks`. Tapes Jake recorded under the two-sided rules
 * are grandfathered ("old mixtapes i made already should be grandfathered
 * in") by reading straight through A into B, which is the order they always
 * played in anyway. Never read tape.sideA/sideB directly for playback; go
 * through here so both eras behave the same everywhere.
 */
export function tapeTracks(tape: TapeLike): number[] {
  if (Array.isArray(tape.tracks)) return tape.tracks
  return [...(tape.sideA || []), ...(tape.sideB || [])]
}

/** Trim to the song cap, preserving order. */
export function fitTape(ids: number[], max: number = MAX_TAPE_SONGS): number[] {
  return ids.slice(0, max)
}

/**
 * One song per artist, keeping the first appearance — the rule for
 * AI-generated mixes only (Jake: "AI mixes follow the one song per artist
 * rule"). Hand-made tapes are explicitly exempt: a whole album is allowed
 * when that's what he wants.
 */
export function oneSongPerArtist(
  ids: number[],
  artistOf: (id: number) => string | undefined,
): number[] {
  const seen = new Set<string>()
  const out: number[] = []
  for (const id of ids) {
    const key = (artistOf(id) || '').trim().toLowerCase()
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(id)
  }
  return out
}

export interface SideFit {
  /** Songs that actually made it onto the tape, in order. */
  ids: number[]
  /** ms into the LAST song where the tape runs out (absent = side ends clean). */
  cutMs?: number
  /** Total tape consumed (== budget when cut). */
  usedMs: number
  /** Songs that were placed after the tape ran out — they never recorded. */
  overflowIds: number[]
}

export function fitSide(
  ids: number[],
  durationMsById: (id: number) => number | undefined,
  sideBudgetMs: number,
): SideFit {
  let total = 0
  const out: number[] = []
  const overflow: number[] = []
  let cutMs: number | undefined
  for (const id of ids) {
    if (cutMs !== undefined) { overflow.push(id); continue }
    const dur = durationMsById(id) || UNKNOWN_DURATION_MS
    if (total + dur <= sideBudgetMs) {
      total += dur
      out.push(id)
      continue
    }
    const remaining = sideBudgetMs - total
    if (remaining >= MIN_CUT_MS) {
      out.push(id)
      cutMs = remaining
      total = sideBudgetMs
    } else {
      overflow.push(id)
      cutMs = 0 // tape effectively full; nothing more records
    }
  }
  // cutMs === 0 means the boundary was too tight to start another song —
  // side ends clean, but the tape is full.
  return {
    ids: out,
    cutMs: cutMs && cutMs > 0 ? cutMs : undefined,
    usedMs: total,
    overflowIds: overflow,
  }
}

/**
 * Wrap a raw duration lookup with per-track start offsets (REC pressed
 * mid-song → only the tail is on tape). Every fitSide call site that
 * handles a tape with startOffsets must use this — one adapter, no forks.
 */
export function effectiveDurationFn(
  durOf: (id: number) => number | undefined,
  startOffsets?: Record<string, number>,
): (id: number) => number {
  return (id: number) => {
    const full = durOf(id) || UNKNOWN_DURATION_MS
    const off = startOffsets?.[String(id)] || 0
    return Math.max(1000, full - off)
  }
}
