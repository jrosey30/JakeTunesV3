/**
 * The Original iPod's brain half comes from the Top 1000 (Jake, 2026-10-23:
 * the Original is "my top 1000 songs", and the quiz's list drives its brain
 * half — "yes"). Your half (pinned lists + newest pool drops,
 * activity-split.ts) goes on first; this fills the rest straight down
 * homemini's ranked list, best first. No artist cap and no rotation: it is
 * his list, not a mix. Rocksurgence's lean is already inside the ranking.
 *
 * Pure — node --test loads it.
 */
export interface Top1000Pick {
  /** Song ids for the brain half, best-ranked first. */
  picked: number[]
  /** The next ranked songs, for the review sheet to swap in. */
  reserve: number[]
}

export const TOP1000_RESERVE = 50

export function pickFromTop1000(
  rankedIds: readonly number[],
  opts: { gap: number; exclude: ReadonlySet<number>; syncable: (id: number) => boolean },
): Top1000Pick {
  const gap = Math.max(0, Math.floor(opts.gap))
  const picked: number[] = []
  const reserve: number[] = []
  const seen = new Set<number>()
  for (const raw of rankedIds) {
    const id = Number(raw)
    if (!Number.isFinite(id) || seen.has(id) || opts.exclude.has(id) || !opts.syncable(id)) continue
    seen.add(id)
    if (picked.length < gap) picked.push(id)
    else if (reserve.length < TOP1000_RESERVE) reserve.push(id)
    else break
  }
  return { picked, reserve }
}
