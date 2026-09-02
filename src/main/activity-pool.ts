/**
 * Activity Sync POOL — the hand-built alternative to the brain's picks
 * (Jake, 2026-09-02: "instead of AI brain determining which songs to add
 * in the pool... the user can drag and drop anything from full playlists,
 * artist discographies, albums or individual songs into a pool").
 *
 * Pure merge rules, Electron-free so node --test loads it. Persistence and
 * IPC live in ipc/activity-pool-ipc.ts.
 *
 * Rules (agreed 9/2):
 *   • dedupe by id — dropping an album twice never double-counts
 *   • skits/intros/sub-minute fragments are skipped ON DROP, and the count
 *     is reported so the skip is visible, never silent
 *   • the pool is capped at POOL_MAX (the device's largest set) — overflow
 *     is REFUSED and reported; the machine never trims a hand-built list
 *   • drop order is kept — the pool syncs in the order it was built
 */

export const POOL_MAX = 1000

export interface PoolCandidate {
  id: number
  title?: string
  duration?: number
  genre?: string
  playCount?: number
  rating?: number
}

export interface PoolMergeResult {
  ids: number[]
  added: number
  dupes: number
  skits: number
  /** Candidates refused because the pool was full. */
  overflow: number
}

export function mergeIntoPool(
  existing: number[],
  incoming: PoolCandidate[],
  isSkit: (c: PoolCandidate) => boolean,
  max: number = POOL_MAX,
): PoolMergeResult {
  const ids = [...existing]
  const seen = new Set(ids)
  let added = 0
  let dupes = 0
  let skits = 0
  let overflow = 0
  for (const c of incoming) {
    const id = Number(c?.id)
    if (!Number.isFinite(id)) continue
    if (seen.has(id)) { dupes++; continue }
    if (isSkit(c)) { skits++; continue }
    if (ids.length >= max) { overflow++; continue }
    ids.push(id)
    seen.add(id)
    added++
  }
  return { ids, added, dupes, skits, overflow }
}

export function removeFromPool(existing: number[], remove: number[]): number[] {
  const gone = new Set(remove.map(Number))
  return existing.filter((id) => !gone.has(id))
}
