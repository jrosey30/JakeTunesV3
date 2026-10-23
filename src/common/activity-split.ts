/**
 * iPod Activity Sync is always half and half (Jake, 2026-10-16: "ipod sync
 * pool needs to be 50% automated 50% manual" — always, "newest drops
 * first"; and "bops, rocksurgence, recently added should always be in the
 * pool updated as i update those lists").
 *
 * Every sync of N songs:
 *   • YOUR half (N/2): first the PINNED lists — Greenpoint Greatest Hits, the
 *     Justification series, Bops, resolved live at sync time so they follow your edits —
 *     then your NEWEST pool drops fill what is left of the half. The pool
 *     keeps drop order with new drops appended; older drops wait their turn.
 *     If the pinned lists alone exceed the half (only at small sizes), the
 *     earlier pinned entries win (caller passes them in priority order).
 *   • MUSIC MAN's half: the rest. A short pool means Music Man covers the
 *     shortfall, so the sync is still N.
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
    `${split.pinnedCount} from your pinned lists`,
    `your ${plural(manualCount - split.pinnedCount, 'newest pool drop', 'newest pool drops')}`,
  ]
  if (topCount > 0) parts.push(`${topCount} from your Top 1000, best first`)
  if (musicManCount > 0) parts.push(plural(musicManCount, 'Music Man pick', 'Music Man picks'))
  const waiting = split.waitingIds.length > 0
    ? ` ${plural(split.waitingIds.length, 'older pool song sits', 'older pool songs sit')} this one out.`
    : ''
  return `Half and half: ${parts.join(' + ')}.${waiting}`
}
