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

import { spawn, type ChildProcess } from 'child_process'
import { safeIpcError } from './safe-ipc-error.ts'
import { existsSync } from 'fs'
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
// 4.5.0-119: the full reconcile (rsync stat-walk over the ~73GB library) is
// heavy + flaky over SMB. It's a SAFETY NET, not the main path — quick syncs
// (on every import/edit, ~15s) carry new music. So run the full one rarely,
// nice'd + preemptible, so it never blocks or hogs. A timeout on it is now
// harmless: quick syncs keep new music flowing regardless.
const SAFETY_NET_INTERVAL_MS = 3_600_000  // 60 min — rare full reconcile (was 10 min)
const RUN_TIMEOUT_MS = 600_000            // kill a hung sync after 10 min

export type SyncReason =
  | 'import' | 'metadata-edit' | 'playlist' | 'safety-net' | 'manual' | 'artwork'

let getWindow: (() => BrowserWindow | null) | null = null
let debounceTimer: NodeJS.Timeout | null = null
let safetyNetTimer: NodeJS.Timeout | null = null
let inFlight = false
let pendingReason: SyncReason | null = null
// 4.5.0-119: handle to the in-flight sync child + its mode, so a fresh IMPORT
// can PREEMPT a slow full reconcile instead of queuing behind it (single-flight
// starvation made new music wait up to 10 min). `preempted` marks a deliberate
// kill so the exit isn't reported as a failure.
let currentChild: ChildProcess | null = null
let currentReason: SyncReason | null = null
let preempted = false
const isQuickReason = (r: SyncReason): boolean => r === 'import' || r === 'metadata-edit' || r === 'playlist'

// 4.5: persist the last sync outcome in process memory so the renderer
// can read "last backed up: 3 min ago" in Settings → Sync. Cleared on
// process restart — that's fine; a settings panel that says "not yet
// synced this session" after a fresh launch is honest, and the first
// import/edit trigger will populate it within minutes.
export interface LastSyncSnapshot {
  ok: boolean | null  // null = no sync attempted yet this session
  reason: SyncReason | null
  at: number | null   // epoch ms
  durationMs: number | null
  error: string | null
  scriptPresent: boolean  // false on installs where homemini sync is not configured
}
const lastSync: LastSyncSnapshot = {
  ok: null,
  reason: null,
  at: null,
  durationMs: null,
  error: null,
  scriptPresent: existsSync(SYNC_SCRIPT),
}
export function getLastSyncSnapshot(): LastSyncSnapshot {
  return { ...lastSync }
}

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
    // Brief 016: spawn with detached: true so the bash child becomes the
    // leader of a new process group. rsync (and any other descendant)
    // inherits the same PGID. When the timeout below fires, we can
    // signal the whole group via `kill -PGID` and reliably take down
    // rsync along with bash. Pre-fix, child.kill('SIGTERM') only hit
    // bash, which doesn't propagate to its rsync children — rsyncs
    // stuck on SMB orphaned to launchd and accumulated indefinitely
    // (prior session observed 41 stalled rsyncs on the MacBook, oldest
    // 13+ minutes old).
    //
    // detached: true creates the group but does NOT detach the child
    // from the parent's lifecycle — we don't call child.unref(), so
    // the orchestrator still tracks exit normally and the bash process
    // dies if the orchestrator does.
    // 4.5.0-119: run under `nice` so the sync never competes with playback /
    // the UI for CPU. nice becomes the process-group leader; the group-kill
    // (timeout + preempt) still takes down nice → bash → rsync together.
    const child = spawn('nice', ['-n', '10', '/bin/bash', ...args], {
      detached: true,
      stdio: 'ignore',
    })
    currentChild = child
    preempted = false

    const killTimer = setTimeout(() => {
      timedOut = true
      // Brief 016: kill the entire process group, not just bash.
      // Negative pid signals the whole group (POSIX kill(2) semantics:
      // a negative pid arg signals every process in the group whose
      // PGID equals |pid|). The optional-chain + try-catch covers the
      // edge cases where child.pid is undefined (spawn failed) or the
      // group already exited.
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGTERM')
        } else {
          child.kill('SIGTERM')
        }
      } catch {
        try { child.kill('SIGTERM') } catch { /* already exited */ }
      }
      // Brief 016 belt-and-suspenders: if SIGTERM doesn't take within
      // 10 sec, escalate to SIGKILL on the group. rsync stuck in an
      // uninterruptible SMB syscall (state 'U' in ps) may not respect
      // TERM, and we observed in-flight bash+rsync pairs surviving
      // long past the 10-min timeout in production — strongly
      // suggesting the SIGTERM path alone is unreliable here.
      setTimeout(() => {
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, 'SIGKILL')
          }
        } catch { /* already gone */ }
      }, 10_000)
    }, RUN_TIMEOUT_MS)

    child.on('exit', (code, signal) => {
      clearTimeout(killTimer)
      currentChild = null
      const durationMs = Date.now() - startedAt
      if (preempted) {
        console.log('[sync-orchestrator] full sync preempted by a fresh import — quick sync runs next')
        resolve({ ok: true, durationMs })
        return
      }
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
      currentChild = null
      const durationMs = Date.now() - startedAt
      console.warn('[sync-orchestrator] spawn error:', err)
      resolve({ ok: false, error: safeIpcError(err, 'tool-failed'), durationMs })
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
  currentReason = reason
  const result = await runSyncOnce(reason)
  inFlight = false
  currentReason = null

  lastSync.ok = result.ok
  lastSync.reason = reason
  lastSync.at = Date.now()
  lastSync.durationMs = result.durationMs
  lastSync.error = result.error || null
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
  // 4.4.59: the homemini sync is MacBook-only infrastructure — it needs
  // ~/bin/jaketunes-homemini-sync.sh and the Synology/Tailscale setup
  // behind it. On any other install (workmini, homemini itself, a fresh
  // machine) that script isn't there, so spawning bash on it just exits
  // 127. Skip silently — a JakeTunes deployment that isn't the
  // canonical sync source shouldn't sync, and definitely shouldn't
  // surface an error Notice for not doing so.
  if (!existsSync(SYNC_SCRIPT)) return
  pendingReason = reason
  // 4.5.0-119: if a fresh import/edit lands while a slow FULL reconcile is
  // grinding, preempt it — kill the full sync so the quick one runs now
  // rather than queuing behind a 73GB walk. The killed run resolves cleanly
  // (preempted) and this pending quick reason fires right after.
  if (isQuickReason(reason) && inFlight && currentReason && !isQuickReason(currentReason) && currentChild) {
    preempted = true
    try {
      if (currentChild.pid !== undefined) process.kill(-currentChild.pid, 'SIGTERM')
      else currentChild.kill('SIGTERM')
    } catch {
      try { currentChild.kill('SIGTERM') } catch { /* already gone */ }
    }
  }
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
  // 4.4.59: only run the homemini sync on a machine actually set up for
  // it — the canonical-source MacBook, which has the sync script. On
  // every other install the script is absent; don't start the
  // safety-net timer at all, so it never fires a doomed sync (exit 127).
  if (!existsSync(SYNC_SCRIPT)) {
    console.log(`[sync-orchestrator] sync script not found (${SYNC_SCRIPT}) — homemini sync disabled on this machine`)
    return
  }
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
