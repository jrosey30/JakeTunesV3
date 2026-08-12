/**
 * Build an artist's real album shelf from Apple's artist→album lookup.
 *
 * Jake, searching "Migos": only Culture + Culture II showed up, both CLEAN.
 * Root cause was not "Apple only has two records" — the Download page derived
 * albums from a tiny song-search sample (later sliced to 10), while Apple's
 * artist album lookup already had the full catalogue with both editions.
 *
 * Rules:
 *   • Collapse clean/explicit twins under the same title; explicit wins.
 *   • Skip Singles clutter ("Bad and Boujee - Single") so the shelf is albums/EPs.
 *   • Sort newest first.
 *
 * ⚠️ Used by search-itunes (main) and covered by unit tests — keep edition
 * preference in sync with src/common/explicit.ts.
 */

import { foldAccents } from './fold-text.ts'
import { explicitWins } from './explicit.ts'

export function itunesReleaseYear(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const m = /^(\d{4})/.exec(raw)
  if (!m) return undefined
  const y = Number(m[1])
  return y >= 1900 && y <= 2100 ? y : undefined
}

export function albumNameKey(name: string): string {
  return foldAccents(name).replace(/[^a-z0-9]/g, '')
}

export interface ItunesAlbumHit {
  album: string
  artist: string
  artworkUrl?: string
  collectionId: number
  releaseYear?: number
  trackCount?: number
  genre?: string
  /** 'explicit' | 'cleaned' | 'notExplicit' */
  explicitness?: string
}

/** Albums / EPs / mixtapes — not one-track Apple "Singles". */
export function isAlbumishCollection(row: {
  collectionType?: unknown
  collectionName?: unknown
}): boolean {
  const name = String(row.collectionName ?? '')
  if (/ - Single$/i.test(name)) return false
  const ctype = String(row.collectionType ?? '')
  if (ctype === 'Single') return false
  return true
}

/**
 * Collapse Apple's collection rows into one shelf row per album title.
 * Explicit edition wins the collectionId so expand/download are uncensored.
 */
export function pickArtistAlbums(rows: Array<Record<string, unknown>>): ItunesAlbumHit[] {
  const byKey = new Map<string, ItunesAlbumHit>()
  for (const c of rows) {
    if (c.wrapperType !== 'collection') continue
    if (!isAlbumishCollection(c)) continue
    const album = String(c.collectionName ?? '').trim()
    const artist = String(c.artistName ?? '').trim()
    const collectionId = Number(c.collectionId)
    if (!album || !artist || !Number.isFinite(collectionId) || collectionId <= 0) continue
    const key = albumNameKey(album)
    if (!key) continue
    const incoming: ItunesAlbumHit = {
      album,
      artist,
      collectionId,
      artworkUrl: c.artworkUrl100
        ? String(c.artworkUrl100).replace('100x100', '200x200')
        : undefined,
      releaseYear: itunesReleaseYear(c.releaseDate),
      trackCount: typeof c.trackCount === 'number' ? c.trackCount : undefined,
      genre: typeof c.primaryGenreName === 'string' ? c.primaryGenreName : undefined,
      explicitness: typeof c.collectionExplicitness === 'string'
        ? c.collectionExplicitness
        : undefined,
    }
    const cur = byKey.get(key)
    if (!cur) {
      byKey.set(key, incoming)
      continue
    }
    if (explicitWins(cur.explicitness, incoming.explicitness)) {
      byKey.set(key, incoming)
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const yd = (b.releaseYear || 0) - (a.releaseYear || 0)
    if (yd !== 0) return yd
    return a.album.localeCompare(b.album)
  })
}

/** Folded album name → winning collection id (for rewriting song rows). */
export function albumCollectionByName(
  albums: ItunesAlbumHit[],
): Map<string, { id: number; explicitness?: string }> {
  const m = new Map<string, { id: number; explicitness?: string }>()
  for (const a of albums) {
    const k = albumNameKey(a.album)
    if (k) m.set(k, { id: a.collectionId, explicitness: a.explicitness })
  }
  return m
}
