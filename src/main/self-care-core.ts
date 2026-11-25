/**
 * The library looks after itself (V7, 2026-11-24).
 *
 * Jake's plan: "A quiet nightly check handles orphans, file sizes, overrides,
 * the play cache and the AI index. Only real decisions (duplicates, genres)
 * reach you, as one short list." File › Library had ten tools for this; now
 * they run by themselves, once a day, when nothing is playing and no sync runs.
 *
 * This file is the rules, with no effects: when the check may run, which jobs
 * run on which machine, which files are the app's own leftovers, which songs
 * still need a tempo, and when a tag write would change nothing. The runner
 * (self-care.ts) does the work through an injected host.
 */
import { createHash } from 'node:crypto'

/** In the order they run. Cheap and local first; the ones that reach out last. */
export const SELF_CARE_JOBS = ['play-cache', 'orphans', 'file-sizes', 'overrides', 'ai-index', 'analysis'] as const
export type SelfCareJob = typeof SELF_CARE_JOBS[number]

/**
 * Jobs that touch the music files or the library's own numbers run only on the
 * machine that owns them (the hub). A replica streams its songs: its files are a
 * cache, and the hub's check covers the library. The play cache is per machine.
 */
export const HUB_ONLY_JOBS: ReadonlySet<SelfCareJob> = new Set(['orphans', 'file-sizes', 'overrides', 'ai-index', 'analysis'])

export function jobsFor(isReplica: boolean): SelfCareJob[] {
  return SELF_CARE_JOBS.filter((j) => !isReplica || !HUB_ONLY_JOBS.has(j))
}

/** Nothing played for this long before the check starts. */
export const QUIET_MS = 10 * 60_000
/** Local hours [start, end): the night. */
export const WINDOW_START_HOUR = 1
export const WINDOW_END_HOUR = 6
/** A laptop closed every night still gets a check: after this, any quiet hour will do. */
export const OVERDUE_MS = 48 * 3_600_000
/** Once a day: a finished check isn't started again for this long. */
export const MIN_GAP_MS = 20 * 3_600_000
/** How often the runner looks. */
export const LOOK_EVERY_MS = 10 * 60_000

export interface GateFacts {
  now: number
  /** Local hour, 0–23. */
  hour: number
  /** When the last whole check finished; null = never. */
  lastRunAt: number | null
  playing: boolean
  /** Last time the player said anything (playing, or the stop). */
  lastMusicAt: number
  syncInFlight: boolean
}

export type GateAnswer =
  | { run: true }
  | { run: false; why: 'playing' | 'recent-music' | 'sync' | 'not-due' | 'outside-window' }

/** Whether the check may start now. Music and syncs always win. */
export function selfCareGate(f: GateFacts): GateAnswer {
  if (f.playing) return { run: false, why: 'playing' }
  if (f.syncInFlight) return { run: false, why: 'sync' }
  if (f.now - f.lastMusicAt < QUIET_MS) return { run: false, why: 'recent-music' }
  const since = f.lastRunAt === null ? Infinity : f.now - f.lastRunAt
  if (since < MIN_GAP_MS) return { run: false, why: 'not-due' }
  const night = f.hour >= WINDOW_START_HOUR && f.hour < WINDOW_END_HOUR
  if (!night && since < OVERDUE_MS) return { run: false, why: 'outside-window' }
  return { run: true }
}

/** Asked before every job and between steps of a long one: stop the moment music or a sync starts. */
export function stillQuiet(f: { playing: boolean; syncInFlight: boolean }): boolean {
  return !f.playing && !f.syncInFlight
}

// ── Orphans: only the app's own leftovers are removed ─────────────────────

/** A leftover is removed only once it has sat this long: it can't be a write in progress. */
export const TEMP_MIN_AGE_MS = 24 * 3_600_000

/**
 * The app's own temporary files, by the names the app gives them:
 *   `.<song>.tagwrite-<8 hex>.<ext>`  a tag write's copy (audio-write-guard.ts)
 *   `<anything>.tmp`                  atomic writes, `.compact.tmp`, `.rehydrate.tmp`
 * Everything else that isn't in the library (a song file nobody points at, a
 * macOS `._` file) is only counted and shown to Jake. Never deleted here.
 */
const TAGWRITE_TEMP = /^\..+\.tagwrite-[0-9a-f]{8}\.[A-Za-z0-9]+$/
const TMP_SUFFIX = /\.tmp$/i

export function isAppTempFile(name: string, mtimeMs: number, now: number): boolean {
  if (!(TAGWRITE_TEMP.test(name) || TMP_SUFFIX.test(name))) return false
  return now - mtimeMs >= TEMP_MIN_AGE_MS
}

// ── Play cache: a brake on a prune that would empty it ────────────────────

/**
 * The prune deletes cache entries no library song claims. A library read that
 * came back short would make every entry look unclaimed and empty a cache that
 * took days to build. The night holds off when it would remove more than a
 * quarter of the cache, or when the library looks too small to trust.
 */
