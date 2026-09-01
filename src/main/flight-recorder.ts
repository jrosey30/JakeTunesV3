/**
 * The flight recorder — the app's durable memory of its own failures.
 *
 * 2026-08-21, the reliability program's first brick (Jake: "glitch stomping,
 * bug fixing, reliability… thats how sturdy the guts of the app need to be").
 * The audit that preceded this found the app RELIABLE AND BLIND: zero crash
 * reports, but also zero durable main-process logging — every console.warn
 * ever written (lane failures, cache misses, sync warnings) goes to stdout,
 * and stdout goes nowhere when the app is launched from Finder. The renderer
 * had no crash net at all: a grey-screen death left no trace. You cannot
 * stomp glitches you cannot see; this module is the seeing.
 *
 * Shape:
 *  - record(level, tag, detail) appends one JSON line {ts, level, tag, detail}
 *    to main.log in the state dir. Fire-and-forget, strictly ordered by an
 *    append chain.
 *  - mirrorConsole() wraps console.warn/error so EVERY existing call site in
 *    main flows into the log without being touched. Stdout behavior is
 *    preserved (dev terminals still see everything).
 *  - Rotation at maxBytes into a single .1 generation (the audio-events.log
 *    doctrine: worst case 2× cap on disk, and the recent past — the crash
 *    forensics window — always survives the boundary). Size is checked every
 *    50th append so the hot path stays one syscall.
 *
 * Iron rule: the recorder NEVER throws and never rejects. A recorder that
 * can take the app down is strictly worse than no recorder. Internal
 * failures increment a counter that itself gets reported on the next
 * successful append — the recorder confesses its own drops.
 *
 * Electron-free: paths and clock arrive injected, so node --test exercises
 * everything against a temp dir.
 */

import { appendFile, rename, stat } from 'fs/promises'

export interface FlightRecorderDeps {
  /** Absolute path of the log file. MUST be a LOCAL path (userData) — the
   *  state dir can resolve to the NAS, and a wedged SMB mount would hang
   *  every append in the kernel at exactly the moment logging matters. */
  logPath: () => string
  /** Rotation threshold. Default 5MB — weeks of normal operation. */
  maxBytes?: number
  now?: () => number
  /** Appends wait on this (app.whenReady in production) so record() is
   *  callable from the very first module line while writes — and the
   *  logPath() evaluation they need — defer until the platform is up. */
  ready?: Promise<void>
}

export interface FlightRecorder {
  record: (level: 'info' | 'warn' | 'error', tag: string, detail?: unknown) => void
  /** Wraps console.warn/console.error to also record. Idempotent. */
  mirrorConsole: () => void
  /** Appends dropped so far (recorder-internal failures). For tests/health. */
  drops: () => number
}

const CHECK_EVERY = 50
const MAX_LINE_BYTES = 4 * 1024

/** Best-effort safe serialization: errors keep message + first stack line,
 *  cycles collapse, and the line is capped so one giant payload can't bloat
 *  the log past its own rotation math. */
export function serializeDetail(detail: unknown): string {
  if (detail === undefined) return ''
  try {
    if (detail instanceof Error) {
      const stack = (detail.stack || '').split('\n').slice(0, 2).join(' | ')
      return JSON.stringify({ error: detail.message, stack })
    }
    const seen = new WeakSet<object>()
    const s = JSON.stringify(detail, (_k, v: unknown) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[cycle]'
        seen.add(v)
      }
      if (typeof v === 'bigint') return String(v)
      return v
    })
    return s.length > MAX_LINE_BYTES ? s.slice(0, MAX_LINE_BYTES) + '…"' : s
  } catch {
    try { return JSON.stringify(String(detail)) } catch { return '"[unserializable]"' }
  }
}

