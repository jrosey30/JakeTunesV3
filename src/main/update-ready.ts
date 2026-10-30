/**
 * Update ready — the watcher + IPC shell around update-ready-core.ts (2026-10-30).
 *
 * The install gate (scripts/install/jaketunes-install-gate.sh) writes
 * `update-ready.json` into userData while it waits for a quiet moment to swap
 * the app. This module watches that file the way index.ts watches library.json
 * (fs.watch + a 15 s mtime poll as the backstop), judges it with the pure
 * core, and pushes `update-ready` to the renderer with { sha, version, note }
 * — or null when the marker goes away or stops counting (the gate was killed,
 * the marker aged out, the build it names is the one now running).
 *
 *   'update-ready:get'    → { ok, state }    what the renderer draws on mount
 *   'install-update-now'  → { ok, error? }   Jake clicked Install: pause the
 *                             music through the media-key path (the same
 *                             'pause' pause-for-calls sends), then write
 *                             `update-go` holding the sha. The gate sees it
 *                             within 2 s and installs without waiting for idle.
 *   push 'update-ready' (state | null)       whenever what the bar shows changes
 *
 * On start any leftover `update-go` is removed: a go-file can only outlive a
 * click when the gate it was meant for is gone, and the next gate must not
 * find a stale yes waiting for it.
 *
 * Electron-free (the registrar and paths arrive injected), so node --test
 * drives the whole module against a temp dir.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcRegistrar } from './ipc-register.ts'
import { REFUSED_SENDER } from './ipc-register.ts'
import type { UpdateReadyState } from '../common/update-ready.ts'
import {
  goFileBody,
  judgeMarker,
  parseMarkerText,
  sameState,
  UPDATE_GO_FILE,
  UPDATE_READY_FILE,
} from './update-ready-core.ts'

export interface UpdateReadyDeps {
  ipc: IpcRegistrar
  /** Electron userData — where the gate writes its markers. */
  userData: string
  /** build-provenance.ts buildSha; 'dev' when unknown (then every marker is new). */
  runningSha: string
  /** sendToRenderer('update-ready', state). */
  send: (state: UpdateReadyState | null) => void
  /** The media-key path (sendMediaKeyAction); 'pause' is idempotent in the renderer. */
  sendAction: (action: 'pause') => void
  /** Flight-recorder row, info level. */
  record: (tag: string, detail?: unknown) => void
  now?: () => number
  pidAlive?: (pid: number) => boolean
  pollMs?: number
  log?: (line: string) => void
}

export interface UpdateReadyHandle {
  /** Re-read the marker now; resolves after any push. */
  check: () => Promise<void>
  current: () => UpdateReadyState | null
  stop: () => void
}

const WATCH_DEBOUNCE_MS = 150

/** Signal 0 asks without touching: ESRCH = gone, EPERM = alive but not ours (still alive). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Unique staging name + rename, the atomic-write.ts doctrine, for a one-line text file. */
async function writeTextAtomic(dest: string, body: string): Promise<void> {
  const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    await writeFile(tmp, body, 'utf-8')
    await rename(tmp, dest)
  } catch (err) {
    await unlink(tmp).catch(() => { /* the real error is the one rethrown below */ })
    throw err
  }
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

