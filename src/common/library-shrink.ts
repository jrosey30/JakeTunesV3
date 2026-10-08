/**
 * The 2026-05-29 shrink floor. A non-forced save that empties the library
 * or drops it below half is not a real edit — it is a torn load. The save
 * path (src/main/save-guards.ts shouldRefuseSave) and the hub full-snapshot
 * adoption (src/common/hub-catalog-merge.ts) share this predicate so a
 * replica cannot adopt a catalog the save would refuse, and neither side
 * can drift.
 *
 * `force` is the save path's explicit-recovery hatch. Adoption has no hatch.
 */
export const SHRINK_FLOOR = 0.5

export function isCatastrophicShrink(prevCount: number, newCount: number): boolean {
  if (prevCount <= 0) return false
  if (newCount === 0) return true
  return newCount < prevCount * SHRINK_FLOOR
}
