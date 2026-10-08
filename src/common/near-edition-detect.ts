/**
 * Is a refused edition a NEAR edition — same record, same track count,
 * refused only on the tracklist (a runtime or title mismatch on some
 * track)? Those are the ones Compare editions can lay side by side. Pure
 * string logic so the panel model can use it; the judge itself lives in main.
 */
import type { Alternative } from './acquisition-identity.ts'

export const TRACKLIST_REASON = /\bruns \d+:\d\d; the edition you picked runs \d+:\d\d|^track [\d-]+ is “|^track [\d-]+ is the /

export function alternativeTrackCount(alt: Alternative): number | null {
  if (alt.trackCount != null) return alt.trackCount
  if (alt.tracks?.length) return alt.tracks.length
  const m = /\((\d+) tracks?\)/.exec(alt.desc)
  return m ? Number(m[1]) : null
}

export function isNearEdition(alt: Alternative, requestedTrackCount: number | null | undefined): boolean {
  if (!TRACKLIST_REASON.test(alt.reason)) return false
  const n = alternativeTrackCount(alt)
  if (requestedTrackCount != null && n != null && n !== requestedTrackCount) return false
  return true
}

/** The first near edition among a verdict's alternatives, if any. */
export function nearEditionOf(alternatives: ReadonlyArray<Alternative> | undefined, requestedTrackCount: number | null | undefined): Alternative | null {
  return (alternatives ?? []).find((a) => isNearEdition(a, requestedTrackCount)) ?? null
}
