/**
 * Brief 167 — staged-save recovery: recency, not track count.
 *
 * The old rule promoted a staged save (`library.json.partial.json` /
 * `library.json.new`) only when it had STRICTLY MORE tracks than the
 * live file. A staged save containing only metadata edits, playlist
 * edits, star changes, deletions, or a legitimate shrink was deleted
 * as stale on next launch — the user's last session of edits vanished
 * with no trace.
 *
 * The staging code writes no commit marker (verified at 12bb43b: the
 * stage is a bare JSON payload at a fixed sidecar path), so recency is
 * judged by mtime. The decision itself is a pure function over file
 * snapshots so it can be fixture-tested without touching disk:
 *
 *   candidate missing            → leave   (nothing to do)
 *   candidate unparseable        → discard (torn bytes can never be
 *                                  promoted; keeping them only hides
 *                                  the loss — the discard is logged)
 *   candidate has zero tracks    → discard (an empty stage over a real
 *                                  library is the shrink-breaker case;
 *                                  over no library it must not block
 *                                  the first-launch iPod seed)
 *   live missing or unparseable  → promote (the candidate is the only
 *                                  good copy on disk)
 *   candidate newer than live    → promote (recency wins — metadata-
 *                                  only edits and legitimate shrinks
 *                                  included)
 *   otherwise                    → discard (stale stage from a save
 *                                  whose rename already landed)
 */
import { readFile, stat } from 'node:fs/promises'

export interface LibraryFileSnapshot {
  exists: boolean
  parses: boolean
  trackCount: number
  mtimeMs: number
}

export type StagedRecoveryAction = 'promote' | 'discard' | 'leave'

export interface StagedRecoveryDecision {
  action: StagedRecoveryAction
  reason: string
}

export function decideStagedRecovery(
  candidate: LibraryFileSnapshot,
  live: LibraryFileSnapshot,
): StagedRecoveryDecision {
  if (!candidate.exists) return { action: 'leave', reason: 'no staged candidate' }
  if (!candidate.parses) return { action: 'discard', reason: 'candidate does not parse' }
  if (candidate.trackCount === 0) return { action: 'discard', reason: 'candidate has no tracks' }
  if (!live.exists) return { action: 'promote', reason: 'live library.json is missing' }
  if (!live.parses) return { action: 'promote', reason: 'live library.json does not parse' }
  if (candidate.mtimeMs > live.mtimeMs) {
    return { action: 'promote', reason: `candidate is newer than live (${candidate.mtimeMs} > ${live.mtimeMs})` }
  }
  return { action: 'discard', reason: 'candidate is not newer than live' }
}

/** Read a library-shaped file into a snapshot. Never throws. */
export async function snapshotLibraryFile(path: string): Promise<LibraryFileSnapshot> {
  let mtimeMs = 0
  try {
    mtimeMs = Math.round((await stat(path)).mtimeMs)
  } catch {
    return { exists: false, parses: false, trackCount: 0, mtimeMs: 0 }
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as { tracks?: unknown[] }
    return {
      exists: true,
      parses: true,
      trackCount: Array.isArray(parsed?.tracks) ? parsed.tracks.length : 0,
      mtimeMs,
    }
  } catch {
    return { exists: true, parses: false, trackCount: 0, mtimeMs }
  }
}
