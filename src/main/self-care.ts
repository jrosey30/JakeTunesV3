/**
 * The nightly check's runner (rules: self-care-core.ts).
 *
 * Every ten minutes it asks whether the check may run (no music, none for ten
 * minutes, no sync, the night or two days overdue, not already done today).
 * Then it runs the jobs one at a time, asking again before each one and
 * handing each job the same question for its own steps: the moment music or a
 * sync starts, it stops, and the next quiet look picks up with the jobs left.
 *
 * Background priority: a job that starts a program starts it through
 * `atBackgroundPriority` (background-priority.ts); the jobs that stay in this
 * process are file reads and small writes that yield between steps. Every
 * start, stop and job result is logged as `[self-care]`.
 *
 * Electron-free: everything is injected; src/main/__tests__/self-care.test.ts
 * drives it on a fake clock.
 */
import {
  jobsFor, jobsLeft, parseStatus, selfCareGate, stillQuiet, LOOK_EVERY_MS, MUSIC_FOLDER_JOBS,
  type NeedsYou, type SelfCareJob, type SelfCareStatus,
} from './self-care-core.ts'

export interface JobContext {
  /** False once music or a sync has started: stop at the next safe point. */
  stillQuiet: () => boolean
}

export interface JobOutcome {
  ok: boolean
  /** One plain line for the log. */
  note: string
  /** A job that counts something Jake decides about. */
  needsYou?: Partial<NeedsYou>
  /** The job stopped early because music started; it runs again next time. */
  interrupted?: boolean
}

export type JobRunner = (ctx: JobContext) => Promise<JobOutcome>

export interface SelfCareHost {
  now: () => number
  hour: () => number
  playing: () => boolean
  lastMusicAt: () => number
  syncInFlight: () => boolean
  isReplica: () => Promise<boolean>
  /** Why this machine may not write or delete under its music folder; null when it may (localAudioDropRefused). */
  musicFolderRefused: () => Promise<string | null>
  readStatus: () => Promise<string | null>
  writeStatus: (s: SelfCareStatus) => Promise<void>
  jobs: Record<SelfCareJob, JobRunner>
  log: (line: string) => void
}

export type TickOutcome = 'busy' | 'held' | 'interrupted' | 'done'

export interface SelfCare {
  tick: () => Promise<TickOutcome>
  status: () => Promise<SelfCareStatus>
}

export function createSelfCare(host: SelfCareHost): SelfCare {
  let running = false
  let lastHeldWhy = ''
  const quiet = (): boolean => stillQuiet({ playing: host.playing(), syncInFlight: host.syncInFlight() })

  async function tick(): Promise<TickOutcome> {
    if (running) return 'busy'
    running = true
    try {
      const status = parseStatus(await host.readStatus())
      const gate = selfCareGate({
        now: host.now(), hour: host.hour(), lastRunAt: status.lastRunAt,
        playing: host.playing(), lastMusicAt: host.lastMusicAt(), syncInFlight: host.syncInFlight(),
      })
      if (!gate.run) {
        if (gate.why !== lastHeldWhy && gate.why !== 'not-due' && gate.why !== 'outside-window') host.log(`[self-care] waiting: ${gate.why}`)
        lastHeldWhy = gate.why
        return 'held'
      }
      lastHeldWhy = ''
      const all = jobsFor(await host.isReplica())
      if (status.cycleStartedAt === null) status.cycleStartedAt = host.now()
      const left = jobsLeft(status, all)
      host.log(`[self-care] start: ${left.join(', ')}`)
      for (const job of left) {
        if (!quiet()) {
          host.log(`[self-care] stopped before ${job}: music or a sync started`)
          await host.writeStatus(status)
          return 'interrupted'
        }
        const t0 = host.now()
        let out: JobOutcome
        // The runner's rule, never left to a job: nothing writes or deletes
        // under the music folder on homemini or on a folder off this Mac's disk.
        const refused = MUSIC_FOLDER_JOBS.has(job) ? await host.musicFolderRefused() : null
        if (refused) {
          out = { ok: true, note: `skipped, the music folder is not this Mac's to change: ${refused}` }
        } else try {
          out = await host.jobs[job]({ stillQuiet: quiet })
        } catch (err) {
          out = { ok: false, note: err instanceof Error ? err.message : String(err) }
        }
        if (out.needsYou) status.needsYou = { ...status.needsYou, ...out.needsYou }
        if (out.interrupted) {
          host.log(`[self-care] ${job} stopped: music or a sync started`)
          await host.writeStatus(status)
          return 'interrupted'
        }
        status.jobs[job] = { at: host.now(), ok: out.ok, note: out.note }
        host.log(`[self-care] ${job} ${out.ok ? 'ok' : 'failed'} (${Math.round((host.now() - t0) / 1000)} s): ${out.note}`)
        await host.writeStatus(status)
      }
      status.lastRunAt = host.now()
      status.cycleStartedAt = null
      await host.writeStatus(status)
      host.log('[self-care] done')
      return 'done'
    } finally {
      running = false
    }
  }

  return { tick, status: async () => parseStatus(await host.readStatus()) }
}

/** Looks every ten minutes for the life of the app. The timer never keeps the app alive. */
export function startSelfCare(host: SelfCareHost, everyMs = LOOK_EVERY_MS): SelfCare & { stop: () => void } {
  const care = createSelfCare(host)
  const look = (): void => {
    care.tick().catch((err) => host.log(`[self-care] look failed: ${err instanceof Error ? err.message : String(err)}`))
  }
  const timer = setInterval(look, everyMs)
  timer.unref?.()
  return { ...care, stop: () => clearInterval(timer) }
}
