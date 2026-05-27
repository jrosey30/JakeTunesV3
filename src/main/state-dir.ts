/**
 * 4.5.0-90 — Phase 2: NAS as single source of truth for STATE files.
 *
 * Seven files belong to the canonical app state and now live primarily
 * on the Synology mount at /Volumes/JakeShared/JakeTunesState/:
 *
 *   library.json              — track metadata (the master)
 *   metadata-overrides.json   — Get Info edits + analysis fields
 *   playlists.json            — user playlists
 *   mobile-stars.json         — iOS-set stars (Brief 054)
 *   mobile-plays.json         — iOS-recorded play counts
 *   play-events.jsonl         — per-play event log (4.5.0-82)
 *   embeddings.bin            — per-track embeddings (4.5.0-87)
 *
 * Music files are NOT moved (Phase 3 territory) — they stay on the
 * local SSD for playback latency.
 *
 * Resolution rule: at module-boot we probe whether the NAS state dir
 * is mounted. If yes, every reader/writer in the app uses that path.
 * If not, fall back to `app.getPath('userData')` (the legacy location)
 * — the app continues working from local copies and the user can
 * manually re-sync to NAS once it's back.
 *
 * Why module-boot (not per-call): the SMB mount usually stays up. A
 * one-shot detection at app start gives every code path a stable,
 * single value to work with — no risk of one reader picking NAS and
 * a subsequent writer picking local because the mount dropped between
 * those microseconds. The trade-off is that a mid-session mount drop
 * means failed writes until app restart, which the existing retry +
 * error-handling already tolerates.
 *
 * Imported by:
 *   - src/main/index.ts (all 5 state-file path constants/getters)
 *   - src/main/ai/embeddings.ts (the embeddings.bin path)
 */

import { app } from 'electron'
import { existsSync } from 'fs'

const NAS_STATE_DIR = '/Volumes/JakeShared/JakeTunesState'

function detectStateDir(): string {
  try {
    if (existsSync(NAS_STATE_DIR)) return NAS_STATE_DIR
  } catch {
    /* mount stale or denied — fall through to local */
  }
  return app.getPath('userData')
}

/** Resolved at module-init. Single value used by every state-file
 *  path in the app for this entire process lifetime. */
export const STATE_DIR = detectStateDir()

/** True when STATE_DIR resolved to the NAS path. Useful for UI badges
 *  ("Storage: NAS" vs "Storage: local cache"). */
export const STATE_IS_NAS = STATE_DIR === NAS_STATE_DIR

/** The canonical NAS path — exported so callers can still construct
 *  fallback paths or surface it in the UI. */
export const NAS_STATE_DIR_PATH = NAS_STATE_DIR

// ── Data-loss guard: refuse to overwrite NAS with stale local state ──
//
// The bug this prevents: this machine boots with NAS unmounted, falls back
// to local. While running, NAS comes back up (or was actually mounted all
// along but briefly flaky at boot). Other machines (workmini, homemini)
// have been writing to NAS in the meantime — those edits are NOT in our
// in-memory state. Without this guard, the next save here would overwrite
// NAS with our stale snapshot, silently destroying the other-machine work.
//
// Behaviour: if we booted in local-fallback mode AND NAS later becomes
// reachable, set a one-way save lock. Every save handler checks `isSaveLocked()`
// at the top and refuses the write, emitting `state-save-locked` so the
// renderer can surface a banner. The lock stays until app restart — we
// don't try to magically reconnect because in-memory state is stale
// relative to NAS and we can't merge safely.
let saveLockReason: string | null = null

/** Returns the lock reason string if saves are locked, else null. */
export function isSaveLocked(): string | null { return saveLockReason }

/** One-way lock. Idempotent; only the first call records the reason. */
function lockSaves(reason: string): void {
  if (saveLockReason) return
  saveLockReason = reason
  console.warn(`[state] SAVES LOCKED: ${reason}`)
}

/** Start the NAS-reconnect watcher. Only effective when we booted in
 *  local-fallback mode (STATE_IS_NAS=false). The watcher polls every 5s
 *  for the NAS mount; the first time it appears, saves get locked.
 *  `onLock` lets the caller emit an IPC event to the renderer. */
export function startNasReconnectWatcher(onLock: (reason: string) => void): void {
  if (STATE_IS_NAS) return  // booted on NAS; mount drops are handled at the save-error layer
  let timer: NodeJS.Timeout | null = setInterval(() => {
    if (saveLockReason) {
      if (timer) { clearInterval(timer); timer = null }
      return
    }
    try {
      if (existsSync(NAS_STATE_DIR)) {
        const reason = 'NAS reconnected while running in local-fallback mode. Saves refused to prevent overwriting NAS with stale state. Restart JakeTunes to resync from NAS.'
        lockSaves(reason)
        try { onLock(reason) } catch { /* renderer might not be ready; we still log */ }
      }
    } catch { /* still unreachable */ }
  }, 5000)
  timer.unref()
}
