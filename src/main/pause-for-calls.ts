/**
 * Pause for video calls — the thin shell around pause-for-calls-core.ts.
 *
 * Spawns native/micwatch (the per-process microphone sensor: which
 * processes are running audio INPUT, by pid + bundle id), feeds its state
 * lines and the renderer's isPlaying into the pure decision core, and
 * carries out the core's actions through paths the app already has:
 *
 *   pause / play → index.ts sendMediaKeyAction → renderer menu-action
 *                  'pause' / 'play' (idempotent there)
 *   notice       → 'app-notice' → renderer setNotice (the queue-notice strip)
 *   everything   → the flight recorder, as calls.* rows
 *
 * Stand-down policy — never a crash, never a repeated log:
 *   - helper binary missing (not built)            → one console.warn, off
 *   - helper exits "unsupported" before any state  → one console.warn, off
 *   - helper dies after it had been working        → respawn after 1 s, 5 s,
 *                                                     30 s; then one warn, off
 * A respawned helper prints its current state first, so nothing changes on
 * a respawn until that fresh line arrives (core rule 7).
 *
 * The setting (AppSettings.calls.pauseForCalls, default on; off while the
 * "move music to another speaker during calls" feature is configured) is
 * re-read from app-settings.json on every helper event — a few tiny reads
 * a day, no new wiring into the settings IPC.
 */
import { app, ipcMain, type IpcMainEvent } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  createCallPauser,
  parseHelperChunk,
  pauseForCallsEnabled,
  respawnDelay,
  RESPAWN_BACKOFF_MS,
  type CallAction,
  type MicState,
} from './pause-for-calls-core.ts'

export interface PauseForCallsDeps {
  /** The media-key path; 'pause' and 'play' are idempotent in the renderer. */
  sendAction: (action: 'pause' | 'play') => void
  /** Transient strip notice in the renderer (the 'app-notice' channel). */
  notify: (notice: { text: string; kind: 'info'; durationMs: number }) => void
  /** Flight-recorder row, info level. */
  record: (tag: string, detail?: unknown) => void
  settingsPath: () => string
  /** Override for the helper binary location (experiments). */
  helperPath?: string
}

export interface PauseForCallsHandle {
  stop: () => void
}

/** JakeTunes' own bundle ids: the packaged app and its helpers, and the dev Electron shell. */
const OWN_BUNDLE_PREFIXES = ['com.jacobrosenbaum.jaketunes', 'com.github.electron']
/** A respawned helper that lives this long earns the backoff counter a reset. */
const HEALTHY_AFTER_MS = 60_000

/** Resources/bin/micwatch in a packaged app; native/bin/micwatch in dev (see scripts/build-native.sh). */
export function micwatchPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'micwatch')
    : join(app.getAppPath(), 'native', 'bin', 'micwatch')
}

const NOOP: PauseForCallsHandle = { stop: () => { /* nothing started */ } }

