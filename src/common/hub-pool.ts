/**
 * The hub's iPod Pool, as a replica (workmini) reads it. Pure, so node --test
 * loads it.
 *
 * The MacBook is the only writer of activity-pool.json. It ships the file to
 * homemini, whose mobile backend serves it to the phone as a built-in
 * playlist (Mobile backend src/util/ipodPool.ts, id below). A replica reads
 * that SAME playlist over HTTP, read-only, and never writes it back.
 *
 * ⚠️ TWIN: ~/JakeTunesMobile/backend/src/util/ipodPool.ts IPOD_POOL_PLAYLIST_ID
 *          (the phone's "iPod Pool" playlist). The id is NOT 'ipod-pool' — the
 *          iPod's own "Pool" playlist already owns that one.
 */
export const HUB_POOL_PLAYLIST_ID = 'jaketunes-ipod-pool'

/** Ids in pool order from GET /api/playlists/<id>; null when the body isn't a
 *  playlist at all (an HTML error page, a different shape). Duplicates and
 *  non-numeric ids are dropped; the first copy of a song keeps its place. */
export function parseHubPoolBody(body: unknown): number[] | null {
  if (!body || typeof body !== 'object') return null
  const tracks = (body as { tracks?: unknown }).tracks
  if (!Array.isArray(tracks)) return null
  const seen = new Set<number>()
  const out: number[] = []
  for (const t of tracks) {
    const raw = t && typeof t === 'object' ? (t as { id?: unknown }).id : undefined
    const id = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
    if (!Number.isFinite(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
