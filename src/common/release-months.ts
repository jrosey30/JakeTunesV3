/**
 * This year's releases month by month (2026-10-24, Jake: "a 2026 month by month
 * playlist. so if a song, album, ep etc came out with something in September
 * 2026, they automatically go in the september 2026 playlist … singles off an
 * album that hasn't been released yet go into the month the full album is
 * being released in").
 *
 * homemini owns the dates (JakeTunesMobile backend/src/util/releaseMonths.ts:
 * MusicBrainz first-release-date per album, the month added as the fallback
 * for albums tagged this year, reissues kept out). The desktop adopts its
 * GET /api/release-months (src/main/release-months.ts) and shows one smart
 * playlist per month in the sidebar, under a section per year.
 *
 * ⚠️ TWIN: the backend's monthPlaylistName / row shape / order live in
 * JakeTunesMobile backend/src/util/releaseMonths.ts — the phone lists the same
 * months as built-in playlists. Change a name or the order on both sides.
 */

export type MonthSource = 'mb' | 'added'
/** [song id, 'YYYY-MM', the release date as known, how it was known] — already in playlist order. */
export type MonthRow = [string, string, string, MonthSource]

export interface ReleaseMonths {
  builtAtMs: number
  /** the first year with month playlists */
  from: number
  /** 'YYYY-MM', ascending */
  months: string[]
  tracks: MonthRow[]
  /** albums homemini has not asked MusicBrainz about yet */
  pending: number
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const

/** The sidebar/view id of a month's smart playlist: 'month-2026-09'. */
export const monthPlaylistId = (ym: string): `month-${string}` => `month-${ym}`
export const parseMonthPlaylistId = (id: string): string | null => /^month-(\d{4}-\d{2})$/.exec(id)?.[1] ?? null
/** 'September 2026' */
export function monthPlaylistName(ym: string): string {
  const m = Number(ym.slice(5, 7))
  return `${MONTH_NAMES[m - 1] ?? ym} ${ym.slice(0, 4)}`
}

const isRow = (r: unknown): r is MonthRow =>
  Array.isArray(r) && r.length >= 4 && typeof r[0] === 'string' && /^\d{4}-\d{2}$/.test(String(r[1])) && typeof r[2] === 'string' && (r[3] === 'mb' || r[3] === 'added')

/** Pure: parse + validate homemini's document. Null on anything malformed. */
export function parseReleaseMonths(raw: string): ReleaseMonths | null {
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  const d = o as { v?: unknown; builtAt?: unknown; from?: unknown; months?: unknown; tracks?: unknown; pending?: unknown }
  if (!d || d.v !== 1 || typeof d.builtAt !== 'string' || !Array.isArray(d.months) || !Array.isArray(d.tracks)) return null
  const builtAtMs = Date.parse(d.builtAt)
  if (!Number.isFinite(builtAtMs)) return null
  const tracks = d.tracks.filter(isRow).map((r): MonthRow => [r[0], r[1], r[2], r[3]])
  const months = [...new Set(d.months.filter((m): m is string => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m)))].sort()
  return { builtAtMs, from: Number(d.from) || 0, months, tracks, pending: Math.max(0, Number(d.pending) || 0) }
}

/** A month's song ids (the library's numeric ids), in playlist order. */
export function monthTrackIds(rm: Pick<ReleaseMonths, 'tracks'> | null, ym: string): number[] {
  if (!rm) return []
  return rm.tracks.filter((r) => r[1] === ym).map((r) => Number(r[0])).filter((n) => Number.isFinite(n))
}

/** The years that have months, ascending ('2026', '2027', …). */
export function yearsOf(rm: Pick<ReleaseMonths, 'months'> | null): string[] {
  return rm ? [...new Set(rm.months.map((m) => m.slice(0, 4)))].sort() : []
}
