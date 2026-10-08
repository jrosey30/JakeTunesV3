/**
 * iPod Pool store — the hand-built Activity Sync set (Jake, 2026-09-02).
 *
 * Same module-store pattern as mixtapes.ts: a cached id list the sidebar
 * badge and the pool view subscribe to, refreshed through IPC. The main
 * process owns the file (activity-pool.json) and the merge rules (dedupe,
 * skit skip, hard cap) — this side only reports what happened, loudly.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { Track } from './types'
import { setNotice } from './activity'
import { poolHealth, type PoolHealth, type PoolName } from '../common/pool-health'
import { subscribeLiveSets, getLiveSetsSnapshot, libraryHiddenTrackIds } from './liveSets'

let ids: number[] = []
let names: Record<string, PoolName> = {}
let max = 1000
/** Set by the pool view's "Sync this pool" button so the Activity sheet
 *  opens on the pool the next time it is shown (DeviceView is untouched). */
let pendingPoolMode = false
const listeners = new Set<() => void>()

function notify(): void { for (const l of listeners) l() }

export function getPoolIds(): number[] { return ids }
export function getPoolNames(): Record<string, PoolName> { return names }
export function getPoolMax(): number { return max }

/**
 * The one count every surface shows (2026-09-19). The sidebar badge, the
 * pool page, the Activity sheet and the Device page's pool button all
 * counted `ids.length`; the sync boarded fewer and said nothing. This is
 * the sync's own rule applied up front: what is in the library, not a
 * concert cue, and syncable — plus what isn't, by name, so it can be fixed.
 */
export function usePoolHealth(tracks: Track[]): PoolHealth {
  const poolIds = useSyncExternalStore(subscribePool, getPoolIds)
  const poolNames = useSyncExternalStore(subscribePool, getPoolNames)
  const live = useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  return useMemo(() => {
    const byId = new Map(tracks.map((t) => [t.id, t]))
    // Same rule as main's getConcertOwnedTrackIds: the merged track and
    // every cue not promoted back into the library.
    const concert = live.loaded ? libraryHiddenTrackIds(new Set(tracks.map((t) => t.id))) : new Set<number>()
    return poolHealth(poolIds, poolNames, byId, concert)
  }, [poolIds, poolNames, tracks, live])
}
export function subscribePool(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function requestPoolMode(): void { pendingPoolMode = true }
/** One-shot read: true exactly once after requestPoolMode(). */
export function consumePoolModeRequest(): boolean {
  const v = pendingPoolMode
  pendingPoolMode = false
  return v
}

export async function refreshPool(): Promise<number[]> {
  try {
    const r = await window.electronAPI.getActivityPool?.()
    if (r?.ok && Array.isArray(r.ids)) {
      ids = r.ids
      if (r.names && typeof r.names === 'object') names = r.names
      if (typeof r.max === 'number') max = r.max
      notify()
    }
  } catch { /* main not ready yet — badge shows the last known count */ }
  return ids
}

/** Drop handler: resolve dragged ids to tracks (the skit gate needs
 *  title/duration/genre) and report the outcome in one notice. */
export async function addTracksToPool(dropped: number[], byId: Map<number, Track>): Promise<void> {
  const candidates = dropped
    .map((id) => byId.get(id))
    .filter((t): t is Track => !!t)
    .map((t) => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, genre: t.genre, playCount: t.playCount, rating: t.rating }))
  if (candidates.length === 0) return
  const r = await window.electronAPI.addToActivityPool?.(candidates)
  if (!r?.ok) {
    setNotice(`Couldn't add to the pool — ${r?.error || 'no reply from the app'}`, { kind: 'error', durationMs: 5000 })
    return
  }
  if (Array.isArray(r.ids)) { ids = r.ids; if (r.names) names = r.names; notify() }
  const parts: string[] = []
  parts.push(`${r.added ?? 0} added`)
  if (r.dupes) parts.push(`${r.dupes} already in the pool`)
  if (r.skits) parts.push(`${r.skits} skit${r.skits === 1 ? '' : 's'}/intro${r.skits === 1 ? '' : 's'} skipped`)
  if (r.overflow) parts.push(`${r.overflow} refused — pool is full at ${r.max ?? max}`)
  setNotice(`iPod Pool: ${parts.join(' · ')} (${ids.length} / ${r.max ?? max})`, {
    kind: r.overflow ? 'error' : 'success',
    durationMs: r.overflow || r.skits ? 6000 : 3500,
  })
}

/** Context-menu path: the caller already holds the Track objects. */
export function addTracksToPoolDirect(tracks: Track[]): Promise<void> {
  return addTracksToPool(tracks.map((t) => t.id), new Map(tracks.map((t) => [t.id, t])))
}

export async function removeFromPool(remove: number[]): Promise<void> {
  const r = await window.electronAPI.removeFromActivityPool?.(remove)
  if (r?.ok && Array.isArray(r.ids)) { ids = r.ids; notify() }
}

export async function clearPool(): Promise<void> {
  const r = await window.electronAPI.clearActivityPool?.()
  if (r?.ok) { ids = []; names = {}; notify() }
}

/** "Use the new copy": replace a dead id with the re-added track, in place. */
export async function swapInPool(oldId: number, replacement: Track): Promise<void> {
  const r = await window.electronAPI.swapInActivityPool?.({ oldId, newId: replacement.id, name: { t: replacement.title || '', a: replacement.artist || '' } })
  if (r?.ok && Array.isArray(r.ids)) { ids = r.ids; if (r.names) names = r.names; notify(); return }
  setNotice(`Couldn't swap that song — ${r?.error || 'no reply from the app'}`, { kind: 'error', durationMs: 5000 })
}
