/**
 * What the "Suggested for this playlist" strip remembers (2026-10-19, Jake's
 * calls in the taste-engine program):
 *
 *   ✕ ("not for this playlist")      → hidden from THAT playlist for good
 *   refreshed past twice within 90 d → hidden from that playlist for 90 days
 *                                      after the second refresh
 *   added, then taken back off       → hidden from that playlist for good
 *                                      (it was tried and did not belong)
 *
 * Everything is per playlist: a song that is wrong for Pool can be right for
 * Dinner Party. Legacy ledger rows ('pass', written on ↻ before 2026-10-19)
 * are refreshes. Pure — main serves it over IPC, tests bind to it.
 *
 * ⚠️ TWIN: scripts/taste-ledger-learn.py (REFRESH_HIDE_COUNT / REFRESH_HIDE_DAYS)
 * counts "repeat failures" with the same rule.
 */

export const REFRESH_HIDE_COUNT = 2
export const REFRESH_HIDE_DAYS = 90
const DAY_MS = 86_400_000

export interface LedgerRowLike {
  ts?: string
  surface?: string
  verdict?: string
  key?: { trackId?: unknown; playlistId?: unknown }
}

export type HideReason = 'rejected' | 'refreshed' | 'taken-back'
export interface HiddenEntry { reason: HideReason; until: number | null }   // null = for good

/**
 * The strip memory for ONE playlist: trackId → why it is hidden. `members`
 * is the playlist's current track list (an accepted song that is no longer
 * on it was taken back).
 */
export function stripMemoryFor(
  rows: Iterable<LedgerRowLike>,
  playlistId: string,
  members: ReadonlySet<number>,
  nowMs: number,
): Map<number, HiddenEntry> {
  const refreshes = new Map<number, number[]>()
  const rejected = new Set<number>()
  const accepted = new Map<number, number>()
  for (const r of rows) {
    if (r.surface !== 'strip' || !r.key || String(r.key.playlistId ?? '') !== playlistId) continue
    const id = Number(r.key.trackId)
    if (!Number.isFinite(id)) continue
    const t = Date.parse(r.ts ?? '')
    if (!Number.isFinite(t)) continue
    if (r.verdict === 'reject') rejected.add(id)
    else if (r.verdict === 'refresh' || r.verdict === 'pass') {
      const list = refreshes.get(id) ?? []
      list.push(t)
      refreshes.set(id, list)
    } else if (r.verdict === 'accept') accepted.set(id, Math.max(t, accepted.get(id) ?? 0))
  }
  const out = new Map<number, HiddenEntry>()
  for (const id of rejected) out.set(id, { reason: 'rejected', until: null })
  for (const [id] of accepted) {
    if (!members.has(id) && !out.has(id)) out.set(id, { reason: 'taken-back', until: null })
  }
  for (const [id, times] of refreshes) {
    if (out.has(id) || members.has(id)) continue
    // A refresh before the song was accepted is not a "no" any more.
    const after = accepted.get(id) ?? 0
    const ts = times.filter((t) => t > after).sort((a, b) => a - b)
    if (ts.length < REFRESH_HIDE_COUNT) continue
    const last = ts[ts.length - 1]
    const windowStart = last - REFRESH_HIDE_DAYS * DAY_MS
    const inWindow = ts.filter((t) => t >= windowStart).length
    const until = last + REFRESH_HIDE_DAYS * DAY_MS
    if (inWindow >= REFRESH_HIDE_COUNT && until > nowMs) out.set(id, { reason: 'refreshed', until })
  }
  return out
}

/** Track ids the playlist rejected outright or took back — the strip's
 *  negative examples ("looks like something that didn't belong"). */
export function negativeExamples(memory: Map<number, HiddenEntry>): number[] {
  return [...memory].filter(([, e]) => e.reason !== 'refreshed').map(([id]) => id)
}
