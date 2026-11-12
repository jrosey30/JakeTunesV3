/**
 * Keep homemini's playable copy warm for the streamed songs Jake is likely to
 * tap (2026-11-12, reviews of PR 409).
 *
 * "Ready when dropped" doesn't last. Two days after Transistor's copies were
 * built they were gone: homemini's free disk fell from 57 GB to 32 GB, its
 * cache may not take the disk under 30 GB free, and so the cache shrank from
 * 9 GB to 2.7 GB. A tap was then the first ask again.
 *
 * The first version asked homemini to BUILD every wanted copy every 90 s.
 * Where 76 of 150 fit, homemini built one, let go of another of the same 150,
 * and built that one again next pass: 172 GB written an hour on the reviewer's
 * simulation. So this must not be able to make homemini churn, whatever
 * homemini does:
 *
 *   • It ASKS first, without building (GET). Only what is absent can be built.
 *   • A build is requested for one song at most once per BUILD_AGAIN_MS,
 *     unless the song was played or loaded since the last request.
 *   • At most BUILDS_PER_PASS a pass, most likely first: what the player asked
 *     for in the last 6 hours (playing, or loaded ahead as next: the nearest
 *     thing to the queue the main process can see), then what was played in
 *     the last 7 days, newest first.
 *   • One `no-room` from homemini and nothing more is requested for
 *     NO_ROOM_REST_MS: it has said what fits.
 *   • A ready copy is marked as in use on homemini at most once per
 *     TOUCH_AGAIN_MS, so homemini doesn't let it go for another wanted one.
 * homemini has the matching rule (JakeTunesMobile #775): a background build
 * never pushes out a copy asked for in the last 6 hours.
 *
 * It asks; it can't make room. When homemini has no room the copy isn't there
 * and the tap falls back to decoding here (stream-alac-serve.ts).
 *
 * Electron-free; every effect is injected (__tests__/stream-keep-warm.test.ts).
 */
import { whenMs } from './offload-keep-recent.ts'
import type { VariantState } from './flac-variant.ts'

export const WARM_MAX = 150
export const WARM_PLAYED_DAYS = 7
export const BUILDS_PER_PASS = 8
export const BUILD_AGAIN_MS = 6 * 60 * 60 * 1000
export const TOUCH_AGAIN_MS = 2 * 60 * 60 * 1000
export const NO_ROOM_REST_MS = 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

export interface WarmTrack { id?: unknown; path?: unknown; lastPlayedAt?: unknown }
type States = Map<string, VariantState | null>

/** Colon paths worth keeping warm, most likely first, before "is it streamed?" is asked. */
export function warmCandidates(tracks: ReadonlyArray<WarmTrack>, touched: ReadonlyArray<{ path: string; at: number }>, now: number): string[] {
  const known = new Set<string>()
  const played: Array<{ path: string; at: number }> = []
  for (const t of tracks) {
    const p = typeof t?.path === 'string' ? t.path : ''
    if (!p || t.id == null || t.id === '') continue
    known.add(p)
    const at = whenMs(t.lastPlayedAt)
    if (at != null && now - at < WARM_PLAYED_DAYS * DAY) played.push({ path: p, at })
  }
  played.sort((a, b) => b.at - a.at)
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of [...touched.map((x) => x.path).filter((x) => known.has(x)), ...played.map((x) => x.path)]) {
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

export interface WarmPassResult {
  /** The songs asked about (no build). */
  asked: string[]
  /** The songs a build was requested for this pass. */
  built: string[]
  /** The ready copies marked as in use this pass. */
  touched: string[]
  noRoom: boolean
}

export interface WarmKeeper {
  pass(opts: {
    tracks: ReadonlyArray<WarmTrack>
    /** What the player asked for lately, and when (offload-keep-recent.ts PlayerTouches.recent). */
    touched: ReadonlyArray<{ path: string; at: number }>
    now: number
    /** The song is a link to homemini on this Mac. */
    isStreamed: (colonPath: string) => Promise<boolean>
    /** This Mac plays it from homemini's converted copy (ALAC). */
    needsCopy: (colonPath: string) => boolean
  }): Promise<WarmPassResult>
}

export function createWarmKeeper(deps: {
  /** The state of each copy. Never builds. null = no answer. */
  ask: (ids: string[]) => Promise<States | null>
  /** Build the absent ones and mark the ready ones as in use. null = no answer. */
  want: (ids: string[]) => Promise<States | null>
  max?: number
}): WarmKeeper {
  const requestedAt = new Map<string, number>()
  const touchedAt = new Map<string, number>()
  let restUntil = 0
  let running = false

  return {
    async pass(opts) {
      const out: WarmPassResult = { asked: [], built: [], touched: [], noRoom: false }
      if (running) return out
      running = true
      try {
        const lastUse = new Map<string, number>()   // id → when it was last played or loaded
        const idByPath = new Map<string, string>()
        for (const t of opts.tracks) {
          if (typeof t?.path !== 'string' || t.id == null || t.id === '') continue
          idByPath.set(t.path, String(t.id))
          const at = whenMs(t.lastPlayedAt)
          if (at != null) lastUse.set(String(t.id), at)
        }
        const loadedAt = new Map(opts.touched.map((x) => [x.path, x.at]))
        for (const p of warmCandidates(opts.tracks, opts.touched, opts.now)) {
          if (out.asked.length >= (deps.max ?? WARM_MAX)) break
          if (!opts.needsCopy(p)) continue
          if (!(await opts.isStreamed(p).catch(() => false))) continue
          const id = idByPath.get(p) as string
          // The time the player really asked for it: a song loaded once is one reason, not a new one every pass.
          const at = loadedAt.get(p)
          if (at != null && at > (lastUse.get(id) ?? -Infinity)) lastUse.set(id, at)
          out.asked.push(id)
        }
        if (!out.asked.length) return out
        const states = await deps.ask(out.asked).catch(() => null)
        if (!states) return out

        // Ready copies: say they are in use, seldom.
        const touch = out.asked.filter((id) => states.get(id) === 'ready' && opts.now - (touchedAt.get(id) ?? -Infinity) >= TOUCH_AGAIN_MS)
        // Absent copies: one request per song per BUILD_AGAIN_MS, unless it was used since the last one.
        const build: string[] = []
        if (opts.now >= restUntil) {
          for (const id of out.asked) {
            if (build.length >= BUILDS_PER_PASS) break
            if (states.get(id) !== 'absent') continue
            const last = requestedAt.get(id)
            if (last != null && opts.now - last < BUILD_AGAIN_MS && !((lastUse.get(id) ?? -Infinity) > last)) continue
            build.push(id)
          }
        }
        if (states.size && [...states.values()].includes('no-room')) out.noRoom = true
        if (!touch.length && !build.length) return out
        const reply = await deps.want([...build, ...touch]).catch(() => null)
        if (!reply) return out   // not known to have been asked: nothing is remembered
        for (const id of touch) { touchedAt.set(id, opts.now); out.touched.push(id) }
        for (const id of build) { requestedAt.set(id, opts.now); out.built.push(id) }
        if ([...reply.values()].includes('no-room')) out.noRoom = true
        // homemini said what fits: nothing more is requested for a while.
        if (out.noRoom) restUntil = opts.now + NO_ROOM_REST_MS
        return out
      } finally {
        running = false
      }
    },
  }
}
