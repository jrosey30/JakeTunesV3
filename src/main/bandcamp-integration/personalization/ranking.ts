// ════════════════════════════════════════════════════════════════════════
//  Ranking (Brief 036 v2.2, Layer 2)
//
//  One generic score(item, profile) with per-surface weight tables (the
//  Tier-1 tables Dex approved). This is what makes the Store beat
//  Bandcamp's un-personalized homepage: cross-signal blending where an item
//  hitting multiple of Jake's signals outranks one hitting just one.
// ════════════════════════════════════════════════════════════════════════

import { StoreAlbum, UnifiedProfile, Tier1Surface } from '../types'

interface Weights {
  follow: number
  label: number
  tag: number
  geo: number
  recency: number
  staple: number
  /** owned handling: 'exclude' drops owned items; number = score penalty. */
  owned: 'exclude' | number
}

export const SURFACE_WEIGHTS: Record<Tier1Surface, Weights> = {
  'featured-for-you': { follow: 0.40, label: 0.15, tag: 0.15, geo: 0.05, recency: 0.25, staple: 0.10, owned: 'exclude' },
  'your-new-picks': { follow: 0.55, label: 0.10, tag: 0.10, geo: 0.00, recency: 0.30, staple: 0.15, owned: 'exclude' },
  'search-rerank': { follow: 0.20, label: 0.20, tag: 0.30, geo: 0.10, recency: 0.05, staple: 0.20, owned: -0.5 },
}

/** Pre-indexed profile for O(1) lookups during a ranking pass. */
export interface ProfileIndex {
  tags: Map<string, number>
  labels: Map<string, number>
  geo: Map<string, number>
  followed: Set<string>
  staples: Map<string, number>
}

export function indexProfile(p: UnifiedProfile): ProfileIndex {
  return {
    tags: new Map(p.topTags.map((t) => [t.term, t.score])),
    labels: new Map(p.labelAffinity.map((t) => [t.term, t.score])),
    geo: new Map(p.geoClusters.map((t) => [t.term, t.score])),
    followed: new Set(p.followedArtists),
    staples: new Map(p.artistStaples.map((s) => [s.artist.toLowerCase().trim(), s.staple])),
  }
}

const DAY_MS = 86400000

function recencyScore(releaseDate?: string): number {
  if (!releaseDate) return 0
  const t = Date.parse(releaseDate)
  if (!Number.isFinite(t)) return 0
  const ageDays = (Date.now() - t) / DAY_MS
  if (ageDays < 0) return 1 // unreleased / pre-order edge
  return Math.max(0, 1 - ageDays / 365) // linear decay over a year
}

function tagOverlap(tags: string[], idx: Map<string, number>): number {
  if (tags.length === 0) return 0
  let sum = 0
  for (const tag of tags) sum += idx.get(tag.toLowerCase().trim()) || 0
  // average over the album's own tags so a 20-tag release isn't auto-top
  return Math.min(1, sum / Math.min(tags.length, 5))
}

export function scoreAlbum(album: StoreAlbum, idx: ProfileIndex, surface: Tier1Surface): number {
  const w = SURFACE_WEIGHTS[surface]
  const artist = album.artist.toLowerCase().trim()
  const isOwned = album.owned

  if (isOwned && w.owned === 'exclude') return Number.NEGATIVE_INFINITY

  let score =
    w.follow * (idx.followed.has(artist) ? 1 : 0) +
    w.label * (album.label ? idx.labels.get(album.label.toLowerCase().trim()) || 0 : 0) +
    w.tag * tagOverlap(album.tags, idx.tags) +
    w.geo * (album.geo ? idx.geo.get(album.geo.toLowerCase().trim()) || 0 : 0) +
    w.recency * recencyScore(album.releaseDate) +
    w.staple * (idx.staples.get(artist) || 0)

  if (isOwned && typeof w.owned === 'number') score += w.owned
  return score
}

/** Rank a candidate set for a surface; drops -Infinity (excluded) items. */
export function rankAlbums(albums: StoreAlbum[], p: UnifiedProfile, surface: Tier1Surface): StoreAlbum[] {
  const idx = indexProfile(p)
  return albums
    .map((a) => ({ a, s: scoreAlbum(a, idx, surface) }))
    .filter((x) => x.s !== Number.NEGATIVE_INFINITY)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a)
}
