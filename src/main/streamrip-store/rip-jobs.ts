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
import { readdir, lstat } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { landedCount } from '../../common/download-lanes.ts'

export interface Killable { kill: (signal?: NodeJS.Signals | number) => boolean }

export interface RipJob {
  /** The renderer's arm id for this job, when it sent one. */
  id: string | null
  canceled: boolean
  lastStageFailure: string | null
  /** An album's song count, for "7 of 12". */
  of: number | null
  procs: Set<Killable>
  stagingDirs: Set<string>
  progress?: (have: number, of: number) => void
}

const als = new AsyncLocalStorage<RipJob>()
const live = new Set<RipJob>()
/** Outside any job (searches, the album preflight): never canceled by a job's Cancel. */
const outside: RipJob = { id: null, canceled: false, lastStageFailure: null, of: null, procs: new Set(), stagingDirs: new Set() }

export function currentJob(): RipJob {
  return als.getStore() ?? outside
}

export function runInJob<T>(id: string | null | undefined, of: number | null | undefined, progress: ((have: number, of: number) => void) | undefined, fn: () => Promise<T>): Promise<T> {
  const job: RipJob = { id: typeof id === 'string' && id ? id.slice(0, 80) : null, canceled: false, lastStageFailure: null, of: typeof of === 'number' && of > 1 ? of : null, procs: new Set(), stagingDirs: new Set(), progress }
  live.add(job)
  return als.run(job, fn).finally(() => { live.delete(job) })
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

async function audioSizes(dir: string, out = new Map<string, number>()): Promise<Map<string, number>> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await audioSizes(p, out)
    else if (AUDIO.test(e.name)) out.set(p, (await lstat(p).catch(() => null))?.size ?? 0)
  }
  return out
}

/** While an album's rip runs, count the songs that have landed in its folder and report each change. Returns a stop. */
export function watchLanding(dir: string, every = 2000): () => void {
  const job = currentJob()
  if (!job.of || !job.progress) return () => {}
  const of = job.of
  const report = job.progress
  let prev = new Map<string, number>()
  let last = 0
  let stopped = false
  report(0, of)
  const tick = async (): Promise<void> => {
    if (stopped) return
    const now = await audioSizes(dir)
    const n = landedCount(prev, now, last, of)
    prev = now
    if (n !== last && !stopped) { last = n; report(n, of) }
  }
  const t = setInterval(() => { void tick() }, every)
  t.unref?.()
  return () => { stopped = true; clearInterval(t) }
}