export function pruneBrake(opts: { libraryTracks: number; entries: number; unclaimed: number }): string | null {
  if (opts.libraryTracks < 500) return `library has only ${opts.libraryTracks} songs`
  if (opts.entries >= 20 && opts.unclaimed > opts.entries / 4) return `would remove ${opts.unclaimed} of ${opts.entries}`
  return null
}

// ── Tempo and key: songs never measured ───────────────────────────────────

/** A song whose measurement failed is tried again after this long, not every night. */
export const ANALYSIS_RETRY_MS = 30 * 86_400_000

export interface AnalysisRow {
  id: number
  path?: string
  bpm?: number | string
  audioAnalysisAt?: number | string
}

/** Songs to measure tonight: never measured, or failed over a month ago. */
export function analysisCandidates(rows: readonly AnalysisRow[], now: number): AnalysisRow[] {
  return rows.filter((r) => {
    if (!r.path || typeof r.id !== 'number') return false
    const at = Number(r.audioAnalysisAt) || 0
    if (!at) return true
    if (Number(r.bpm) > 0) return false
    return now - at >= ANALYSIS_RETRY_MS
  })
}

// ── Overrides: write only what isn't on the file yet ──────────────────────

/** The tag values one entry asks for, as plain strings. */
export type WantedTags = Record<string, string | number>

function norm(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.map(norm).join('; ')
  return String(v).trim()
}

/** Fields whose value on the file isn't the wanted one. Numbers compare as numbers ("07" = 7). */
export function fieldsToWrite(onFile: Record<string, unknown>, wanted: WantedTags): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(wanted)) {
    const want = norm(v)
    const have = norm(onFile[k])
    const wn = Number(want)
    const hn = Number(have)
    if (want !== '' && have !== '' && Number.isFinite(wn) && Number.isFinite(hn) && /^\d+$/.test(want) && /^\d+$/.test(have)) {
      if (wn !== hn) out.push(k)
    } else if (want !== have) {
      out.push(k)
    }
  }
  return out
}

/** One entry's wanted values, for the ledger: the same values to the same file are written once. */
export function overrideHash(path: string, wanted: WantedTags): string {
  const keys = Object.keys(wanted).sort()
  const body = keys.map((k) => `${k}=${norm(wanted[k])}`).join('\n')
  return createHash('sha1').update(`${path}\n${body}`).digest('hex').slice(0, 16)
}

/**
 * Whether tonight writes this entry. Already written with these exact values
 * (the ledger) → no, even if a reader reports a field differently (that would
 * rewrite the file every night). Otherwise only when a field differs.
 */
export function overrideNeedsWrite(opts: { ledgerHash: string | undefined; hash: string; onFile: Record<string, unknown> | null; wanted: WantedTags }): string[] {
  if (opts.ledgerHash === opts.hash) return []
  if (!opts.onFile) return Object.keys(opts.wanted)
  return fieldsToWrite(opts.onFile, opts.wanted)
}

// ── What the check remembers ──────────────────────────────────────────────

export interface JobResult { at: number; ok: boolean; note: string }

export interface NeedsYou {
  /** Song files in the music folder that no library song points at. */
  orphanFiles: number
  orphanBytes: number
}

export interface SelfCareStatus {
  /** When the last whole check finished. */
  lastRunAt: number | null
  /** When the check now under way started (null when none is). */
  cycleStartedAt: number | null
  jobs: Partial<Record<SelfCareJob, JobResult>>
  needsYou: NeedsYou
}

export function emptyStatus(): SelfCareStatus {
  return { lastRunAt: null, cycleStartedAt: null, jobs: {}, needsYou: { orphanFiles: 0, orphanBytes: 0 } }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A file that can't be read, or reads oddly, is a fresh start: every job is idempotent. */
export function parseStatus(raw: string | null): SelfCareStatus {
  if (!raw) return emptyStatus()
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const jobs: SelfCareStatus['jobs'] = {}
    const rawJobs = (o.jobs && typeof o.jobs === 'object' ? o.jobs : {}) as Record<string, Record<string, unknown>>
    for (const j of SELF_CARE_JOBS) {
      const r = rawJobs[j]
      if (r && num(r.at) !== null) jobs[j] = { at: num(r.at)!, ok: r.ok === true, note: String(r.note ?? '') }
    }
    const ny = (o.needsYou && typeof o.needsYou === 'object' ? o.needsYou : {}) as Record<string, unknown>
    return {
      lastRunAt: num(o.lastRunAt),
      cycleStartedAt: num(o.cycleStartedAt),
      jobs,
      needsYou: { orphanFiles: num(ny.orphanFiles) ?? 0, orphanBytes: num(ny.orphanBytes) ?? 0 },
    }
  } catch {
    return emptyStatus()
  }
}

/** Jobs of the check under way that still have to run (a check stopped by music picks up where it was). */
export function jobsLeft(status: SelfCareStatus, jobs: readonly SelfCareJob[]): SelfCareJob[] {
  const started = status.cycleStartedAt
  if (started === null) return [...jobs]
  return jobs.filter((j) => !((status.jobs[j]?.at ?? -1) >= started))
}
