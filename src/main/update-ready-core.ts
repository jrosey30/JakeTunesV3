/**
 * Update ready — the pure half (2026-10-30).
 *
 * Jake: "when you update, instead of me pushing it through, there should be
 * an indication somewhere within jaketunes that it is ready to update."
 *
 * The install gate (scripts/install/jaketunes-install-gate.sh) stages a
 * build and then WAITS for no audio + 120 s of idle before it quits the app
 * and swaps /Applications/JakeTunes.app. While it waits it writes
 * `update-ready.json` into the app's data folder; the app answers a click
 * on "Install" by writing `update-go` with the same sha, which lets the gate
 * skip the idle wait (never the audio check). This module decides what a
 * marker on disk MEANS — nothing here touches the filesystem, Electron or
 * the clock, so node --test covers every rule.
 *
 * A marker counts only if all of these hold:
 *   - v === 1 and the shape is right (sha, gatePid, stagedAt present)
 *   - the gate that wrote it is still alive (gatePid answers signal 0);
 *     a dead gate means a stale file and the caller deletes it
 *   - it is younger than MARKER_MAX_AGE_MS (12 h)
 *   - its sha names a build OTHER than the one running — a marker for the
 *     build we already are is the tail of the install that just happened.
 *     A dev run has no build sha ('dev'): every marker is new then.
 */
import type { UpdateReadyState } from '../common/update-ready.ts'

/** Both live in Electron's userData (~/Library/Application Support/JakeTunes). */
export const UPDATE_READY_FILE = 'update-ready.json'
export const UPDATE_GO_FILE = 'update-go'
/** A gate waits 45–180 min; anything older than this is not a gate we trust. */
export const MARKER_MAX_AGE_MS = 12 * 60 * 60 * 1000

export type MarkerVerdict =
  | { kind: 'ready'; state: UpdateReadyState; gatePid: number }
  /** Valid, alive, but it names the build that is running — nothing to offer. */
  | { kind: 'same-build'; sha: string }
  /** Valid shape, but the gate that wrote it is gone — the file is litter; delete it. */
  | { kind: 'dead-gate'; gatePid: number }
  | { kind: 'invalid'; reason: 'shape' | 'v' | 'sha' | 'gatePid' | 'stagedAt' | 'stale' }

export interface JudgeContext {
  now: number
  /** The running build's sha (build-provenance.ts); 'dev' / null = unknown. */
  runningSha: string | null
  pidAlive: (pid: number) => boolean
}

/** The marker's sha may be the full 40 chars while build-info keeps 12 — compare what both have (≥ 7). */
export function sameBuild(a: string, b: string): boolean {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  const n = Math.min(x.length, y.length, 12)
  if (n < 7) return false
  return x.slice(0, n) === y.slice(0, n)
}

/** JSON.parse that answers null for anything unparseable (a torn or empty file). */
export function parseMarkerText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function judgeMarker(raw: unknown, ctx: JudgeContext): MarkerVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid', reason: 'shape' }
  const o = raw as Record<string, unknown>
  if (o['v'] !== 1) return { kind: 'invalid', reason: 'v' }
  const sha = typeof o['sha'] === 'string' ? o['sha'].trim() : ''
  if (!sha) return { kind: 'invalid', reason: 'sha' }
  const gatePid = o['gatePid']
  if (typeof gatePid !== 'number' || !Number.isInteger(gatePid) || gatePid <= 0) return { kind: 'invalid', reason: 'gatePid' }
  const stagedAt = typeof o['stagedAt'] === 'string' ? Date.parse(o['stagedAt']) : NaN
  if (!Number.isFinite(stagedAt)) return { kind: 'invalid', reason: 'stagedAt' }
  // A dead gate is checked before age and sha: whatever else the file says,
  // nobody is waiting behind it, so it must go.
  if (!ctx.pidAlive(gatePid)) return { kind: 'dead-gate', gatePid }
  if (ctx.now - stagedAt > MARKER_MAX_AGE_MS) return { kind: 'invalid', reason: 'stale' }
  const running = ctx.runningSha && ctx.runningSha !== 'dev' ? ctx.runningSha : null
  if (running && sameBuild(sha, running)) return { kind: 'same-build', sha }
  return {
    kind: 'ready',
    gatePid,
    state: {
      sha,
      version: typeof o['version'] === 'string' ? o['version'] : '',
      note: typeof o['note'] === 'string' ? o['note'] : '',
    },
  }
}

/** What the app writes into update-go: the bare sha, one line (the gate strips whitespace). */
export function goFileBody(sha: string): string {
  return `${sha.trim()}\n`
}

export function sameState(a: UpdateReadyState | null, b: UpdateReadyState | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.sha === b.sha && a.version === b.version && a.note === b.note
}
