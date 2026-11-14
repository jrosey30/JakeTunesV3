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
import { UPDATE_KINDS, type UpdateKind, type UpdateReadyState } from '../common/update-ready.ts'

/** What the marker itself says; the shell adds where this Mac's decision stands. */
export type UpdateOffer = Omit<UpdateReadyState, 'phase' | 'at' | 'waitingFor'>

/** Both live in Electron's userData (~/Library/Application Support/JakeTunes). */
export const UPDATE_READY_FILE = 'update-ready.json'
export const UPDATE_GO_FILE = 'update-go'
/** A gate waits 45–180 min; anything older than this is not a gate we trust. */
export const MARKER_MAX_AGE_MS = 12 * 60 * 60 * 1000
/**
 * A v 2 gate (the weekly release) waits for a decision, which may be "Install
 * at…" up to 7 days after the offer was seen: it is trusted for 9 days. The
 * next week's offer replaces it long before that.
 */
export const MARKER_V2_MAX_AGE_MS = 9 * 24 * 60 * 60 * 1000
/** At most this many notes, each cut to this length: the bar shows one, the list all. */
export const MAX_NOTES = 30
export const MAX_NOTE_CHARS = 200

export type MarkerVerdict =
  | { kind: 'ready'; state: UpdateOffer; gatePid: number }
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
  const v = o['v']
  if (v !== 1 && v !== 2) return { kind: 'invalid', reason: 'v' }
  const sha = typeof o['sha'] === 'string' ? o['sha'].trim() : ''
  if (!sha) return { kind: 'invalid', reason: 'sha' }
  const gatePid = o['gatePid']
  if (typeof gatePid !== 'number' || !Number.isInteger(gatePid) || gatePid <= 0) return { kind: 'invalid', reason: 'gatePid' }
  const stagedAt = typeof o['stagedAt'] === 'string' ? Date.parse(o['stagedAt']) : NaN
  if (!Number.isFinite(stagedAt)) return { kind: 'invalid', reason: 'stagedAt' }
  // A dead gate is checked before age and sha: whatever else the file says,
  // nobody is waiting behind it, so it must go.
  if (!ctx.pidAlive(gatePid)) return { kind: 'dead-gate', gatePid }
  if (ctx.now - stagedAt > (v === 2 ? MARKER_V2_MAX_AGE_MS : MARKER_MAX_AGE_MS)) return { kind: 'invalid', reason: 'stale' }
  const running = ctx.runningSha && ctx.runningSha !== 'dev' ? ctx.runningSha : null
  if (running && sameBuild(sha, running)) return { kind: 'same-build', sha }
  const version = typeof o['version'] === 'string' ? o['version'] : ''
  const note = typeof o['note'] === 'string' ? o['note'] : ''
  const offeredAtMs = typeof o['offeredAt'] === 'string' ? Date.parse(o['offeredAt']) : NaN
  return {
    kind: 'ready',
    gatePid,
    state: {
      sha,
      version,
      note,
      label: oneLine(o['label']) || oneLine(note) || (version ? `Version ${version}` : 'A new build'),
      kind: v === 2 && UPDATE_KINDS.includes(o['kind'] as UpdateKind) ? (o['kind'] as UpdateKind) : 'fix',
      notes: v === 2 ? readNotes(o['notes']) : (oneLine(note) ? [oneLine(note)] : []),
      offeredAt: new Date(Number.isFinite(offeredAtMs) ? offeredAtMs : stagedAt).toISOString(),
      decides: v === 2,
    },
  }
}

/** A string on one line, trimmed, at most MAX_NOTE_CHARS; '' for anything else. */
function oneLine(x: unknown): string {
  if (typeof x !== 'string') return ''
  return x.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS)
}

/** The plain one-line notes of a v 2 marker. Anything that isn't a non-empty string is left out. */
export function readNotes(x: unknown): string[] {
  if (!Array.isArray(x)) return []
  return x.map(oneLine).filter((n) => n !== '').slice(0, MAX_NOTES)
}

/** What the app writes into update-go: the bare sha, one line (the gate strips whitespace). */
export function goFileBody(sha: string): string {
  return `${sha.trim()}\n`
}

export function sameState(a: UpdateReadyState | null, b: UpdateReadyState | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
