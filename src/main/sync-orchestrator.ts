/**
 * 4.4.18: Library sync orchestrator — JakeTunes main process replaces
 * launchd as the trigger for the laptop → Synology → homemini chain.
 *
 * Why this exists:
 * The original `com.jaketunes.sync` LaunchAgent could not access
 * /Volumes/JakeShared on macOS Sequoia. launchd-domain processes are
 * blocked from network volumes regardless of TCC grants, SessionCreate,
 * launchctl-asuser, or osascript wrapping. The kernel enforcement is
 * independent of every workaround tried. The shell script itself works
 * perfectly — the issue was solely the launchd parent.
 *
 * Solution: run the sync from JakeTunes' main process. JakeTunes is a
 * user GUI Electron app with the same TCC permissions as the user's
 * interactive shell, including full access to network volumes.
 *
 * Triggers wired by main/index.ts:
 *   - safety-net setInterval(10 min)
 *   - post-success of `import-track` / `import-tracks`
 *   - post-success of `save-metadata-override`
 *   - post-success of `save-playlists`
 *
 * Every trigger funnels through a single 30-sec debounce so an album
 * of 12 tracks results in ONE sync, not 12. A single-flight gate
 * prevents two syncs from running concurrently — if a trigger fires
 * while one is in flight, the new trigger is captured and a fresh
 * sync runs as soon as the current one finishes. The final state is
 * always synced; no trigger is dropped.
 *
 * Runs ~/bin/jaketunes-homemini-sync.sh as a child process. That
 * script handles auto-mount, rsync, library.json scp over Tailscale,
 * and JakeTunes restart on homemini. It also no-ops cleanly when
 * library.json mtime hasn't changed.
 *
 * Outcome is forwarded to the renderer via `library-sync-status` IPC
 * — App.tsx subscribes and surfaces success/failure via the activity
 * store's setNotice (the 4.4.12 LCD-pill mode 4).
 */

import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import type { BrowserWindow } from 'electron'

const SYNC_SCRIPT = join(homedir(), 'bin', 'jaketunes-homemini-sync.sh')
// 4.4.36: dropped debounce 30 → 5 sec. The 30-sec window was meant to
// coalesce 12 import-track triggers from an album into one sync, but
// the single-flight gate already does that (the second trigger queues
// for after the first finishes). 5 sec is enough to cover the
// inbox-watcher's 1.5-sec batch debounce + a small margin, and makes
// "instant" feel possible — paired with --quick mode rsync, the whole
// chain runs in 10-15 sec for a typical album drop.
const DEBOUNCE_MS = 5_000
const SAFETY_NET_INTERVAL_MS = 600_000  // 10 min — full sync, catches deletes / out-of-band edits
const RUN_TIMEOUT_MS = 600_000          // kill a hung sync after 10 min

export type SyncReason =
  | 'import' | 'metadata-edit' | 'playlist' | 'safety-net' | 'manual'

let getWindow: (() => BrowserWindow | null) | null = null
let debounceTimer: NodeJS.Timeout | null = null
let safetyNetTimer: NodeJS.Timeout | null = null
let inFlight = false
let pendingReason: SyncReason | null = null

function notify(detail: { ok: boolean; reason: SyncReason; error?: string; durationMs?: number }): void {
  const win = getWindow?.()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('library-sync-status', detail)
  } catch (err) {
    console.warn('[sync-orchestrator] notify failed:', err)
  }
}

