/**
 * Which audio files may `save-library` unlink.
 *
 * This is a DESTRUCTIVE decision, so per CLAUDE.md it gates on identity, not on
 * text. It previously did the opposite:
 *
 *     for (const p of prevPaths) if (!newPaths.has(p)) deletedPaths.push(p)
 *
 * — a pure path diff. Any track whose PATH changed while the track itself still
 * existed (re-import into a different F-dir, a sync path rewrite, colon-path
 * normalization) looked exactly like a deletion, and the file was unlinked out
 * from under a track still in the library. That is the same failure mode as the
 * verify-and-repair cascade in docs/postmortems: an irreversible operation
 * decided by comparing strings.
 *
 * Two independent gates, and a path must clear BOTH to be deleted:
 *
 *   1. The TRACK ID is gone from the new library. If the id survives, the track
 *      survives — whatever happened to its path is a move, not a delete.
 *   2. No OTHER track now claims that path. Two ids pointing at one file during
 *      a merge/dedupe must never cost the surviving id its audio.
 *
 * ⚠️ Deliberately NOT deduplicating by fingerprint here: this answers only
 * "did the library stop referencing this file", and the caller still applies
 * its own batch cap (mayUnlinkDeletions) before anything is unlinked.
 */

export interface DeletionCandidate {
  id?: number | string
  path?: string
}

/**
 * Paths referenced by `prev` that `next` no longer references at all.
 * Order follows `prev` so logs read in library order.
 */
export function computeDeletedPaths(
  prev: readonly DeletionCandidate[],
  next: readonly DeletionCandidate[],
): string[] {
  const survivingIds = new Set<string>()
  const claimedPaths = new Set<string>()
  for (const t of next) {
    if (t.id !== undefined && t.id !== null) survivingIds.add(String(t.id))
    if (t.path) claimedPaths.add(t.path)
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const t of prev) {
    if (!t.path) continue
    // Gate 1: the track itself is still here — a path change is a MOVE.
    if (t.id !== undefined && t.id !== null && survivingIds.has(String(t.id))) continue
    // Gate 2: something else points at this file now — never pull it.
    if (claimedPaths.has(t.path)) continue
    if (seen.has(t.path)) continue
    seen.add(t.path)
    out.push(t.path)
  }
  return out
}
