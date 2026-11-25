/**
 * Is there something for Sync to do? (V7 motion: the Sync button pulses like
 * Aqua's default button only then.)
 *
 * The page doesn't know song by song what the iPod holds, so this reads what
 * it does know: the last sync that landed songs. Due when the iPod was never
 * synced, the last sync didn't finish or didn't seal, or it put a different
 * number of songs on than it could now. A song the last sync had to leave off
 * (it can't be converted, the file is damaged) and that is still on the list
 * is not counted, so one song that can never go on doesn't keep Sync pulsing
 * for ever. Equal counts with different songs read as not due: a quiet
 * button, never a false alarm.
 *
 * Pure: no imports. DeviceView.tsx marks the button.
 */
export interface LastSyncLike {
  landed?: number
  /** What that sync had to leave off, by track id. */
  leftOff?: ReadonlyArray<{ id: number }>
  sealedOk?: boolean
  aborted?: boolean
}

export function syncIsDue(planIds: readonly number[], last: LastSyncLike | null | undefined): boolean {
  if (!last || last.landed == null) return true
  if (last.aborted || last.sealedOk === false) return true
  const couldNot = new Set((last.leftOff ?? []).map((l) => l.id))
  const placeable = couldNot.size === 0 ? planIds.length : planIds.filter((id) => !couldNot.has(id)).length
  return last.landed !== placeable
}
