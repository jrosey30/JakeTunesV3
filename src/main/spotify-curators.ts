/**
 * Spotify curator lanes (2026-09-01, Jake: "this spotify user is a pretty
 * well known tiktok/instagram music curator. id like some songs from her
 * playlists to be in the record store").
 *
 * Spotify's Nov-2024 dev-mode purge blocks another user's playlist
 * CONTENTS through the API entirely (listing 403s; /playlists/{id}
 * returns metadata with tracks stripped; /playlists/{id}/tracks 403s —
 * all live-verified 2026-09-01). What still works: the curator's public
 * profile page embeds their playlist ids; the API still returns
 * name+owner for a playlist id (used ONLY to verify the curator owns
 * it); and the public EMBED page (open.spotify.com/embed/playlist/{id})
 * ships ~25 tracks of artist+title in its __NEXT_DATA__ JSON, keyless.
 * Every artist runs through the Spotify-taste blocklist (never
 * softened). The pool lands in a state file; the daily shop reserves a
 * few New Songs slots from it, rotated by day.
 *
 * Electron-free (fetch injected) — node --test loads it.
 */
import { readFile, writeFile, rename } from 'fs/promises'
import { freshAccessToken } from './spotify-connect.ts'
import { spotifyArtistBlocked } from './spotify-taste.ts'

export interface CuratorConfig { userId: string; name: string }
export interface CuratorPoolSong { artist: string; title: string; curator: string; playlist: string }
export interface CuratorPoolFile { pulledAt: string; songs: CuratorPoolSong[] }

/** Seeded roster — add a curator by editing spotify-curators.json in
 *  the app's state dir ({ curators: [{ userId, name }] }). */
export const DEFAULT_CURATORS: CuratorConfig[] = [
  { userId: 'agusarcolia-ar', name: 'Agus Arcolia' },
]

const MAX_PLAYLISTS_PER_CURATOR = 10
const MAX_TRACKS_PER_PLAYLIST = 100

export function extractPlaylistIds(html: string, cap = 20): string[] {
  return [...new Set([...html.matchAll(/playlist[/:]([A-Za-z0-9]{22})/g)].map((m) => m[1]))].slice(0, cap)
}

export async function loadCurators(file: string): Promise<CuratorConfig[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as { curators?: CuratorConfig[] }
    const list = (parsed.curators || []).filter((c) => c && c.userId && c.name)
    if (list.length) return list
  } catch { /* seed below */ }
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify({ curators: DEFAULT_CURATORS }, null, 2), 'utf-8')
  await rename(tmp, file)
  return DEFAULT_CURATORS
}

export async function loadCuratorPool(poolFile: string): Promise<CuratorPoolSong[]> {
  try {
    const parsed = JSON.parse(await readFile(poolFile, 'utf-8')) as CuratorPoolFile
    return Array.isArray(parsed.songs) ? parsed.songs : []
  } catch {
    return []
  }
}

interface PlaylistMeta {
  name?: string
  owner?: { id?: string }
}

/** Track list from the public embed page's __NEXT_DATA__ payload. */
export function parseEmbedTrackList(html: string): Array<{ artist: string; title: string }> {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)
  if (!m) return []
  try {
    const data = JSON.parse(m[1]) as {
      props?: { pageProps?: { state?: { data?: { entity?: { trackList?: Array<{ title?: string; subtitle?: string }> } } } } }
    }
    const list = data.props?.pageProps?.state?.data?.entity?.trackList || []
    return list
      .map((t) => ({ artist: String(t.subtitle || '').trim(), title: String(t.title || '').trim() }))
      .filter((t) => t.artist && t.title)
  } catch {
    return []
  }
}

export async function pullCuratorPool(
  opts: { authFile: string; curatorsFile: string; poolFile: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; songs?: number; playlists?: number; error?: string }> {
  const token = await freshAccessToken(opts.authFile, fetchFn)
  if (!token) return { ok: false, error: 'Spotify not connected' }
  const curators = await loadCurators(opts.curatorsFile)
  const songs: CuratorPoolSong[] = []
  const seen = new Set<string>()
  let playlistsRead = 0
  for (const c of curators) {
    let html = ''
    try {
      const page = await fetchFn(`https://open.spotify.com/user/${encodeURIComponent(c.userId)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } })
      if (page.ok) html = await page.text()
    } catch { /* page down — this curator contributes nothing this pull */ }
    const ids = extractPlaylistIds(html)
    for (const pid of ids.slice(0, MAX_PLAYLISTS_PER_CURATOR)) {
      try {
        // The page can embed playlists the curator merely follows — the
        // API's surviving name+owner read gates to what they actually OWN.
        const res = await fetchFn(
          `https://api.spotify.com/v1/playlists/${pid}?fields=name,owner(id)`,
          { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) continue
        const pl = await res.json() as PlaylistMeta
        if (pl.owner?.id !== c.userId) continue
        const emb = await fetchFn(`https://open.spotify.com/embed/playlist/${pid}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } })
        if (!emb.ok) continue
        const tracks = parseEmbedTrackList(await emb.text())
        if (!tracks.length) continue
        playlistsRead++
        for (const t of tracks) {
          if (spotifyArtistBlocked(t.artist)) continue
          const k = `${t.artist} ::: ${t.title}`.toLowerCase()
          if (seen.has(k)) continue
          seen.add(k)
          songs.push({ artist: t.artist, title: t.title, curator: c.name, playlist: String(pl.name || '') })
        }
      } catch { /* one bad playlist never sinks the pull */ }
    }
  }
  if (songs.length === 0) return { ok: false, error: 'no curator songs found' }
  const tmp = `${opts.poolFile}.tmp`
  await writeFile(tmp, JSON.stringify({ pulledAt: new Date().toISOString(), songs } satisfies CuratorPoolFile), 'utf-8')
  await rename(tmp, opts.poolFile)
  console.log(`[spotify] curator pool: ${songs.length} songs from ${playlistsRead} playlists (${curators.map((c) => c.name).join(', ')})`)
  return { ok: true, songs: songs.length, playlists: playlistsRead }
}
