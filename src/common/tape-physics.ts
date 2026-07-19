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