export function startUpdateReadyWatcher(deps: UpdateReadyDeps): UpdateReadyHandle {
  const now = deps.now ?? Date.now
  const pidAlive = deps.pidAlive ?? processAlive
  const log = deps.log ?? ((line: string) => console.log(line))
  const markerPath = join(deps.userData, UPDATE_READY_FILE)
  const goPath = join(deps.userData, UPDATE_GO_FILE)
  let current: UpdateReadyState | null = null
  let stopped = false
  let warnedRead = false

  const evaluate = async (): Promise<void> => {
    if (stopped) return
    let next: UpdateReadyState | null = null
    let text: string | null = null
    try {
      text = await readFile(markerPath, 'utf-8')
    } catch (err) {
      if (errCode(err) !== 'ENOENT' && !warnedRead) {
        warnedRead = true
        console.warn(`[update-ready] could not read ${markerPath}:`, err instanceof Error ? err.message : err)
      }
    }
    if (text !== null) {
      const verdict = judgeMarker(parseMarkerText(text), { now: now(), runningSha: deps.runningSha, pidAlive })
      if (verdict.kind === 'ready') {
        next = verdict.state
      } else if (verdict.kind === 'dead-gate') {
        // Nobody is waiting behind this file any more — the gate that wrote
        // it was killed or crashed before its own cleanup ran.
        try {
          await unlink(markerPath)
          deps.record('update-ready.dead-gate', { gatePid: verdict.gatePid })
          log(`[update-ready] removed update-ready.json — gate pid ${verdict.gatePid} is gone`)
        } catch (err) {
          if (errCode(err) !== 'ENOENT') console.warn('[update-ready] could not remove a dead gate\'s marker:', err instanceof Error ? err.message : err)
        }
      } else if (verdict.kind === 'invalid') {
        log(`[update-ready] ignoring update-ready.json (${verdict.reason})`)
      }
    }
    if (sameState(next, current)) return
    current = next
    if (next) {
      deps.record('update-ready.seen', next)
      log(`[update-ready] build ${next.sha.slice(0, 12)} (${next.version || 'version unknown'}) is staged and waiting — showing "Update ready"`)
    } else {
      deps.record('update-ready.gone')
      log('[update-ready] no update waiting')
    }
    deps.send(next)
  }

  // One evaluation at a time: a watch burst and the poll never interleave
  // two reads, and a failure never breaks the chain.
  let chain: Promise<void> = Promise.resolve()
  const check = (): Promise<void> => {
    chain = chain.then(evaluate).catch((err: unknown) => {
      console.warn('[update-ready] check failed:', err instanceof Error ? err.message : err)
    })
    return chain
  }

  // A yes left behind by a gate that is gone must not greet the next gate.
  void unlink(goPath).then(
    () => { deps.record('update-ready.stale-go-removed') },
    (err: unknown) => { if (errCode(err) !== 'ENOENT') console.warn('[update-ready] could not remove a stale update-go:', err instanceof Error ? err.message : err) },
  )

  let watcher: FSWatcher | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  try {
    // The marker usually does not exist, so watch the folder and filter: a
    // file watch cannot see a file appear.
    watcher = fsWatch(deps.userData, { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== UPDATE_READY_FILE) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { debounce = null; void check() }, WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', (err) => { console.warn('[update-ready] fs.watch error — polling carries on:', err.message) })
  } catch (err) {
    console.warn('[update-ready] fs.watch could not start — polling only:', err instanceof Error ? err.message : err)
  }
  // The poll re-checks the gate's pid each time, so a killed gate clears
  // the indicator within one cadence even when no file event fires.
  const timer = setInterval(() => { void check() }, deps.pollMs ?? 15_000)
  void check()

  deps.ipc.handle('update-ready:get', () => ({ ok: true as const, state: current }), { refuse: REFUSED_SENDER })

  deps.ipc.handle('install-update-now', async (): Promise<{ ok: boolean; error?: string }> => {
    // Fresh read first: the gate may have died since the bar last drew.
    await check()
    const state = current
    if (!state) return { ok: false, error: 'no-update' }
    try {
      deps.sendAction('pause')
      await writeTextAtomic(goPath, goFileBody(state.sha))
      deps.record('update-ready.install-now', { sha: state.sha, version: state.version })
      log(`[update-ready] Install clicked — paused, update-go written for ${state.sha.slice(0, 12)}`)
      return { ok: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      deps.record('update-ready.install-failed', { sha: state.sha, error })
      console.warn('[update-ready] could not write update-go:', error)
      return { ok: false, error }
    }
  }, { refuse: REFUSED_SENDER })

  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (debounce) { clearTimeout(debounce); debounce = null }
    if (watcher) { try { watcher.close() } catch { /* already closed */ } watcher = null }
  }

  return { check, current: () => current, stop }
}
