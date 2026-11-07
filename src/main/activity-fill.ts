/**
 * Activity set fill-to-N — requested N means N tracks that can land.
 *
 * A 1000-cap that silently boards 985 happens when unlistable / fileless
 * / vanished-id rows eat slots and nothing replaces them. Failed copies
 * must not count toward N; pull the next eligible so the user still gets
 * N when the library has more.
 *
 * A list-only iPod (every iPod but the Original, 2026-11-07) is the
 * exception: its set is exactly its own list. Nothing from the library
 * ever fills it, so a song that cannot go on is LEFT OFF and named
 * (planListOnlyBoarding), and the set lands that many fewer.
 */

import { ipodCanCarryAfterConversion, ipodPathExtension } from './ipod-reconcile.ts'
import { isSkitOrIntro, type WorkoutTrack } from './workout-sync.ts'

type BoardRow = {
  id?: unknown
  title?: unknown
  artist?: unknown
  path?: unknown
  codec?: unknown
  audioMissing?: unknown
  duration?: unknown
  genre?: unknown
  playCount?: unknown
  rating?: unknown
}

/** Why this row can't go on the iPod, in plain words; null when it can. */
export function whyActivityTrackCannotBoard(t: BoardRow): string | null {
  if (t.audioMissing === true) return 'its audio file is missing everywhere'
  const title = String(t.title || '').trim()
  const artist = String(t.artist || '').trim()
  if (!title || !artist) return 'it has no title or no artist'
  const path = String(t.path || '').trim()
  if (!path) return 'it has no audio file in the library'
  if (isSkitOrIntro(t as WorkoutTrack)) return 'it reads as a skit, intro or segue, not a song'
  // The SOURCE question: a .flac is converted to ALAC at copy time.
  if (!ipodCanCarryAfterConversion({ title, artist, path, codec: t.codec })) {
    const ext = ipodPathExtension(path) || 'no extension'
    return `the iPod can't play its file type (${ext})`
  }
  return null
}

export function activityTrackCanBoard(t: BoardRow): boolean {
  return whyActivityTrackCannotBoard(t) === null
}

export interface LeftOffSong { id: number; title: string; artist: string; why: string }

export function leftOffSong(t: { id?: unknown; title?: unknown; artist?: unknown }, why: string): LeftOffSong {
  return { id: Number(t.id), title: String(t.title || ''), artist: String(t.artist || ''), why }
}

/**
 * A list-only set: its own songs in list order, never anything else.
 * What can't go on is left off with the reason; the set is then that many
 * fewer (target = what boarded, never more than requested).
 */
export function planListOnlyBoarding<T extends BoardRow>(
  primary: T[],
  requested: number,
  idOf: (t: T) => number = (t) => Number(t.id),
): { pool: T[]; target: number; leftOff: LeftOffSong[] } {
  const want = Math.max(0, Math.floor(requested))
  const pool: T[] = []
  const leftOff: LeftOffSong[] = []
  const seen = new Set<number>()
  for (const t of primary) {
    if (pool.length >= want) break
    const id = idOf(t)
    if (!Number.isFinite(id) || seen.has(id)) continue
    seen.add(id)
    const why = whyActivityTrackCannotBoard(t)
    if (why) { leftOff.push(leftOffSong(t, why)); continue }
    pool.push(t)
  }
  return { pool, target: pool.length, leftOff }
}

export function queueActivityCandidates<T>(opts: {
  requested: number
  primary: T[]
  reserve?: T[]
  extra?: T[]
  canBoard?: (t: T) => boolean
  idOf?: (t: T) => number
}): { queue: T[]; shortfall: number } {
  const requested = Math.max(0, Math.floor(opts.requested))
  const canBoard = opts.canBoard || activityTrackCanBoard as (t: T) => boolean
  const idOf = opts.idOf || ((t: T) => Number((t as { id?: unknown }).id))
  const seen = new Set<number>()
  const queue: T[] = []
  for (const t of [...opts.primary, ...(opts.reserve || []), ...(opts.extra || [])]) {
    const id = idOf(t)
    if (!Number.isFinite(id) || seen.has(id)) continue
    if (!canBoard(t)) continue
    seen.add(id)
    queue.push(t)
  }
  return { queue, shortfall: Math.max(0, requested - queue.length) }
}

/** Map picked ids back to library rows; fill holes from reserve so N stays N. */
export function resolvePickedTracks<T extends { id: number }>(
  ids: Array<number | string>,
  byId: Map<number, T>,
  reserveIds: Array<number | string>,
  requested: number,
): { tracks: T[]; shortfall: number; replaced: number } {
  const want = Math.max(0, Math.floor(requested))
  const out: T[] = []
  const seen = new Set<number>()
  let replaced = 0
  const take = (raw: number | string, fromReserve: boolean) => {
    if (out.length >= want) return
    const id = Number(raw)
    if (!Number.isFinite(id) || seen.has(id)) return
    const t = byId.get(id)
    if (!t) return
    seen.add(id)
    out.push(t)
    if (fromReserve) replaced++
  }
  for (const id of ids) take(id, false)
  const primaryLanded = out.length
  for (const id of reserveIds) take(id, true)
  if (out.length > primaryLanded) replaced = out.length - primaryLanded
  return { tracks: out, shortfall: Math.max(0, want - out.length), replaced }
}

/**
 * The Original's LAST resort, after the picker's reserve: songs from the
 * whole library. Most-loved first — starred (rating), then most played,
 * then most recently played / added — never library order. Library order
 * is id order, so this used to hand out ids 0, 1, 2, … (Lou Reed, Magdalena
 * Bay, Parallelle) to every set that came up short.
 */
export function pickReplacementTracks<T extends { id?: unknown }>(
  library: T[],
  excludeIds: Set<number>,
  needed: number,
  ineligibleIds?: Set<number>,
): T[] {
  const want = Math.max(0, Math.floor(needed))
  if (want <= 0) return []
  const candidates: T[] = []
  for (const t of library) {
    const id = Number(t.id)
    if (!Number.isFinite(id) || excludeIds.has(id) || ineligibleIds?.has(id)) continue
    if (!activityTrackCanBoard(t)) continue
    candidates.push(t)
  }
  const num = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const when = (v: unknown): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    const ms = Date.parse(String(v ?? ''))
    return Number.isFinite(ms) ? ms : 0
  }
  const row = (t: T) => t as T & { rating?: unknown; playCount?: unknown; lastPlayedAt?: unknown; dateAdded?: unknown }
  candidates.sort((a, b) =>
    num(row(b).rating) - num(row(a).rating)
    || num(row(b).playCount) - num(row(a).playCount)
    || when(row(b).lastPlayedAt) - when(row(a).lastPlayedAt)
    || when(row(b).dateAdded) - when(row(a).dateAdded)
    || num(b.id) - num(a.id))
  return candidates.slice(0, want)
}
