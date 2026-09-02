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
 *   - safety-net setInterval(6 h)
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
import { nasAvailable, onNasRecovery, NAS_STATE_DIR_PATH } from './state-dir'
import { mountHostFor, isTailnetHost, decideSyncMode } from './sync-mode.ts'

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
// 2026-08-24 (Jake: "ease up the full sync cadence"): 60 min -> 6 h. The NAS
// is I/O-saturated at the filesystem level (btrfs extent-ref cleanup on an
// encrypted volume, plus Synology's own indexing of the music share), and a
// full both-tree stat walk over SMB costs ~320s while the link is degraded
// vs ~19s healthy. Nothing NEEDS this walk to be frequent: every import,
// metadata edit and playlist change fires its own quick sync in ~15s, so new
// music still reaches the NAS and the phone immediately. This is the
// belt-and-braces reconcile for out-of-band changes only.
const SAFETY_NET_INTERVAL_MS = 21_600_000 // 6 h — rare full reconcile (10 min -> 60 min -> 6 h)
const RUN_TIMEOUT_MS = 600_000            // kill a hung sync after 10 min

export type SyncReason =
  | 'import' | 'metadata-edit' | 'playlist' | 'safety-net' | 'manual' | 'artwork' | 'nas-recovery'

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
const isQuickReason = (r: SyncReason): boolean => r === 'import' || r === 'metadata-edit' || r === 'playlist' || r === 'nas-recovery'

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
  /** 2026-09-02: the last time a sync was DEFERRED by the NAS breaker (not a
   *  failure — it will run when the mount answers). null = not deferred since
   *  the last real run. Kept apart from ok/at so a deferral never paints the
   *  last real backup red. */
  deferredAt: number | null
  /** NAS served over the tailnet at the last attempt (laptop away from home). */
  remote: boolean
}
// A remote-mode downgrade leaves a FULL pass owed (tombstones + out-of-band
// edits wait for home network). Cleared by the first full sync that exits 0.
let fullSyncOwed = false

/** Is the NAS volume currently served over the tailnet (remote mode)?
 *  One cheap `mount` child per call — same source platform.ts's
 *  macNetworkMountSet() reads; never touches the (possibly slow) mount. */
async function nasMountedViaTailnet(): Promise<boolean> {
  const volume = NAS_STATE_DIR_PATH.split('/').slice(0, 3).join('/')
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const c = spawn('mount', [])
      let s = ''
      c.stdout.on('data', (d: Buffer) => { s += d.toString() })
      c.on('error', reject)
      c.on('exit', () => resolve(s))
    })
    return isTailnetHost(mountHostFor(out, volume))
  } catch {
    return false   // can't read the mount table → assume home; the breaker still guards
  }
}

const lastSync: LastSyncSnapshot = {
  ok: null,
  reason: null,
  at: null,
  durationMs: null,
  error: null,
  scriptPresent: existsSync(SYNC_SCRIPT),
  deferredAt: null,
  remote: false,
}
export function getLastSyncSnapshot(): LastSyncSnapshot {
  return { ...lastSync }
}

function notify(detail: { ok: boolean; reason: SyncReason; error?: string; durationMs?: number; deferred?: boolean }): void {
  const win = getWindow?.()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('library-sync-status', detail)
  } catch (err) {
    console.warn('[sync-orchestrator] notify failed:', err)
  }
}

async function runSyncOnce(reason: SyncReason): Promise<{ ok: boolean; error?: string; durationMs: number; deferred?: boolean }> {
  // Flight-log stomp (2026-08-22): eight hourly safety-net runs each hung
  // the full 10-minute kill-timer while the NAS breaker ALREADY knew the
  // mount was slow/absent (laptop in remote mode, SMB over the tailnet).
  // A sync that cannot land must not spend 600s discovering that — ask the
  // breaker first and defer; the next window retries after the cooldown.
  if (!(await nasAvailable())) {
    // warn, not log: warns are mirrored into the flight recorder, and this
    // fires at most once per sync window — the POSITIVE verdict that the
    // breaker gate worked must be visible where the timeouts used to be.
    console.warn(`[sync-orchestrator] deferred (reason=${reason}) — NAS unavailable or in breaker cooldown`)
    lastSync.remote = await nasMountedViaTailnet()
    return { ok: false, error: 'NAS unavailable (breaker cooldown)', durationMs: 0, deferred: true }
  }
  // WAN full-sync stomp (2026-08-22): when the NAS is mounted via the
  // TAILNET (remote mode), a full rsync --delete over the 73GB library
  // cannot finish inside the kill-timer — every hourly safety-net run
  // burned 600s and died. Downgrade full→quick out there (new imports
  // still propagate!) and remember a full pass is OWED; the first full
  // sync that succeeds back on home network clears the debt.
  const remote = await nasMountedViaTailnet()
  lastSync.remote = remote
  const wantQuick = isQuickReason(reason)
  const mode = decideSyncMode(wantQuick, remote)
  if (mode.downgradedFromFull) {
    fullSyncOwed = true
    console.warn(`[sync-orchestrator] remote mode (NAS via tailnet) — full sync deferred until home; running quick pass (reason=${reason})`)
  }
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let timedOut = false

    // 4.4.36: --quick mode for the cheap, high-frequency triggers
    // (import / metadata-edit / playlist). It scans only files
    // modified in the last 10 min, skipping the rsync stat-walk over
    // the full 73GB library — cuts sync from ~5 min to ~15 sec for
    // a typical album drop. The periodic safety-net tick uses FULL
    // mode (rsync --delete) to catch tombstones and out-of-band
    // edits. Manual invocations also use full mode (assume the user
    // wants a thorough sync).
    const useQuickMode = mode.quick
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
        // A FULL pass that landed pays off any remote-mode debt.
        if (!useQuickMode && fullSyncOwed) {
          fullSyncOwed = false
          console.log('[sync-orchestrator] owed full sync completed — remote-mode debt cleared')
        }
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

  if (result.deferred) {
    // A deferral is not a backup outcome — leave the last real run's
    // verdict alone and just note that we're waiting on the NAS.
    lastSync.deferredAt = Date.now()
  } else {
    lastSync.ok = result.ok
    lastSync.reason = reason
    lastSync.at = Date.now()
    lastSync.durationMs = result.durationMs
    lastSync.error = result.error || null
    lastSync.deferredAt = null
  }
  notify({ ok: result.ok, reason, error: result.error, durationMs: result.durationMs, deferred: result.deferred === true })

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
 *   - 'safety-net' — periodic full reconcile tick (6 h)
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
  // Recovery kick (2026-08-22): a good window on a flapping link may last
  // minutes — sync the moment the breaker closes instead of waiting for
  // the hourly tick (deterministic harvest; 17:58Z was timing luck).
  // 2026-08-24: this kick used the 'safety-net' reason, i.e. a FULL walk —
  // and on a link that flaps every ~20 min it fired one on every recovery,
  // which is the single biggest source of SMB load on an already-saturated
  // NAS (and of the 600s timeouts). The kick's whole purpose is to harvest
  // the change that just landed while the link was down, and that is exactly
  // what quick mode does, in seconds. Anything older is still caught by the
  // periodic full reconcile and by the fullSyncOwed debt.
  onNasRecovery(() => triggerSync('nas-recovery'))
  console.log(`[sync-orchestrator] started (script=${SYNC_SCRIPT}, safety-net every ${SAFETY_NET_INTERVAL_MS / 1000}s)`)
}

export function stopSyncOrchestrator(): void {
  if (safetyNetTimer) clearInterval(safetyNetTimer)
  safetyNetTimer = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  pendingReason = null
}
