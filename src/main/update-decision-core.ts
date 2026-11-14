/**
 * This Mac's answer to an offered update — the pure half (2026-11-14).
 *
 * Jake: "Don't force anything, user decides in app whether he wants to update
 * now. update later in middle of night or something (user will tell you when)
 * or skip to next week."
 *
 * Three answers, each Mac its own (macbook, workmini and homemini each keep
 * `update-decision.json` in their own userData):
 *   now   — install as soon as nothing is playing (the old "Install" click).
 *   at    — install at that time, any time in the next 7 days, if nothing is
 *           playing and no iPod sync or CD rip runs then; otherwise at the
 *           first moment after that nothing is.
 *   skip  — this release is never offered on this Mac again; next week's
 *           replaces it.
 * Nothing installs without one. A "now" or an "at" can be changed or cancelled
 * until the install starts (the go-file is written); a skip is final for that
 * release.
 *
 * The decision is on disk BEFORE anything acts on it, and the homemini side
 * hears about it as an `update` event in the usage log (usage-log.ts); there
 * is no server route for it.
 *
 * Nothing here touches the filesystem, Electron or the clock.
 */
import { installAtAllowed, type UpdateChoice } from '../common/update-ready.ts'
import { sameBuild } from './update-ready-core.ts'

export const UPDATE_DECISION_FILE = 'update-decision.json'
/** Enough to cover months of weekly releases; the oldest go first. */
export const MAX_SKIPPED = 30
/**
 * A launch is not an idle moment for an install that came due while the app
 * was closed: Jake has just opened it. The install waits this long after launch.
 */
export const LAUNCH_GRACE_MS = 5 * 60 * 1000

export interface StoredDecision {
  sha: string
  choice: 'now' | 'at'
  /** ISO, for 'at' only. */
  at: string | null
  decidedAt: string
}

export interface DecisionFile {
  v: 1
  /** The answer for the offer on screen, or null when there is none yet. */
  current: StoredDecision | null
  /** Releases skipped on this Mac, oldest first. */
  skipped: Array<{ sha: string; at: string }>
  /** The install the app last started, so the next launch can say whether it landed. */
  started: { sha: string; at: string; choice: 'now' | 'at' } | null
}

export const EMPTY_DECISIONS: DecisionFile = { v: 1, current: null, skipped: [], started: null }

const isIso = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x))
const isSha = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{7,40}$/i.test(x.trim())

/** Whatever is on disk, as a DecisionFile; anything that doesn't fit is left out, never thrown. */
export function parseDecisionFile(raw: unknown): DecisionFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_DECISIONS, skipped: [] }
  const o = raw as Record<string, unknown>
  let current: StoredDecision | null = null
  const c = o['current'] as Record<string, unknown> | null | undefined
  if (c && typeof c === 'object' && isSha(c['sha']) && isIso(c['decidedAt'])) {
    if (c['choice'] === 'now') current = { sha: String(c['sha']).trim(), choice: 'now', at: null, decidedAt: String(c['decidedAt']) }
    else if (c['choice'] === 'at' && isIso(c['at'])) current = { sha: String(c['sha']).trim(), choice: 'at', at: String(c['at']), decidedAt: String(c['decidedAt']) }
  }
  const skipped = (Array.isArray(o['skipped']) ? o['skipped'] : [])
    .filter((s): s is { sha: string; at: string } => !!s && typeof s === 'object' && isSha((s as Record<string, unknown>)['sha']) && isIso((s as Record<string, unknown>)['at']))
    .map((s) => ({ sha: s.sha.trim(), at: s.at }))
    .slice(-MAX_SKIPPED)
  const st = o['started'] as Record<string, unknown> | null | undefined
  const started = st && typeof st === 'object' && isSha(st['sha']) && isIso(st['at']) && (st['choice'] === 'now' || st['choice'] === 'at')
    ? { sha: String(st['sha']).trim(), at: String(st['at']), choice: st['choice'] as 'now' | 'at' }
    : null
  return { v: 1, current, skipped, started }
}

