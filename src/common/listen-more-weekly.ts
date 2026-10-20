/**
 * Listen More Weekly — the shared half (2026-10-20). homemini mints the
 * playlist every Monday 05:00 Eastern and keeps it all week (JakeTunesMobile
 * backend/src/util/listenMoreWeekly*.ts); main fetches it
 * (src/main/listen-more-weekly-client.ts) and the renderer draws it
 * (src/renderer/listenMoreWeekly.ts). Pure.
 */

export const LISTEN_MORE_WEEKLY_ID = 'jaketunes-listen-more-weekly'
export const LISTEN_MORE_WEEKLY_PATH = `/api/playlists/${LISTEN_MORE_WEEKLY_ID}`

export interface WeeklyPlaylist { name: string; trackIds: number[] }

export interface ListenMoreWeeklyState {
  playlist: WeeklyPlaylist | null
  source: 'homemini' | 'cache' | 'none'
  fetchedAt: number | null
}

/** homemini's playlist reply → name + song ids in order, or null. */
export function parseWeeklyPlaylist(body: unknown): WeeklyPlaylist | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { name?: unknown; tracks?: unknown; trackIds?: unknown }
  const raw = Array.isArray(b.tracks)
    ? b.tracks.map((t) => (t && typeof t === 'object' ? (t as { id?: unknown }).id : undefined))
    : Array.isArray(b.trackIds) ? b.trackIds : null
  if (!raw) return null
  const seen = new Set<number>()
  const trackIds: number[] = []
  for (const v of raw) {
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    trackIds.push(n)
  }
  if (trackIds.length === 0) return null
  return { name: typeof b.name === 'string' && b.name.trim() ? b.name : 'Listen More Weekly', trackIds }
}