export function initFlightRecorder(deps: FlightRecorderDeps): FlightRecorder {
  const maxBytes = deps.maxBytes ?? 5 * 1024 * 1024
  const now = deps.now ?? Date.now
  let appendsSinceCheck = 0
  let dropped = 0
  let mirrored = false
  // The append chain: strict ordering without ever surfacing a rejection.
  // Even the readiness gate is caught — a failed boot must not poison it.
  let chain: Promise<void> = (deps.ready ?? Promise.resolve()).catch(() => {})

  const record = (level: 'info' | 'warn' | 'error', tag: string, detail?: unknown): void => {
    // Serialize OUTSIDE the chain so a throwing toJSON can't poison it.
    let line: string
    try {
      const d = serializeDetail(detail)
      line = `{"ts":"${new Date(now()).toISOString()}","level":"${level}","tag":${JSON.stringify(String(tag))}${d ? `,"detail":${d}` : ''}${dropped > 0 ? `,"droppedBefore":${dropped}` : ''}}\n`
      if (dropped > 0) dropped = 0
    } catch {
      dropped++
      return
    }
    chain = chain.then(async () => {
      try {
        if (++appendsSinceCheck >= CHECK_EVERY) {
          appendsSinceCheck = 0
          try {
            const { size } = await stat(deps.logPath())
            if (size > maxBytes) await rename(deps.logPath(), deps.logPath() + '.1')
          } catch { /* first write, or rotation raced — the append below settles it */ }
        }
        await appendFile(deps.logPath(), line)
      } catch {
        dropped++
      }
    })
  }

  const mirrorConsole = (): void => {
    if (mirrored) return
    mirrored = true
    const origWarn = console.warn.bind(console)
    const origError = console.error.bind(console)
    console.warn = (...args: unknown[]) => {
      origWarn(...args)
      record('warn', 'console', consoleArgsDetail(args))
    }
    console.error = (...args: unknown[]) => {
      origError(...args)
      record('error', 'console', consoleArgsDetail(args))
    }
  }

  return { record, mirrorConsole, drops: () => dropped }
}

/** First arg becomes the message; remaining args ride as a compact tail. */
function consoleArgsDetail(args: unknown[]): unknown {
  const [head, ...rest] = args
  const msg = typeof head === 'string' ? head : undefined
  if (msg !== undefined && rest.length === 0) return { msg }
  return { msg: msg ?? '(non-string)', args: rest.length ? rest : (msg === undefined ? [head] : undefined) }
}

/**
 * Shape a crash report arriving from the renderer over IPC. The payload is
 * untrusted (a corrupted renderer is exactly when this path runs) — every
 * field is coerced to a bounded string so a malformed report can never hurt
 * the main process it is confessing to.
 */
export function sanitizeCrashPayload(p: unknown): { kind: string; message: string; stack: string; source: string } {
  const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>
  const str = (v: unknown, cap: number): string => String(v ?? '').slice(0, cap)
  return {
    kind: str(o.kind, 40) || 'unknown',
    message: str(o.message, 500),
    stack: str(o.stack, 1500),
    source: str(o.source, 300),
  }
}

/**
 * Rate-limited warn for known-recurring conditions (renovation-roadmap
 * Phase 3). The top five warnings were 76% of the flight recorder's
 * volume — thousands of identical lines burying novel failures. Each
 * key logs immediately the first time, then at most once per window,
 * confessing how many identical warns were suppressed in between.
 */
const QUIET_WARN_WINDOW_MS = 10 * 60 * 1000
const quietWarnState = new Map<string, { lastLoggedAt: number; suppressed: number }>()

export function quietWarn(key: string, ...args: unknown[]): void {
  const now = Date.now()
  const s = quietWarnState.get(key)
  if (!s) {
    quietWarnState.set(key, { lastLoggedAt: now, suppressed: 0 })
    console.warn(...args)
    return
  }
  if (now - s.lastLoggedAt < QUIET_WARN_WINDOW_MS) {
    s.suppressed++
    return
  }
  const held = s.suppressed
  s.lastLoggedAt = now
  s.suppressed = 0
  console.warn(...args, held > 0 ? `(+${held} suppressed in the last window)` : '')
}
