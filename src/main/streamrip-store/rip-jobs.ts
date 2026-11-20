/**
 * One download job's own state in main (Brief 258, two lanes).
 *
 * The walk used to keep its cancel flag and its last staging failure in
 * module variables: fine with one job at a time, wrong with two (cancelling
 * the song would have stopped the album, and one job's rip error could have
 * explained the other's miss). Each download IPC call now runs inside its own
 * job (AsyncLocalStorage carries it through every await of the walk), and
 * the rip processes it starts are its own, so Cancel stops that job only.
 *
 * What two jobs at once share, and why that's safe:
 *  - streamrip: each rip gets its own temp folder and `--no-db`; config.toml
 *    is only written by streamrip when its app id is blank (it isn't, and
 *    `rip search` already runs beside `rip id` today).
 *  - The library: imports from the two lanes go one after the other
 *    (`importOneAtATime`), so the second sees the first's songs as already
 *    in the library instead of importing them twice.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { readdir, lstat, rm, stat } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { landedCount, type LandingFile } from '../../common/download-lanes.ts'

export interface Killable { kill: (signal?: NodeJS.Signals | number) => boolean }

export interface RipJob {
  /** The renderer's arm id for this job, when it sent one. */
  id: string | null
  canceled: boolean
  lastStageFailure: string | null
  /** An album's song count, for "7 of 12". */
  of: number | null
  /** The most songs this job has shown as landed: the count on screen never goes back. */
  shown: number
  procs: Set<Killable>
  stagingDirs: Set<string>
  progress?: (have: number, of: number, reset?: boolean) => void
}

const als = new AsyncLocalStorage<RipJob>()
const live = new Set<RipJob>()
/** Outside any job (searches, the album preflight): never canceled by a job's Cancel. */
const outside: RipJob = { id: null, canceled: false, lastStageFailure: null, of: null, shown: 0, procs: new Set(), stagingDirs: new Set() }

export function currentJob(): RipJob {
  return als.getStore() ?? outside
}

export function runInJob<T>(id: string | null | undefined, of: number | null | undefined, progress: ((have: number, of: number, reset?: boolean) => void) | undefined, fn: () => Promise<T>): Promise<T> {
  const job: RipJob = { id: typeof id === 'string' && id ? id.slice(0, 80) : null, canceled: false, lastStageFailure: null, of: typeof of === 'number' && of > 1 ? of : null, shown: 0, procs: new Set(), stagingDirs: new Set(), progress }
  live.add(job)
  return als.run(job, fn).finally(() => { live.delete(job) })
}

/** The arm ids main is running right now (a window reload re-attaches to these instead of starting them again). */
export function liveJobIds(): string[] {
  const out: string[] = []
  for (const job of live) if (job.id) out.push(job.id)
  return out
}

/** Cancel one job by its id, or every job when none is named (the old Cancel). Returns how many rips were stopped. */
export function cancelJobs(id?: string | null): number {
  let killed = 0
  for (const job of live) {
    if (id && job.id !== id) continue
    job.canceled = true
    for (const p of job.procs) { try { p.kill('SIGKILL'); killed++ } catch { /* already gone */ } }
  }
  return killed
}

/** The app is quitting: stop every rip and remove its temp folders, so nothing half-arrived is left to import. */
export function stopAllJobsNow(): void {
  for (const job of live) {
    job.canceled = true
    for (const p of job.procs) { try { p.kill('SIGKILL') } catch { /* gone */ } }
    for (const d of job.stagingDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* gone */ } }
  }
}

// ── Imports, one at a time across the lanes ─────────────────────────────
let importChain: Promise<unknown> = Promise.resolve()
export function importOneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = importChain.then(fn, fn)
  importChain = run.then(() => undefined, () => undefined)
  return run
}

// ── "7 of 12" ───────────────────────────────────────────────────────────
const AUDIO = /\.(flac|m4a|mp3|ogg|opus|wav|aiff?|alac)$/i

async function audioFiles(dir: string, out = new Map<string, LandingFile>()): Promise<Map<string, LandingFile>> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await audioFiles(p, out)
    else if (AUDIO.test(e.name)) {
      const st = await lstat(p).catch(() => null)
      out.set(p, { size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 })
    }
  }
  return out
}

/** Show a count only when it is more than the job has shown (a retry or a second candidate starts its folder from nothing). */
function reportLanded(job: RipJob, n: number): void {
  if (!job.of || !job.progress || n <= job.shown) return
  job.shown = n
  job.progress(n, job.of)
}

/**
 * While an album's rip runs, count the songs that have landed in its folder
 * and report each rise. Returns a stop; `stop(true)` (the rip ended cleanly)
 * takes one last look that counts the newest file too.
 */
export function watchLanding(dir: string, every = 2000): (final?: boolean) => void {
  const job = currentJob()
  if (!job.of || !job.progress) return () => {}
  const of = job.of
  let prev = new Map<string, LandingFile>()
  let stopped = false
  if (job.shown === 0) job.progress(0, of)
  const tick = async (): Promise<void> => {
    if (stopped) return
    const now = await audioFiles(dir)
    const n = landedCount(prev, now, 0, of)
    prev = now
    if (!stopped) reportLanded(job, n)
  }
  const t = setInterval(() => { void tick() }, every)
  t.unref?.()
  return (final = false) => {
    stopped = true
    clearInterval(t)
    if (final) void audioFiles(dir).then((now) => { if (!job.canceled) reportLanded(job, landedCount(now, now, 0, of, true)) })
  }
}

/** The walk left Qobuz for Bandcamp: its count started over, so the Qobuz one is cleared. */
export function clearLanding(): void {
  const job = currentJob()
  if (!job.of || !job.progress || job.shown === 0) return
  job.shown = 0
  job.progress(0, job.of, true)
}

// ── Staging folders left by a crash ─────────────────────────────────────
const RIP_PREFIXES = ['jaketunes-rip-', 'jaketunes-bc-']
const OTHER_PREFIXES = ['jaketunes-ripsearch-', 'jaketunes-itunesdb-']

/**
 * 6.0 Phase 4: orphaned staging dirs from a crash/kill mid-download used to
 * live in tmpdir forever. At boot no rip can be running yet, so every
 * download folder (rip-, bc-) left in tmpdir is a corpse and goes at once,
 * whatever its age (Brief 258: a quit mid-album must not leave a gigabyte
 * behind for an hour). A folder a live job owns is never touched. The
 * other prefixes, and any later sweep, keep the one-hour gate.
 */
export async function sweepOrphanedStaging(opts: { atBoot: boolean; dir?: string; now?: number }): Promise<number> {
  const dir = opts.dir ?? tmpdir()
  const now = opts.now ?? Date.now()
  const owned = (p: string): boolean => { for (const job of live) if (job.stagingDirs.has(p)) return true; return false }
  let swept = 0
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const rip = RIP_PREFIXES.some((p) => e.name.startsWith(p))
      if (!rip && !OTHER_PREFIXES.some((p) => e.name.startsWith(p))) continue
      const p = join(dir, e.name)
      try {
        if (!(opts.atBoot && rip)) {
          const st = await stat(p)
          if (now - st.mtimeMs < 3600_000) continue   // possibly live
        }
        if (owned(p)) continue
        await rm(p, { recursive: true, force: true })
        swept++
      } catch { /* raced with its owner — leave it */ }
    }
  } catch { /* tmpdir unreadable — nothing to do */ }
  return swept
}
