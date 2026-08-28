/**
 * Spotify taste signal (2026-08-28 — Jake: "wire in the taste signal they
 * use"). Spotify closed every discovery endpoint to personal apps
 * (Nov 2024), so Discover Weekly itself is unreachable — but his OWN
 * listening over there is still readable, and that listening is exactly
 * the input Discover Weekly fed on. We pull it weekly and hand the top
 * Spotify artists to the Record Shop's anchor pool, so the Deezer graph
 * digs from the Spotify side of his ear too.
 *
 * Electron-free: pure aggregation + file IO with injected paths.
 */
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname } from 'path'

export interface SpotifyTasteTrack { song: string; artist: string; album?: string }

/** Jake, verbatim (2026-08-28): "FAKE MUSIC can not be involved in
 *  jaketunes." Hard exclusion — these artists never enter the taste
 *  signal, never rank, never anchor. Case-insensitive. Add names here;
 *  never soften. */
export const SPOTIFY_TASTE_BLOCKLIST = new Set(['fake music'])

const blocked = (artist: string): boolean => SPOTIFY_TASTE_BLOCKLIST.has(String(artist || '').trim().toLowerCase())

export interface SpotifyTasteFile {
  /** Ranked by weighted presence across top-tracks + likes. */
  topArtists: string[]
  topTracks: SpotifyTasteTrack[]
  likedRecent: SpotifyTasteTrack[]
  pulledAt: string
}

/**
 * Rank artists across the pulled slices. Short-term top tracks weigh
 * heaviest (that IS the current ear), then medium-term, then recent likes.
 */
export function aggregateTopArtists(slices: { tracks: SpotifyTasteTrack[]; weight: number }[], max = 8): string[] {
  const score = new Map<string, { name: string; score: number }>()
  for (const { tracks, weight } of slices) {
    tracks.forEach((t, i) => {
      const name = String(t.artist || '').trim()
      if (!name || blocked(name)) return
      const key = name.toLowerCase()
      // Earlier in a ranked list = stronger signal.
      const points = weight * (tracks.length - i) / tracks.length
      const cur = score.get(key)
      if (cur) cur.score += points
      else score.set(key, { name, score: points })
    })
  }
  return [...score.values()].sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.name)
}

export async function saveSpotifyTaste(taste: SpotifyTasteFile, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(taste, null, 2))
  await rename(tmp, file)
}

/** Top Spotify artists for the shop's anchor pool — [] when never pulled. */
export async function loadSpotifyTasteAnchors(file: string, max = 4): Promise<string[]> {
  try {
    const v = JSON.parse(await readFile(file, 'utf-8')) as SpotifyTasteFile
    // Blocklist applies at READ too — a taste file written before a name
    // was banned can never leak it into the anchor pool.
    return Array.isArray(v.topArtists)
      ? v.topArtists.filter((x): x is string => typeof x === 'string' && !blocked(x)).slice(0, max)
      : []
  } catch {
    return []
  }
}
