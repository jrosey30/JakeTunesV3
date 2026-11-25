/**
 * Is there something for Sync to do? (V7 motion: the Sync button pulses like
 * Aqua's default button only then.)
 *
 * The page doesn't know song by song what the iPod holds, so this reads what
 * it does know: the last sync that landed songs. Due when the iPod was never
 * synced, the last sync didn't finish or didn't seal, or it put a different
 * number of songs on than the plan would now. Equal counts with different
 * songs read as not due: a quiet button, never a false alarm.
 *
 * Pure: no imports. DeviceView.tsx marks the button.
 */
export interface LastSyncLike {
  landed?: number
  sealedOk?: boolean
  aborted?: boolean
}

export function syncIsDue(planSongs: number, last: LastSyncLike | null | undefined): boolean {
  if (!last || last.landed == null) return true
  if (last.aborted || last.sealedOk === false) return true
  return last.landed !== planSongs
}