export function isSkipped(file: DecisionFile, sha: string): boolean {
  return file.skipped.some((s) => sameBuild(s.sha, sha))
}

/** The answer that stands for this offer: only one made for this very build. */
export function decisionFor(file: DecisionFile, sha: string): StoredDecision | null {
  return file.current && sameBuild(file.current.sha, sha) ? file.current : null
}

export type DecideResult =
  | { ok: true; file: DecisionFile; was: StoredDecision | null }
  | { ok: false; error: 'skipped' | 'bad-time' | 'bad-choice' }

/**
 * Apply an answer. A new answer for the same release replaces the old one (a
 * change of mind); an answer for another release replaces whatever stood for
 * the previous one (the next one replaces it). Skip is final.
 */
export function decide(file: DecisionFile, sha: string, choice: UpdateChoice, now: number): DecideResult {
  if (isSkipped(file, sha)) return { ok: false, error: 'skipped' }
  const was = decisionFor(file, sha)
  const decidedAt = new Date(now).toISOString()
  if (choice.choice === 'skip') {
    const skipped = [...file.skipped, { sha, at: decidedAt }].slice(-MAX_SKIPPED)
    return { ok: true, was, file: { ...file, current: null, skipped } }
  }
  if (choice.choice === 'now') return { ok: true, was, file: { ...file, current: { sha, choice: 'now', at: null, decidedAt } } }
  if (choice.choice === 'at') {
    const at = Date.parse(choice.at)
    if (!installAtAllowed(at, now)) return { ok: false, error: 'bad-time' }
    return { ok: true, was, file: { ...file, current: { sha, choice: 'at', at: new Date(at).toISOString(), decidedAt } } }
  }
  return { ok: false, error: 'bad-choice' }
}

/** Take the answer back: the offer stands again with no decision. Null when there was none to take. */
export function cancelDecision(file: DecisionFile, sha: string): { file: DecisionFile; was: StoredDecision } | null {
  const was = decisionFor(file, sha)
  if (!was) return null
  return { file: { ...file, current: null }, was }
}

/** An answer for a build that is no longer offered goes: the next one replaces it. */
export function dropStale(file: DecisionFile, offeredSha: string | null): DecisionFile {
  if (!file.current) return file
  if (offeredSha && sameBuild(file.current.sha, offeredSha)) return file
  return { ...file, current: null }
}

export function markStarted(file: DecisionFile, d: StoredDecision, now: number): DecisionFile {
  return { ...file, started: { sha: d.sha, at: new Date(now).toISOString(), choice: d.choice } }
}

export type Due =
  /** Not yet: the time has not come (or the launch grace). */
  | { kind: 'scheduled'; dueAt: number }
  /** The time has come but something is going on: wait for the first quiet moment. */
  | { kind: 'waiting'; reason: string }
  | { kind: 'go' }

/**
 * Where an "Install at…" stands. `busy` is the reason this Mac is not idle
 * ("the music is playing", "an iPod sync is running"), or null when it is.
 * `bootAt` is when the app started: an install that came due while the app
 * was closed waits LAUNCH_GRACE_MS from launch.
 */
export function dueState(d: StoredDecision, now: number, bootAt: number, busy: string | null): Due {
  const at = d.choice === 'at' && d.at ? Date.parse(d.at) : now
  const dueAt = d.choice === 'at' && at < bootAt ? Math.max(at, bootAt + LAUNCH_GRACE_MS) : at
  if (now < dueAt) return { kind: 'scheduled', dueAt }
  if (busy) return { kind: 'waiting', reason: busy }
  return { kind: 'go' }
}

/** The one line update-go holds for a skipped release. The gate reads `skip<sha>` once whitespace is gone. */
export function skipFileBody(sha: string): string {
  return `skip ${sha.trim()}\n`
}