function runSyncOnce(reason: SyncReason): Promise<{ ok: boolean; error?: string; durationMs: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let timedOut = false

    // 4.4.36: --quick mode for the cheap, high-frequency triggers
    // (import / metadata-edit / playlist). It scans only files
    // modified in the last 10 min, skipping the rsync stat-walk over
    // the full 73GB library — cuts sync from ~5 min to ~15 sec for
    // a typical album drop. The 10-min safety-net tick uses FULL
    // mode (rsync --delete) to catch tombstones and out-of-band
    // edits. Manual invocations also use full mode (assume the user
    // wants a thorough sync).
    const useQuickMode = reason === 'import' || reason === 'metadata-edit' || reason === 'playlist'
    const args = [SYNC_SCRIPT]
    if (useQuickMode) args.push('--quick')

    console.log(`[sync-orchestrator] starting sync (reason=${reason}, mode=${useQuickMode ? 'quick' : 'full'})`)
    const child = spawn('/bin/bash', args, {
      detached: false,
      stdio: 'ignore',
    })

    const killTimer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already exited */ }
    }, RUN_TIMEOUT_MS)

    child.on('exit', (code, signal) => {
      clearTimeout(killTimer)
      const durationMs = Date.now() - startedAt
      if (timedOut) {
        console.warn(`[sync-orchestrator] sync TIMED OUT after ${durationMs}ms (reason=${reason})`)
        resolve({ ok: false, error: 'Sync timed out after 10 min', durationMs })
        return
      }
      if (code === 0) {
        console.log(`[sync-orchestrator] sync OK in ${durationMs}ms (reason=${reason})`)
        resolve({ ok: true, durationMs })
      } else if (code === 9) {
        // Lock contention — another invocation (e.g. user ran the
        // script manually) is already in progress. Not a real failure.
        console.log(`[sync-orchestrator] sync skipped (another run in progress)`)
        resolve({ ok: true, durationMs })
      } else {
        console.warn(`[sync-orchestrator] sync FAILED code=${code} signal=${signal} reason=${reason}`)
        resolve({
          ok: false,
          error: `sync script exited ${code}${signal ? ` (${signal})` : ''}`,
          durationMs,
        })
      }
    })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      const durationMs = Date.now() - startedAt
      console.warn('[sync-orchestrator] spawn error:', err)
      resolve({ ok: false, error: String(err), durationMs })
    })
  })
}

async function flushDebounce(): Promise<void> {
  debounceTimer = null
  // The single-flight gate: if a sync is already running, leave the
  // pending reason in place — when the current run finishes it will
  // see pendingReason and trigger a fresh debounce. This guarantees
  // the final state is synced without ever running two concurrently.
  if (inFlight) return

  const reason = pendingReason || 'manual'
  pendingReason = null
  inFlight = true
  const result = await runSyncOnce(reason)
  inFlight = false

  notify({ ok: result.ok, reason, error: result.error, durationMs: result.durationMs })

  // If a trigger landed while we were running, fire another debounced sync.
  if (pendingReason) {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flushDebounce, DEBOUNCE_MS)
  }
}

/**
 * Fire a sync. Debounced — repeated calls within DEBOUNCE_MS coalesce
 * into one run. Safe to call from any IPC handler; non-blocking.
 *
 * Use a tight reason string for telemetry / notifications:
 *   - 'import' — post-import-track / post-import-tracks
 *   - 'metadata-edit' — post-save-metadata-override
 *   - 'playlist' — post-save-playlists
 *   - 'safety-net' — periodic 10-min tick
 *   - 'manual' — explicit user action
 */
export function triggerSync(reason: SyncReason): void {
  pendingReason = reason
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(flushDebounce, DEBOUNCE_MS)
}

/**
 * Wire the orchestrator. Call once from main/index.ts after the
 * BrowserWindow exists. Starts the safety-net timer; does NOT fire
 * an initial sync (let import/edit triggers do that on their own
 * cadence so app launch doesn't slam the network).
 */
export function startSyncOrchestrator(windowAccessor: () => BrowserWindow | null): void {
  getWindow = windowAccessor
  if (safetyNetTimer) clearInterval(safetyNetTimer)
  safetyNetTimer = setInterval(() => {
    triggerSync('safety-net')
  }, SAFETY_NET_INTERVAL_MS)
  console.log(`[sync-orchestrator] started (script=${SYNC_SCRIPT}, safety-net every ${SAFETY_NET_INTERVAL_MS / 1000}s)`)
}

export function stopSyncOrchestrator(): void {
  if (safetyNetTimer) clearInterval(safetyNetTimer)
  safetyNetTimer = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  pendingReason = null
}
