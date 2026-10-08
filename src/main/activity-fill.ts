/**
 * Activity set fill-to-N — requested N means N tracks that can land.
 *
 * A 1000-cap that silently boards 985 happens when unlistable / fileless
 * / vanished-id rows eat slots and nothing replaces them. Failed copies
 * must not count toward N; pull the next eligible so the user still gets
 * N when the library has more.
 */

import { ipodFirmwareWillList } from './ipod-reconcile.ts'
import { isSkitOrIntro, type WorkoutTrack } from './workout-sync.ts'

export function activityTrackCanBoard(t: {
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
}): boolean {
  if (t.audioMissing === true) return false
  const title = String(t.title || '').trim()
  const artist = String(t.artist || '').trim()
  if (!title || !artist) return false
  const path = String(t.path || '').trim()
  if (!path) return false
  if (isSkitOrIntro(t as WorkoutTrack)) return false
  return ipodFirmwareWillList({ title, artist, path, codec: t.codec })
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

export function pickReplacementTracks<T extends { id?: unknown }>(
  library: T[],
  excludeIds: Set<number>,
  needed: number,
  ineligibleIds?: Set<number>,
): T[] {
  const want = Math.max(0, Math.floor(needed))
  if (want <= 0) return []
  const out: T[] = []
  for (const t of library) {
    const id = Number(t.id)
    if (!Number.isFinite(id) || excludeIds.has(id) || ineligibleIds?.has(id)) continue
    if (!activityTrackCanBoard(t)) continue
    out.push(t)
    if (out.length >= want) break
  }
  return out
}
