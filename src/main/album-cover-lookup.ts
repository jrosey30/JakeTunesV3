/**
 * Find an album's own cover. Used by the poster migration
 * (scripts/concert/concert-posters.mts): the 13 shows' posters had overwritten
 * their albums' covers, and the audit's plan was to take the covers back from the
 * files' embedded art. Measured on homemini on 2026-11-06, only one of those ten
 * albums has any (Forest Hills): the rest were re-encoded by afconvert, which
 * drops the picture (docs: 94% of the library). So: the file first, then the web,
 * and the migration's dry run puts each candidate in front of a person.
 *
 * Exact matches only: the artist and the title must be equal once brackets and a
 * leading "The" are set aside. The app's fetch-album-art also takes a prefix; a
 * prefix is how "Alive" finds "Alive 2007", and a wrong cover is worse than none.
 *
 * ⚠️ TWIN of the chain in ipc/artwork-ipc.ts fetch-album-art (external.ts
 * getMusicBrainzReleaseMbid, artwork-engine.ts searchDeezerArt).
 *
 * Electron-free; fetch is injected so the tests run offline.
 */
import type { ArtworkFetchProvider } from './artwork-provenance.ts'

export interface CoverCandidate {
  provider: ArtworkFetchProvider
  url: string
  /** What the source called it, for the person reviewing the dry run. */
  matched: string
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  arrayBuffer: () => Promise<ArrayBuffer>
  headers?: { get: (name: string) => string | null }
}>

/** "All The World's A Stage [Live]" → "all the world's a stage". */
export function comparableTitle(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/^the\s+/, '').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim()
}

/** The name to search for: the album without its bracketed tags. */
export function searchTitle(album: string): string {
  return album.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim() || album
}

const sameAlbum = (wantArtist: string, wantAlbum: string, artist: string, album: string): boolean =>
  comparableTitle(artist) === comparableTitle(wantArtist) && comparableTitle(album) === comparableTitle(wantAlbum)

const timeout = (ms: number): AbortSignal => AbortSignal.timeout(ms)
const UA = { 'User-Agent': 'JakeTunes/6 (concert poster migration)' }

export async function itunesCandidate(artist: string, album: string, fetchImpl: FetchLike): Promise<CoverCandidate | null> {
  const qs = new URLSearchParams({ term: `${artist} ${searchTitle(album)}`, entity: 'album', limit: '25' })
  const res = await fetchImpl(`https://itunes.apple.com/search?${qs}`, { headers: UA, signal: timeout(15_000) })
  if (!res.ok) return null
  const data = await res.json() as { results?: Array<{ artistName?: string; collectionName?: string; artworkUrl100?: string }> }
  for (const r of data.results ?? []) {
    if (!r.artworkUrl100 || !sameAlbum(artist, album, r.artistName ?? '', r.collectionName ?? '')) continue
    return { provider: 'itunes', url: r.artworkUrl100.replace('100x100bb', '1200x1200bb'), matched: `${r.artistName} - ${r.collectionName}` }
  }
  return null
}

export async function deezerCandidate(artist: string, album: string, fetchImpl: FetchLike): Promise<CoverCandidate | null> {
  const res = await fetchImpl(`https://api.deezer.com/search/album?q=${encodeURIComponent(`${artist} ${searchTitle(album)}`)}&limit=25`, { headers: UA, signal: timeout(15_000) })
  if (!res.ok) return null
  const data = await res.json() as { data?: Array<{ title?: string; artist?: { name?: string }; cover_xl?: string }> }
  for (const r of data.data ?? []) {
    if (!r.cover_xl || !sameAlbum(artist, album, r.artist?.name ?? '', r.title ?? '')) continue
    return { provider: 'deezer', url: r.cover_xl, matched: `${r.artist?.name} - ${r.title}` }
  }
  return null
}

export async function coverArtArchiveCandidate(artist: string, album: string, fetchImpl: FetchLike): Promise<CoverCandidate | null> {
  const q = `artist:"${artist.replace(/"/g, '\\"')}" AND release:"${searchTitle(album).replace(/"/g, '\\"')}"`
  const res = await fetchImpl(`https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(q)}&fmt=json&limit=10`, { headers: UA, signal: timeout(15_000) })
  if (!res.ok) return null
  const data = await res.json() as { releases?: Array<{ id?: string; title?: string; 'artist-credit'?: Array<{ name?: string }> }> }
  for (const r of data.releases ?? []) {
    if (!r.id || !sameAlbum(artist, album, (r['artist-credit'] ?? []).map((c) => c.name ?? '').join(' '), r.title ?? '')) continue
    return { provider: 'coverartarchive', url: `https://coverartarchive.org/release/${encodeURIComponent(r.id)}/front`, matched: `${artist} - ${r.title}` }
  }
  return null
}

/** The biggest clean catalogue art first; Cover Art Archive last, it serves ~500 px. A source that fails is skipped. */
export async function findCoverOnline(artist: string, album: string, fetchImpl: FetchLike, log: (m: string) => void = () => {}): Promise<{ candidate: CoverCandidate; bytes: Buffer } | null> {
  for (const lookup of [itunesCandidate, deezerCandidate, coverArtArchiveCandidate]) {
    try {
      const candidate = await lookup(artist, album, fetchImpl)
      if (!candidate) continue
      const img = await fetchImpl(candidate.url, { headers: UA, signal: timeout(30_000) })
      if (!img.ok) { log(`${candidate.provider}: HTTP ${img.status} for ${candidate.url}`); continue }
      const bytes = Buffer.from(await img.arrayBuffer())
      if (bytes.length === 0) continue
      return { candidate, bytes }
    } catch (err) {
      log(`${lookup.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return null
}
