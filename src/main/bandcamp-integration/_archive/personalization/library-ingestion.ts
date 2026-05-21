// ════════════════════════════════════════════════════════════════════════
//  Library signal extraction (Brief 036 v2.2, Layer 2)
//
//  Turns LibraryRow[] into the library side of the unified taste profile:
//  genre-token frequency, decade buckets, and an engagement-weighted
//  per-artist "staple" score. Null-safe by design (Dex refinement): unrated
//  / never-played tracks contribute 0 to their term rather than dragging an
//  average toward zero or producing NaN on a fresh library.
// ════════════════════════════════════════════════════════════════════════

import { LibraryRow, ArtistStaple } from '../types'

export function tokenizeGenre(genre: string): string[] {
  return genre
    .toLowerCase()
    .split(/[/,;&]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
}

export function decadeBucket(year: number | null): string | null {
  if (!year || year < 1900 || year > 2100) return null
  return `${Math.floor(year / 10) * 10}s`
}

interface ArtistAgg {
  albums: Set<string>
  trackCount: number
  totalPlays: number
  totalSkips: number
  ratings: number[]       // only present ratings
  recentPlayWeight: number // decayed plays for tracks with lastPlayedAt
}

const HALF_LIFE_DAYS = 90
const DAY_MS = 86400000

function decay(lastPlayedAt: number): number {
  const ageDays = (Date.now() - lastPlayedAt) / DAY_MS
  if (ageDays <= 0) return 1
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
}

export interface LibrarySignals {
  genreCounts: Map<string, number>
  decadeCounts: Map<string, number>
  artistStaples: ArtistStaple[]
  artistCount: number
}

export function ingestLibrary(rows: LibraryRow[]): LibrarySignals {
  const genreCounts = new Map<string, number>()
  const decadeCounts = new Map<string, number>()
  const agg = new Map<string, ArtistAgg>()

  for (const r of rows) {
    for (const tag of tokenizeGenre(r.genre)) {
      genreCounts.set(tag, (genreCounts.get(tag) || 0) + 1)
    }
    const dec = decadeBucket(r.year)
    if (dec) decadeCounts.set(dec, (decadeCounts.get(dec) || 0) + 1)

    const key = (r.albumArtist || r.artist).toLowerCase().trim()
    if (!key) continue
    let a = agg.get(key)
    if (!a) {
      a = { albums: new Set(), trackCount: 0, totalPlays: 0, totalSkips: 0, ratings: [], recentPlayWeight: 0 }
      agg.set(key, a)
    }
    if (r.album) a.albums.add(r.album.toLowerCase().trim())
    a.trackCount++
    a.totalPlays += r.playCount
    a.totalSkips += r.skipCount
    if (r.rating != null) a.ratings.push(r.rating)
    if (r.lastPlayedAt != null) a.recentPlayWeight += decay(r.lastPlayedAt) * Math.max(1, r.playCount)
  }

  // Normalize each metric across artists (max-norm), then blend.
  let maxOwned = 0
  let maxRecent = 0
  for (const a of agg.values()) {
    maxOwned = Math.max(maxOwned, a.albums.size)
    maxRecent = Math.max(maxRecent, a.recentPlayWeight)
  }

  const artistStaples: ArtistStaple[] = []
  for (const [artist, a] of agg) {
    const ownedNorm = maxOwned > 0 ? a.albums.size / maxOwned : 0
    const ratingNorm = a.ratings.length > 0
      ? (a.ratings.reduce((s, v) => s + v, 0) / a.ratings.length) / 5 // 0..1
      : 0
    const recentNorm = maxRecent > 0 ? a.recentPlayWeight / maxRecent : 0
    const playsPlusSkips = a.totalPlays + a.totalSkips
    const skipRate = playsPlusSkips > 0 ? a.totalSkips / playsPlusSkips : 0

    const staple = clamp01(
      0.35 * ownedNorm + 0.30 * ratingNorm + 0.25 * recentNorm - 0.10 * skipRate,
    )
    artistStaples.push({ artist, staple, ownedAlbumCount: a.albums.size })
  }
  artistStaples.sort((x, y) => y.staple - x.staple)

  return { genreCounts, decadeCounts, artistStaples, artistCount: agg.size }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}
