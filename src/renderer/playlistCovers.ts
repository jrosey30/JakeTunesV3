/**
 * playlistCovers — which playlists have a cover Jake chose himself.
 *
 * 2026-08-09: "playlists on desktop need covers....like it is on mobile
 * (first 4 songs' album covers or i can upload a custom cover that i want in
 * jpg jpeg or png etc"
 *
 * Two halves, and only one of them needs state. The DEFAULT — a 2×2 mosaic of
 * the first four unique album covers — is computed on the fly by MixArtwork,
 * which already implements exactly the rule iOS uses, so a playlist has a
 * cover the moment it has songs and nothing has to be stored. This store is
 * only the override.
 *
 * Module-store pattern (same as mixtapes.ts / concertNav.ts) because
 * LibraryContext is do-not-touch: a `coverPath` on Playlist would mean a new
 * reducer action inside a protected file. Main derives the map from the
 * covers directory, so the filename is the single source of truth.
 */

let covers: Record<string, number> = {}   // playlistId -> mtimeMs
let loaded = false
const listeners = new Set<() => void>()

function notify(): void { for (const l of listeners) l() }

export function subscribePlaylistCovers(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getPlaylistCovers(): Record<string, number> { return covers }

export async function refreshPlaylistCovers(): Promise<void> {
  try {
    const r = await window.electronAPI.playlistCoversMap?.()
    if (r?.ok) { covers = r.covers; loaded = true; notify() }
  } catch { /* no covers is a fine answer */ }
}

export function ensurePlaylistCoversLoaded(): void {
  if (!loaded) void refreshPlaylistCovers()
}

/**
 * The <img> src for a playlist's custom cover, or null to fall back to the
 * mosaic. The mtime is appended as a query so REPLACING a cover actually
 * shows the new picture — the path never changes, so without it the renderer
 * would happily serve the old one from cache.
 */
export function playlistCoverSrc(playlistId: string): string | null {
  const stamp = covers[playlistId]
  if (!stamp) return null
  return `playlist-cover://${encodeURIComponent(playlistId)}.jpg?v=${Math.round(stamp)}`
}

export async function pickPlaylistCover(playlistId: string): Promise<string | null> {
  const r = await window.electronAPI.pickPlaylistCover?.(playlistId)
  if (!r?.ok) return r?.canceled ? null : (r?.error || 'Could not set that cover.')
  await refreshPlaylistCovers()
  return null
}

export async function clearPlaylistCover(playlistId: string): Promise<void> {
  await window.electronAPI.clearPlaylistCover?.(playlistId)
  await refreshPlaylistCovers()
}
