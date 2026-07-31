/**
 * Artist portraits — the ONE place that decides what an "artist" looks like.
 *
 * Jake, twice: "the images are not artist images. its their albums" and
 * "that's an album picture not an artist". The Discover feed's Overlooked lane
 * was labelling cards "Artist", cropping them into circles, and then filling
 * them with ALBUM artwork looked up by `artist|||album` — a square cover
 * punched into a circle, which is what made it read as sloppy. Meanwhile 87
 * real portraits sat unused in artist-images/.
 *
 * Extracted from ArtistsView (4.4.40) rather than copied: two implementations
 * of "what does this artist look like" would drift, and the sidebar avatar and
 * the Discover card would stop agreeing about the same artist.
 *
 * Fallback is deliberately an initials disc, never album art. A cover in a
 * circle claims to be a photo of a person and isn't; initials are honest and
 * look intentional.
 */
const AVATAR_COLORS = ['#c0392b', '#8e44ad', '#2980b9', '#27ae60', '#f39c12', '#d35400', '#1abc9c', '#7f8c8d']

/** Survives view unmount — avoids re-fetching photos on every visit.
 *  Value: slug (found) | null (looked up, none available — don't retry). */
export const sessionArtistImages = new Map<string, string | null>()

export const ARTIST_PHOTO_PREFETCH_CAP = 32
export const ARTIST_PHOTO_BATCH = 3

export function hashColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

export function initials(name: string): string {
  return name.split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 2)
}

/**
 * Fetch portraits for `names` that we haven't looked up yet, in small batches
 * so the Bandsintown-backed IPC isn't hammered. Resolves with the pairs found;
 * caller merges them into its own state. Safe to call repeatedly — already
 * known names are skipped.
 */
export async function prefetchArtistPortraits(
  names: string[],
  known: Map<string, string | null>,
  opts: { cap?: number; cancelled?: () => boolean } = {},
): Promise<Array<readonly [string, string | null]>> {
  const api = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI
  const fn = api && typeof api.getArtistImage === 'function'
    ? api.getArtistImage as (artist: string) => Promise<{ ok: boolean; slug?: string | null }>
    : null
  if (!fn) return []

  const todo = names
    .filter((n) => n && n !== 'Unknown Artist')
    .filter((n) => !known.has(n) && !sessionArtistImages.has(n))
    .slice(0, opts.cap ?? ARTIST_PHOTO_PREFETCH_CAP)
  if (todo.length === 0) return []

  const out: Array<readonly [string, string | null]> = []
  for (let i = 0; i < todo.length; i += ARTIST_PHOTO_BATCH) {
    if (opts.cancelled?.()) break
    const batch = todo.slice(i, i + ARTIST_PHOTO_BATCH)
    const results = await Promise.all(batch.map(async (name) => {
      try {
        const r = await fn(name)
        return [name, r.ok && r.slug ? r.slug : null] as const
      } catch {
        return [name, null] as const
      }
    }))
    for (const pair of results) { sessionArtistImages.set(pair[0], pair[1]); out.push(pair) }
  }
  return out
}
