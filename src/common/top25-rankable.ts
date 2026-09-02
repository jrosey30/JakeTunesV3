/**
 * Top 25 Most Played ranks SONGS. Jake, 2026-09-02: "anything under 1 min
 * should never be in the rankings… if it plays through the regular
 * library, you still have to count it as a play technically, but in terms
 * of top 25, they cant be on there otherwise they will easily climb up."
 * Plays count everywhere; the ranking just refuses the slot. Unknown
 * duration (0) stays rankable — never punish missing metadata.
 * Pure: shared by the smart-playlist evaluator (what the iPod's Top 25
 * syncs from) and the Top 25 view's windowed rankings.
 */
export const TOP_25_MIN_DURATION_MS = 60_000
export function isTop25Rankable(t: { duration?: number }): boolean {
  const d = Number(t.duration) || 0
  return d <= 0 || d >= TOP_25_MIN_DURATION_MS
}
