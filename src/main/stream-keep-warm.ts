/**
 * Keep homemini's playable copy warm for the streamed songs Jake is likely to
 * tap (2026-11-12, review of PR 409).
 *
 * "Ready when dropped" doesn't last. Two days after Transistor's copies were
 * built they were gone: homemini's free disk fell from 57 GB to 32 GB, its
 * cache may not take the disk under 30 GB free, and so the cache shrank from
 * 9 GB to 2.7 GB. A tap was then the first ask again.
 *
 * So every offload pass asks homemini to have ready (`want`, flac-variant.ts)
 * the streamed songs that:
 *   • the player asked for in the last 6 hours (playing, or loaded ahead as
 *     next: the nearest thing to the queue the main process can see), then
 *   • were played in the last 7 days, newest first.
 * At most WARM_MAX songs. Asking also marks a ready copy as just used, so it
 * is the last one homemini lets go.
 *
 * It asks; it can't make room. When homemini answers no-room, the copy isn't
 * there and the tap falls back to decoding here (stream-alac-serve.ts).
 *
 * Pure; every effect is injected (__tests__/stream-keep-warm.test.ts).
 */
import { whenMs } from './offload-keep-recent.ts'

export const WARM_MAX = 150
export const WARM_PLAYED_DAYS = 7
const DAY = 24 * 60 * 60 * 1000

export interface WarmTrack { id?: unknown; path?: unknown; lastPlayedAt?: unknown }

/** Colon paths worth keeping warm, most likely first, before "is it streamed?" is asked. */
export function warmCandidates(tracks: ReadonlyArray<WarmTrack>, touched: readonly string[], now: number): string[] {
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
  for (const p of [...touched.filter((x) => known.has(x)), ...played.map((x) => x.path)]) {
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/**
 * Ask homemini to keep those songs' copies ready. Only songs that are links
 * on this Mac and that it can only play from a converted copy. Returns the ids
 * asked for; a failed ask is nothing.
 */
export async function keepStreamedWarm(opts: {
  tracks: ReadonlyArray<WarmTrack>
  touched: readonly string[]
  now: number
  /** The song is a link to homemini on this Mac. */
  isStreamed: (colonPath: string) => Promise<boolean>
  /** This Mac plays it from homemini's converted copy (ALAC). */
  needsCopy: (colonPath: string) => boolean
  want: (ids: Array<string | number>) => Promise<unknown>
  max?: number
}): Promise<Array<string | number>> {
  const idByPath = new Map<string, string | number>()
  for (const t of opts.tracks) if (typeof t?.path === 'string' && t.id != null && t.id !== '') idByPath.set(t.path, t.id as string | number)
  const ids: Array<string | number> = []
  for (const p of warmCandidates(opts.tracks, opts.touched, opts.now)) {
    if (ids.length >= (opts.max ?? WARM_MAX)) break
    if (!opts.needsCopy(p)) continue
    if (!(await opts.isStreamed(p).catch(() => false))) continue
    ids.push(idByPath.get(p) as string | number)
  }
  if (ids.length) await opts.want(ids).catch(() => undefined)
  return ids
}
