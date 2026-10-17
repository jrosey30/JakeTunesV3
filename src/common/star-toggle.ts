/**
 * Binary star toggle — the plan behind every "Star" / "Unstar" gesture
 * (right-click menu, ⇧⌘S on the playing song). Stars are binary: any
 * legacy rating > 0 reads as starred; a toggle writes 5 or 0.
 *
 * A mixed selection stars everyone (target 5) so the state becomes
 * consistent instead of half-flipping. Star-ON stamps starredAt so the
 * Starred smart playlist can sort recent-first; unstar leaves the stamp
 * alone (the track drops out of the playlist anyway, and re-starring
 * overwrites it). Every track in one toggle gets the same stamp — they
 * were starred together.
 *
 * Pure so it can be tested; StarRating.tsx::applyStarToggle performs it.
 */
export interface StarToggleUpdate { id: number; field: 'rating' | 'starredAt'; value: string }

export interface StarTogglePlan {
  /** 5 = star, 0 = unstar. */
  target: 0 | 5
  ratingUpdates: StarToggleUpdate[]
  /** Empty on unstar. */
  stampUpdates: StarToggleUpdate[]
}

export function isStarred(t: { rating?: number | string }): boolean {
  return (Number(t.rating) || 0) > 0
}

export function planStarToggle(tracks: readonly { id: number; rating?: number | string }[], now: number): StarTogglePlan {
  const allStarred = tracks.every(isStarred)
  const target: 0 | 5 = allStarred ? 0 : 5
  const ratingUpdates = tracks.map(t => ({ id: t.id, field: 'rating' as const, value: String(target) }))
  const stamp = String(now)
  const stampUpdates = target > 0
    ? tracks.map(t => ({ id: t.id, field: 'starredAt' as const, value: stamp }))
    : []
  return { target, ratingUpdates, stampUpdates }
}
