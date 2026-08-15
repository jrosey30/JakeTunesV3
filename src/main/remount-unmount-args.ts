/**
 * Unmount argv sets for a cache-evicting remount.
 *
 * Force unmount is NEVER in the default set. `diskutil unmount force` discards
 * dirty FAT32 pages instead of flushing them — that's the 489 → 33 song drop
 * on Jake's iFlash Mini. Sync verify must fail closed if a clean unmount
 * cannot run, not destroy the set it just wrote.
 *
 * Pure so tests can lock the argv without touching diskutil or loading
 * platform.ts (which probes Python/librosa at import time).
 */
export function remountUnmountArgSets(node: string, mountPoint: string, allowForce = false): string[][] {
  const sets: string[][] = [['unmount', node], ['unmount', mountPoint]]
  if (allowForce) sets.push(['unmount', 'force', node])
  return sets
}
