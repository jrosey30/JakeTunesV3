/**
 * The '#' column's weekly movement (Top 25 Most Played since 4.5; Top 1000
 * from 2026-11-07). Jake: the Top 1000 "is the only playlist besides top 25
 * most played that has rankings. similarly operates to how top 25 rankings
 * operate." One rule for both lists:
 *
 *   - A snapshot rotates once a week: when a new week starts, last week's
 *     `curr` becomes `prev`; within a week only `curr` is refreshed.
 *   - The row shows its rank now, last week's rank in parens, and a green
 *     ▲n / red ▼n / grey — ; a song that wasn't on last week's list is NEW.
 *     The first snapshot ever has no `prev`, so every row is NEW that week.
 *
 * Each list keeps its own snapshot under its own ui-state key, so the two
 * rankings never mix. Pure — node --test loads it.
 */

export interface RankSnap {
  weekKey: number
  prev: Record<string, number> | null
  curr: Record<string, number>
}

/** ui-state key per ranked playlist. Top 25's key predates this file; never rename it. */
export const RANK_SNAPSHOT_KEYS = {
  'top-25': 'topRankSnapshot',
  'top-1000': 'top1000RankSnapshot',
} as const
export type RankedPlaylistId = keyof typeof RANK_SNAPSHOT_KEYS

export function isRankedPlaylist(id: string | null | undefined): id is RankedPlaylistId {
  return id === 'top-25' || id === 'top-1000'
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
export function weekKeyOf(nowMs: number): number {
  return Math.floor(nowMs / WEEK_MS)
}

function isRankSnap(v: unknown): v is RankSnap {
  return !!v && typeof v === 'object' && typeof (v as RankSnap).weekKey === 'number'
    && !!(v as RankSnap).curr && typeof (v as RankSnap).curr === 'object'
}

/** The snapshot to keep after looking at `currentRanks` this week, and whether
 *  it differs from what was saved (so an unchanged list never writes). */
export function rotateRankSnap(
  saved: unknown,
  currentRanks: Record<string, number>,
  currentWeek: number,
): { next: RankSnap; changed: boolean } {
  let next: RankSnap
  if (!isRankSnap(saved)) {
    // First-ever snapshot — no last week yet.
    next = { weekKey: currentWeek, prev: null, curr: currentRanks }
  } else if (saved.weekKey === currentWeek) {
    // Same week — keep prev, refresh curr.
    next = { weekKey: currentWeek, prev: saved.prev, curr: currentRanks }
  } else {
    // The week rolled over — what was current becomes last week.
    next = { weekKey: currentWeek, prev: saved.curr, curr: currentRanks }
  }
  const changed = !isRankSnap(saved) || saved.weekKey !== next.weekKey
    || JSON.stringify(saved.curr) !== JSON.stringify(next.curr)
    || JSON.stringify(saved.prev) !== JSON.stringify(next.prev)
  return { next, changed }
}

export type RankDirection = 'up' | 'down' | 'same' | 'new'
export interface RankMovement {
  direction: RankDirection
  /** what the arrow cell says: ▲n, ▼n, —, or NEW */
  arrow: string
  /** last week's rank in parens, '' for NEW */
  lwLabel: string
  /** the arrow's class, as songs.css styles it */
  arrowClass: string
}

/** How a row moved since last week. `lwRank` undefined = not on last week's list. */
export function rankMovement(rank: number, lwRank: number | undefined): RankMovement {
  if (lwRank === undefined) {
    return { direction: 'new', arrow: 'NEW', lwLabel: '', arrowClass: 'rank-arrow rank-arrow--new' }
  }
  const lwLabel = `(${lwRank})`
  if (rank < lwRank) return { direction: 'up', arrow: `▲${lwRank - rank}`, lwLabel, arrowClass: 'rank-arrow rank-arrow--up' }
  if (rank > lwRank) return { direction: 'down', arrow: `▼${rank - lwRank}`, lwLabel, arrowClass: 'rank-arrow rank-arrow--down' }
  return { direction: 'same', arrow: '—', lwLabel, arrowClass: 'rank-arrow rank-arrow--same' }
}
