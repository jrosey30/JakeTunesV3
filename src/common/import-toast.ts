/**
 * The "Added to your library" toast — what it says, and what clicking it
 * plays. Pure, so the renderer store (state/recentlyAdded.ts) and the toast
 * (components/BandcampImportToast.tsx) share one rule and the rule is tested.
 *
 * Main sends one `bandcamp:track-imported` per imported track, carrying the
 * library's real track id (streamrip-store importStaged, bandcamp
 * download-router). The renderer buffers a burst for 2s and shows ONE toast;
 * the toast now carries the ids of that burst so a click can play exactly
 * what just landed.
 */

export interface ImportedTrackLike {
  id?: number
  title?: string
  artist?: string
  album?: string
}

export interface ImportToastSummary {
  message: string
  /** The burst's real library ids, arrival order, deduped. May be empty
   *  (an event without an id still counts toward the message). */
  trackIds: number[]
}

export function summarizeImportBatch(batch: readonly ImportedTrackLike[]): ImportToastSummary | null {
  if (batch.length === 0) return null

  const trackIds: number[] = []
  const seen = new Set<number>()
  for (const t of batch) {
    if (typeof t.id !== 'number' || !Number.isFinite(t.id) || seen.has(t.id)) continue
    seen.add(t.id)
    trackIds.push(t.id)
  }

  if (batch.length === 1) {
    const t = batch[0]
    const label = t.title ? `'${t.title}'` : 'track'
    return { message: `Added ${label} to your library`, trackIds }
  }

  // Most-common album in the batch wins the headline. Real-world album
  // zips have all the same album, so this is almost always trivially
  // unambiguous; the modal collapse is for the edge case of two purchases
  // landing inside the same aggregation window.
  const albumCounts = new Map<string, number>()
  for (const t of batch) {
    const a = (t.album || '').trim()
    if (a) albumCounts.set(a, (albumCounts.get(a) || 0) + 1)
  }
  let topAlbum = ''
  let topCount = 0
  for (const [a, c] of albumCounts) if (c > topCount) { topAlbum = a; topCount = c }
  const label = topAlbum ? `'${topAlbum}'` : 'your purchase'
  return { message: `Added ${batch.length} tracks from ${label} to your library`, trackIds }
}

export interface PlayableImported {
  album?: string
  discNumber?: number | string
  trackNumber?: number | string
}

const num = (v: number | string | undefined): number | null => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The order a click plays the arrivals in. One album with a track number
 *  on every song → the record's running order (disc, then track): import
 *  order follows the files on disk, which is not always the tracklist.
 *  Anything else (a mixed burst, missing numbers) keeps arrival order —
 *  never guess an order the tags don't state. Stable; never drops a track. */
export function playOrderForImport<T extends PlayableImported>(tracks: readonly T[]): T[] {
  if (tracks.length < 2) return [...tracks]
  const album = (tracks[0].album || '').trim().toLowerCase()
  const oneAlbum = album !== '' && tracks.every((t) => (t.album || '').trim().toLowerCase() === album)
  if (!oneAlbum || !tracks.every((t) => num(t.trackNumber) !== null)) return [...tracks]
  return tracks
    .map((t, i) => ({ t, i, d: num(t.discNumber) ?? 1, n: num(t.trackNumber) ?? 0 }))
    .sort((a, b) => a.d - b.d || a.n - b.n || a.i - b.i)
    .map((x) => x.t)
}
