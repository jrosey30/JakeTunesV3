/**
 * The month and year playlists' covers (2026-11-13). Jake: "each month and
 * year gets its own specific design, january 2026 and 2027 cant look the same."
 *
 * homemini draws them (JakeTunesMobile tools/make-month-covers.py: a cover
 * forms with a month's first song, follows the month's records, and freezes 30
 * days after the month ends) and every app fetches the same picture from
 * GET /api/playlist-cover/<id>. The 24 covers that ship with this app only
 * stand in until homemini's has been fetched once.
 * ⚠️ CONTRACT: JakeTunesMobile backend/src/util/periodCovers.ts (the ids).
 */

/** homemini's playlist id for one of this app's month or year playlists; null for every other playlist. */
export function periodCoverRemoteId(id: unknown, bestOfYear: number): string | null {
  if (typeof id !== 'string') return null
  if (id === 'best-of-year') return Number.isInteger(bestOfYear) && bestOfYear >= 2000 && bestOfYear <= 9999 ? `jaketunes-best-of-${bestOfYear}` : null
  const m = /^month-(\d{4})-(0[1-9]|1[0-2])$/.exec(id)
  return m ? `jaketunes-month-${m[1]}-${m[2]}` : null
}

/** The only ids main will ask homemini about or name a file after. */
export const isPeriodCoverRemoteId = (id: unknown): id is string =>
  typeof id === 'string' && /^jaketunes-(month-\d{4}-(0[1-9]|1[0-2])|best-of-\d{4})$/.test(id)

export const periodCoverPath = (remoteId: string): string => `/api/playlist-cover/${remoteId}`
