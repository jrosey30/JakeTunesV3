/**
 * Activity Sync POOL — the hand-built alternative to the brain's picks
 * (Jake, 2026-09-02: "instead of AI brain determining which songs to add
 * in the pool... the user can drag and drop anything from full playlists,
 * artist discographies, albums or individual songs into a pool").
 *
 * Pure merge rules, Electron-free so node --test loads it. Persistence and
 * IPC live in ipc/activity-pool-ipc.ts.
 *
 * Rules (agreed 9/2; the cap rule changed 2026-10-17, Jake-approved):
 *   • dedupe by id — dropping an album twice never double-counts
 *   • skits/intros/sub-minute fragments are skipped ON DROP, and the count
 *     is reported so the skip is visible, never silent
 *   • the pool holds POOL_MAX (the device's largest set). A drop that would
 *     go past it ROLLS OFF the OLDEST drops (front of the list) to make
 *     room, and the count is reported ("20 oldest drops rolled off"). This
 *     replaces the 9/2 "refuse overflow" rule: every sync is half and half
 *     now (common/activity-split.ts) and only the NEWEST drops ride, so the
 *     oldest drops were already the ones sitting syncs out.
 *   • a song re-dropped in the same batch is never the one rolled off —
 *     dropping it again must not be what makes it vanish
 *   • only when ONE drop is bigger than the pool itself does part of that
 *     drop not fit (its earliest songs, same oldest-first rule) — reported
 *     as `overflow`
 *   • drop order is kept — the pool syncs in the order it was built
 *   • no pinned lists, no locked albums (Jake, 2026-10-25: "strip the locks
 *     and pins from the ipod pool too") — the Original is the Top 1000 plus
 *     these drops, nothing rides along unasked
 */

export const POOL_MAX = 1000

export interface PoolCandidate {
  id: number
  title?: string
  artist?: string
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
  /** Oldest pooled ids removed to make room for this drop. */
  rolledOff: number
  rolledOffIds: number[]
  /** New songs from THIS drop that did not fit — only when the drop alone
   *  is bigger than the pool. */
  overflow: number
}

export function mergeIntoPool(
  existing: number[],
  incoming: PoolCandidate[],
  isSkit: (c: PoolCandidate) => boolean,
  max: number = POOL_MAX,
): PoolMergeResult {
  const cap = Math.max(0, Math.floor(max))
  const pooled = new Set(existing)
  const seen = new Set(existing)
  const redropped = new Set<number>()
  let fresh: number[] = []
  let dupes = 0
  let skits = 0
  for (const c of incoming) {
    const id = Number(c?.id)
    if (!Number.isFinite(id)) continue
    if (seen.has(id)) {
      dupes++
      if (pooled.has(id)) redropped.add(id)
      continue
    }
    if (isSkit(c)) { skits++; continue }
    fresh.push(id)
    seen.add(id)
  }

  let excess = existing.length + fresh.length - cap
  const kept: number[] = []
  const rolledOffIds: number[] = []
  for (const id of existing) {
    if (excess > 0 && !redropped.has(id)) { rolledOffIds.push(id); excess--; continue }
    kept.push(id)
  }
  let overflow = 0
  if (excess > 0) {
    // Everything left is a song re-dropped this batch: the drop itself is
    // bigger than the room. Its earliest songs are the ones that don't fit.
    overflow = Math.min(excess, fresh.length)
    fresh = fresh.slice(overflow)
  }
  return {
    ids: [...kept, ...fresh],
    added: fresh.length,
    dupes,
    skits,
    rolledOff: rolledOffIds.length,
    rolledOffIds,
    overflow,
  }
}

export function removeFromPool(existing: number[], remove: number[]): number[] {
  const gone = new Set(remove.map(Number))
  return existing.filter((id) => !gone.has(id))
}
