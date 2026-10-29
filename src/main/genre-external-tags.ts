/**
 * More outside tags for the genre filer (2026-10-28). MusicBrainz is thin for
 * newer artists (Sam Gellaitry's "IV": no album tags at all), so two sources
 * the app already talks to add lines of evidence — never answers:
 *   - Deezer album genres — keyless (api.deezer.com is used across the app).
 *     Coarse ("Dance", "Electro", "Rap/Hip Hop"), but it is the store's
 *     filing of THIS album.
 *   - Discogs genres + styles — only when DISCOGS_API_TOKEN is set (external.ts
 *     uses the same token). Styles are fine-grained ("Deep House", "Synthwave").
 * Last.fm was considered: the app has no LASTFM_API_KEY anywhere, and Jake
 * asked for no new accounts, so it is not used.
 *
 * Identity first: a hit counts only when its artist and title match the
 * album (folded names) — a namesake's genres are not evidence.
 * Pure over an injected fetch, so tests never touch the network.
 */
import { normName } from './taste-profile.ts'
import { releaseGroupTitleMatches } from './artist-tags.ts'

const sameArtist = (a: string | undefined, want: string): boolean => {
  const x = normName(a), y = normName(want)
  return !!x && !!y && (x === y || (y.length > 3 && (x.startsWith(y) || y.startsWith(x))))
}

/** Deezer's genres for the album, or [] (no match, no genres, any failure). */
export async function deezerAlbumGenres(artist: string, album: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  if (!artist.trim() || !album.trim()) return []
  try {
    const q = encodeURIComponent(`artist:"${artist}" album:"${album}"`)
    const res = await fetchFn(`https://api.deezer.com/search/album?q=${q}&limit=10`, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: Array<{ id?: number; title?: string; artist?: { name?: string } }> }
    const hit = (body.data ?? []).find((a) => sameArtist(a.artist?.name, artist) && releaseGroupTitleMatches(a.title, album))
    if (!hit?.id) return []
    const r2 = await fetchFn(`https://api.deezer.com/album/${hit.id}`, { signal: AbortSignal.timeout(6000) })
    if (!r2.ok) return []
    const a = (await r2.json()) as { genres?: { data?: Array<{ name?: string }> } }
    return [...new Set((a.genres?.data ?? []).map((g) => (g.name || '').trim()).filter(Boolean))]
  } catch { return [] }
}

/** Discogs genres then styles for the album, or [] (no token, no match, any failure). */
export async function discogsAlbumStyles(artist: string, album: string, token: string | undefined, fetchFn: typeof fetch = fetch): Promise<string[]> {
  if (!token || !artist.trim() || !album.trim()) return []
  try {
    const url = `https://api.discogs.com/database/search?artist=${encodeURIComponent(artist)}&release_title=${encodeURIComponent(album)}&per_page=5`
    const res = await fetchFn(url, { headers: { Authorization: `Discogs token=${token}`, 'User-Agent': 'JakeTunes/4' }, signal: AbortSignal.timeout(7000) })
    if (!res.ok) return []
    const body = (await res.json()) as { results?: Array<{ title?: string; genre?: string[]; style?: string[] }> }
    // Discogs titles read "Artist - Album".
    const hit = (body.results ?? []).find((r) => {
      const [a, ...t] = (r.title || '').split(' - ')
      return sameArtist(a, artist) && releaseGroupTitleMatches(t.join(' - '), album)
    })
    if (!hit) return []
    return [...new Set([...(hit.genre ?? []), ...(hit.style ?? [])].map((s) => s.trim()).filter(Boolean))]
  } catch { return [] }
}
