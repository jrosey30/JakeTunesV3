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
import { stat } from 'fs/promises'

const NAS_STATE_DIR = '/Volumes/JakeShared/JakeTunesState'

/** Local SSD — the single source of truth for every state file, for the
 *  entire process lifetime. Resolved once at module init. */
export const STATE_DIR = app.getPath('userData')

/** Always false now: state is local-primary. Retained so existing callers /
 *  UI badges that reference it keep compiling. */
export const STATE_IS_NAS = false

/** The NAS path — used ONLY as the async backup-mirror target, never read. */
export const NAS_STATE_DIR_PATH = NAS_STATE_DIR

// ── NAS circuit breaker (2026-07-08, "figure it the fuck out") ────────────
// The old isNasMounted() was a SYNCHRONOUS existsSync on the SMB mount — a
// stale Synology share turns any sync fs call into a seconds-long
// MAIN-PROCESS block, and even async SMB calls park libuv threadpool
// threads until the SMB timeout, starving every other fs op in the app.
// Jake's old laptop ran a LOCAL-ONLY library and "rarely froze"; this
// machine's NAS-touching timers are the difference. The breaker makes the
// app immune to a flaky share: one 2s-timeout probe decides, a slow/absent
// NAS opens the breaker and ALL NAS IO is skipped for 5 minutes.
let nasBreakerUntil = 0
let lastVerdict = false
let lastProbeAt = 0
let probeInflight: Promise<boolean> | null = null
// Transition-once logging (2026-08-22 flight-log stomp): a sustained
// remote-mode episode used to re-warn on EVERY re-trip (~every 6 min,
// all day when the laptop is away). One warn when the breaker OPENS,
// one when the NAS comes back; the episode in between stays quiet.
let breakerEpisodeOpen = false
// Flap damping (same day, four transitions in 30 min on a marginal WAN
// link): a failure RIGHT AFTER a recovery earns a longer cooldown — the
// link is oscillating around the probe threshold and rapid retries just
// churn state. A failure after a LONG healthy stretch keeps the quick
// 5-min retry, so genuinely-good windows are still harvested promptly
// (the 17:58Z quick pass that healed nine stranded tracks rode exactly
// such a window — never damp those).
let lastRecoveryAt = 0
const FLAP_WINDOW_MS = 10 * 60_000
const COOLDOWN_MS = 5 * 60_000
const FLAP_COOLDOWN_MS = 15 * 60_000

export async function nasAvailable(): Promise<boolean> {
  const now = Date.now()
  if (now < nasBreakerUntil) return false
  if (now - lastProbeAt < 30_000) return lastVerdict   // verdict cache
  if (probeInflight) return probeInflight
  probeInflight = (async () => {
    try {
      const ok = await Promise.race([
        stat(NAS_STATE_DIR_PATH).then(() => true, () => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
      ])
      lastVerdict = ok
      lastProbeAt = Date.now()
      if (!ok) {
        const flapping = lastRecoveryAt > 0 && Date.now() - lastRecoveryAt < FLAP_WINDOW_MS
        nasBreakerUntil = Date.now() + (flapping ? FLAP_COOLDOWN_MS : COOLDOWN_MS)
        if (!breakerEpisodeOpen) {
          breakerEpisodeOpen = true
          console.warn(`[nas-breaker] NAS slow or absent — skipping ALL NAS IO (${flapping ? '15-min cooldown, link is flapping' : '5-min cooldowns'}; will report recovery)`)
        }
      } else if (breakerEpisodeOpen) {
        breakerEpisodeOpen = false
        lastRecoveryAt = Date.now()
        console.warn('[nas-breaker] NAS recovered — resuming NAS IO')
      }
      return ok
    } finally {
      probeInflight = null
    }
  })()
  return probeInflight
}

/** Last KNOWN verdict — never touches the filesystem. Kept for sync
 *  contexts (UI badges); authoritative checks use nasAvailable(). */
export function isNasMounted(): boolean {
  return Date.now() < nasBreakerUntil ? false : lastVerdict
}

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
