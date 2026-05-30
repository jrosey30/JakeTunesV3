/**
 * 4.5.0-114 — LOCAL is the source of truth.
 *
 * History: 4.5.0-90 made the NAS (Synology /Volumes/JakeShared/JakeTunesState)
 * the single source of truth for state files. That put a flaky SMB link on the
 * app's hot read/write path, and on 2026-05-29/30 it caused two P0 incidents:
 * a torn write left library.json missing ("library deleted"), and flaky reads
 * at boot loaded an empty library ("0 songs").
 *
 * Fix: the canonical state lives on the LOCAL SSD (app.getPath('userData')).
 * Reads and writes go there — a local read cannot tear. The NAS is demoted to
 * an async, best-effort BACKUP MIRROR (see mirrorLibraryToNas in index.ts):
 * the app copies to it AFTER a successful local save, off the hot path, and
 * NEVER reads from it or blocks on it. A flaky NAS therefore can no longer
 * cause empty-display or data loss — the app never depends on it to run.
 *
 * Trade-off vs the old NAS-primary model: cross-machine sync (homemini/
 * workmini sharing one NAS state dir) is looser — each machine is now
 * local-authoritative and the NAS holds this machine's latest mirror.
 * Accepted deliberately (the laptop is primary; the NAS was the loss source).
 *
 * Imported by:
 *   - src/main/index.ts (all state-file path constants/getters)
 *   - src/main/ai/embeddings.ts (the embeddings.bin path)
 */

import { app } from 'electron'

const NAS_STATE_DIR = '/Volumes/JakeShared/JakeTunesState'

/** Local SSD — the single source of truth for every state file, for the
 *  entire process lifetime. Resolved once at module init. */
export const STATE_DIR = app.getPath('userData')

/** Always false now: state is local-primary. Retained so existing callers /
 *  UI badges that reference it keep compiling. */
export const STATE_IS_NAS = false

/** The NAS path — used ONLY as the async backup-mirror target, never read. */
export const NAS_STATE_DIR_PATH = NAS_STATE_DIR

/**
 * Saves are never locked under local-primary: the local copy is authoritative,
 * so there is no "stale local vs newer NAS" hazard to guard against (that guard
 * is what would freeze saves when the NAS remounted). Kept as a no-op export so
 * the save handlers that call it keep working.
 */
export function isSaveLocked(): string | null { return null }

/**
 * No-op under local-primary. The old watcher locked saves when the NAS
 * reappeared (to avoid clobbering other-machine edits on the shared NAS). With
 * local as the source of truth that hazard is gone, and locking saves on a NAS
 * remount is exactly the misbehavior we're removing. Signature preserved for
 * the bootstrap caller.
 */
export function startNasReconnectWatcher(_onLock: (reason: string) => void): void {
  /* intentionally empty — local-primary */
}
