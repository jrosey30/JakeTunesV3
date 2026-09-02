/**
 * iPod Pool store — the hand-built Activity Sync set (Jake, 2026-09-02).
 *
 * Same module-store pattern as mixtapes.ts: a cached id list the sidebar
 * badge and the pool view subscribe to, refreshed through IPC. The main
 * process owns the file (activity-pool.json) and the merge rules (dedupe,
 * skit skip, hard cap) — this side only reports what happened, loudly.
 */
import type { Track } from './types'
import { setNotice } from './activity'

let ids: number[] = []
let max = 1000
/** Set by the pool view's "Sync this pool" button so the Activity sheet
 *  opens on the pool the next time it is shown (DeviceView is untouched). */
let pendingPoolMode = false
const listeners = new Set<() => void>()

function notify(): void { for (const l of listeners) l() }

export function getPoolIds(): number[] { return ids }
export function getPoolMax(): number { return max }
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
    .map((t) => ({ id: t.id, title: t.title, duration: t.duration, genre: t.genre, playCount: t.playCount, rating: t.rating }))
  if (candidates.length === 0) return
  const r = await window.electronAPI.addToActivityPool?.(candidates)
  if (!r?.ok) {
    setNotice(`Couldn't add to the pool — ${r?.error || 'no reply from the app'}`, { kind: 'error', durationMs: 5000 })
    return
  }
  if (Array.isArray(r.ids)) { ids = r.ids; notify() }
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

export async function removeFromPool(remove: number[]): Promise<void> {
  const r = await window.electronAPI.removeFromActivityPool?.(remove)
  if (r?.ok && Array.isArray(r.ids)) { ids = r.ids; notify() }
}

export async function clearPool(): Promise<void> {
  const r = await window.electronAPI.clearActivityPool?.()
  if (r?.ok) { ids = []; notify() }
}