export function startPauseForCalls(deps: PauseForCallsDeps): PauseForCallsHandle {
  if (process.platform !== 'darwin') return NOOP
  const helper = deps.helperPath ?? micwatchPath()
  if (!existsSync(helper)) {
    console.warn(`[calls] micwatch helper missing at ${helper} — "Pause for video calls" stands down (npm run build compiles native/micwatch)`)
    deps.record('calls.helper-missing', { helper })
    return NOOP
  }

  // Own processes (core rule 6): this pid plus every Chromium child — the
  // renderer, the GPU process and the audio-service utility that actually
  // opens the mic for Savant / mixtape intros. Cached for a second because
  // the core asks per pid.
  let ownPids = new Set<number>()
  let ownPidsAt = 0
  const isOwn = (pid: number, bundle: string): boolean => {
    const now = Date.now()
    if (now - ownPidsAt > 1000) {
      ownPids = new Set([process.pid])
      try {
        for (const m of app.getAppMetrics()) ownPids.add(m.pid)
      } catch { /* metrics unavailable — the pid + bundle checks still apply */ }
      ownPidsAt = now
    }
    if (ownPids.has(pid)) return true
    const b = bundle.toLowerCase()
    return OWN_BUNDLE_PREFIXES.some((p) => b.startsWith(p))
  }

  const pauser = createCallPauser({
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    isOwn,
    emit: (action: CallAction) => {
      switch (action.type) {
        case 'pause':
          deps.record('calls.pause', { bundles: pauser.snapshot().call?.bundles ?? [] })
          deps.sendAction('pause')
          break
        case 'resume':
          deps.record('calls.resume')
          deps.sendAction('play')
          break
        case 'notice':
          deps.notify({ text: action.text, kind: 'info', durationMs: action.durationMs })
          break
      }
    },
  })

  // The renderer's isPlaying — the same one-way message index.ts already
  // tracks as playbackActive (ipcMain.on is fine outside the registrar; it
  // is request/response handle() that must go through it).
  const onPlaybackActive = (_e: IpcMainEvent, active: unknown): void => {
    pauser.handle({ type: 'playback', playing: !!active })
  }
  ipcMain.on('set-playback-active', onPlaybackActive)

  const readEnabled = async (): Promise<boolean> => {
    try {
      return pauseForCallsEnabled(JSON.parse(await readFile(deps.settingsPath(), 'utf-8')))
    } catch {
      return pauseForCallsEnabled(undefined)   // no settings file yet = defaults = on
    }
  }

  // Mic events are rare (a few a day). A promise chain keeps the settings
  // read and the two core events in order even if two lines land together.
  let chain: Promise<void> = Promise.resolve()
  const feed = (state: MicState): void => {
    chain = chain
      .then(async () => {
        pauser.handle({ type: 'settings', enabled: await readEnabled() })
        pauser.handle({ type: 'mic', state })
      })
      .catch((err) => { console.warn('[calls] mic event failed:', err) })
  }

  let child: ChildProcess | null = null
  let stopped = false
  let attempt = 0
  let respawnTimer: ReturnType<typeof setTimeout> | null = null
  let healthyTimer: ReturnType<typeof setTimeout> | null = null

  const spawnHelper = (): void => {
    if (stopped) return
    respawnTimer = null
    let buf = ''
    let gotLine = false
    let stderrHead = ''
    let settled = false

    // 'exit' and 'error' can both fire for one child; settle once.
    const settle = (proc: ChildProcess | null, code: number | null, signal: NodeJS.Signals | null, err: Error | null): void => {
      if (settled) return
      settled = true
      if (child === proc) child = null
      if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null }
      if (stopped) return
      const reason = (stderrHead.split('\n')[0] || '').trim()
      if (!gotLine && (code === 2 || /^unsupported/i.test(reason) || err)) {
        // Never produced a state on this Mac: the API is not there. Off for the session.
        console.warn(`[calls] micwatch unavailable (${reason || err?.message || `exit ${code}`}) — "Pause for video calls" stands down`)
        deps.record('calls.helper-unsupported', { code, signal, reason: reason || err?.message || '' })
        return
      }
      const delay = respawnDelay(attempt)
      if (delay === null) {
        console.warn(`[calls] micwatch helper kept dying (${RESPAWN_BACKOFF_MS.length} restarts) — "Pause for video calls" stands down for this session`)
        deps.record('calls.helper-gave-up', { code, signal, reason })
        return
      }
      attempt += 1
      deps.record('calls.helper-exit', { code, signal, reason, respawnInMs: delay })
      respawnTimer = setTimeout(spawnHelper, delay)
    }

    let proc: ChildProcess
    try {
      proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      settle(null, null, null, err instanceof Error ? err : new Error(String(err)))
      return
    }
    child = proc
    proc.stdout?.setEncoding('utf-8')
    proc.stdout?.on('data', (chunk: string) => {
      const parsed = parseHelperChunk(buf, chunk)
      buf = parsed.rest
      for (const state of parsed.states) {
        gotLine = true
        deps.record('calls.mic', state)
        feed(state)
      }
    })
    proc.stderr?.setEncoding('utf-8')
    proc.stderr?.on('data', (chunk: string) => { if (stderrHead.length < 400) stderrHead += chunk })
    proc.on('error', (err) => settle(proc, null, null, err))
    proc.on('exit', (code, signal) => settle(proc, code, signal, null))
    healthyTimer = setTimeout(() => { attempt = 0 }, HEALTHY_AFTER_MS)
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null }
    if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null }
    ipcMain.removeListener('set-playback-active', onPlaybackActive)
    pauser.dispose()
    const proc = child
    child = null
    if (proc) {
      // Closing stdin is the helper's own exit signal; kill() is the backstop.
      try { proc.stdin?.end() } catch { /* already closed */ }
      try { proc.kill() } catch { /* already gone */ }
    }
  }

  app.once('will-quit', stop)
  deps.record('calls.start', { helper })
  spawnHelper()
  return { stop }
}
