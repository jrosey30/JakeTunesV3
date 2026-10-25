/**
 * iPod Activity Sync is always half and half (Jake, 2026-10-16: "ipod sync
 * pool needs to be 50% automated 50% manual" — always, "newest drops
 * first"; and "bops, rocksurgence, recently added should always be in the
 * pool updated as i update those lists").
 *
 * Every sync of N songs:
 *   • YOUR half (N/2): your NEWEST pool drops. The pool keeps drop order with
 *     new drops appended; older drops wait their turn.
 *   • THE TOP 1000's half: the rest (top1000-sync.ts; Music Man when homemini
 *     is away). A short pool means the brain covers the shortfall, so the
 *     sync is still N.
 *
 * No pinned lists, no locked albums (Jake, 2026-10-25: "strip the locks and
 * pins from the ipod pool too" — the Original is the Top 1000 plus his own
 * drops, nothing rides along unasked). Until then Greenpoint Greatest Hits,
 * the Justification series, Bops and Geese's 3D Country + Getting Killed went
 * on first (renderer/utils/poolPinnedLists.ts, common/pool-locked-albums.ts,
 * both removed). `pinnedIdsInPriority` stays for main's call (workout-sync-ipc.ts,
 * which is never fed any now) until the sync engine drops it.
 *
 * Shared by main (builds the set) and the Activity sheet (shows the split),
 * so the two can never disagree. Pure — node --test loads it.
 */
export interface HalfAndHalf {
  /** Your half, in order: pinned songs first, then pool drops (drop order). */
  manualIds: number[]
  /** How many of manualIds came from the pinned lists. */
  pinnedCount: number
  /** How many songs Music Man picks for the rest of the set. */
  brainTarget: number
  /** Pool/pinned ids that sit this sync out. */
  waitingIds: number[]
}

export function splitHalfAndHalf(
  poolIdsInDropOrder: readonly number[],
  target: number,
  pinnedIdsInPriority: readonly number[] = [],
): HalfAndHalf {
  const n = Math.max(0, Math.floor(target))
  const half = Math.floor(n / 2)
  const pinned: number[] = []
  const seen = new Set<number>()
  for (const id of pinnedIdsInPriority) {
    if (seen.has(id)) continue
    seen.add(id)
    pinned.push(id)
  }
  const pinnedOn = pinned.slice(0, half)
  const pinnedWaiting = pinned.slice(half)
  const drops = poolIdsInDropOrder.filter((id) => !seen.has(id))
  const slots = half - pinnedOn.length
  const cut = Math.max(0, drops.length - slots)
  const dropsOn = drops.slice(cut)
  const manualIds = [...pinnedOn, ...dropsOn]
  return {
    manualIds,
    pinnedCount: pinnedOn.length,
    brainTarget: Math.max(0, n - manualIds.length),
    waitingIds: [...pinnedWaiting, ...drops.slice(0, cut)],
  }
}

/** The review sheet's plain-words split of a half-and-half set. Your half,
 *  then the brain half: the Top 1000 for the Original (top1000-sync.ts),
 *  Music Man for whatever it can't cover. */
export function halfAndHalfLine(
  split: { pinnedCount: number; waitingIds: readonly number[] },
  manualCount: number,
  topCount: number,
  musicManCount: number,
): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts = [
    ...(split.pinnedCount > 0 ? [`${split.pinnedCount} from your pinned lists`] : []),
    `your ${plural(manualCount - split.pinnedCount, 'newest pool drop', 'newest pool drops')}`,
  ]
  if (topCount > 0) parts.push(`${topCount} from your Top 1000, best first`)
  if (musicManCount > 0) parts.push(plural(musicManCount, 'Music Man pick', 'Music Man picks'))
  const waiting = split.waitingIds.length > 0
    ? ` ${plural(split.waitingIds.length, 'older pool song sits', 'older pool songs sit')} this one out.`
    : ''
  return `Half and half: ${parts.join(' + ')}.${waiting}`
}
