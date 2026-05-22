// ════════════════════════════════════════════════════════════════════════
//  Signal merge → unified taste profile (Brief 036 v2.2, Layer 2)
//
//  Combines the library side (genre/decade/staples) with the Bandcamp side
//  (tags/labels/geo/follows). Tag frequency blends library 0.6 / Bandcamp
//  collection 0.3 / wishlist 0.1 (Jake's mandate: library is the heavier,
//  curated signal). Each source is max-normalized to 0..1 before weighting
//  so the weights mean the same thing regardless of raw sample size.
//  Weights are constants here; Phase 2 makes them tunable.
// ════════════════════════════════════════════════════════════════════════

import { BandcampProfile, UnifiedProfile, ScoredTerm, BcItem } from '../types'
import { LibrarySignals } from './library-ingestion'
import { OwnedSets } from './overlap-detection'

const W_LIB = 0.6
const W_BC_COLLECTION = 0.3
const W_BC_WISHLIST = 0.1

function maxNorm(map: Map<string, number>): Map<string, number> {
  let max = 0
  for (const v of map.values()) max = Math.max(max, v)
  const out = new Map<string, number>()
  if (max === 0) return out
  for (const [k, v] of map) out.set(k, v / max)
  return out
}

function countTags(items: BcItem[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) {
    for (const tag of it.tags || []) {
      const t = tag.toLowerCase().trim()
      if (t.length > 1) m.set(t, (m.get(t) || 0) + 1)
    }
  }
  return m
}

function countBy(items: BcItem[], pick: (i: BcItem) => string | undefined): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) {
    const v = pick(it)?.toLowerCase().trim()
    if (v) m.set(v, (m.get(v) || 0) + 1)
  }
  return m
}

function toSorted(map: Map<string, number>, limit?: number): ScoredTerm[] {
  const arr = [...map].map(([term, score]) => ({ term, score })).sort((a, b) => b.score - a.score)
  return limit ? arr.slice(0, limit) : arr
}

function blendDecade(lib: Map<string, number>, bc: Map<string, number>): Map<string, number> {
  const libN = maxNorm(lib)
  const bcN = maxNorm(bc)
  const out = new Map<string, number>()
  for (const k of new Set([...libN.keys(), ...bcN.keys()])) {
    out.set(k, 0.6 * (libN.get(k) || 0) + 0.4 * (bcN.get(k) || 0))
  }
  return out
}

function bandcampDecades(items: BcItem[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) {
    const y = it.releaseDate ? new Date(it.releaseDate).getFullYear() : NaN
    if (Number.isFinite(y) && y > 1900 && y < 2100) {
      const dec = `${Math.floor(y / 10) * 10}s`
      m.set(dec, (m.get(dec) || 0) + 1)
    }
  }
  return m
}

export function computeUnifiedProfile(
  library: LibrarySignals,
  profile: BandcampProfile | null,
  owned: OwnedSets,
): UnifiedProfile {
  const libTags = maxNorm(library.genreCounts)
  const bcColl = profile ? maxNorm(countTags(profile.collection)) : new Map<string, number>()
  const bcWish = profile ? maxNorm(countTags(profile.wishlist)) : new Map<string, number>()

  const tagScore = new Map<string, number>()
  for (const k of new Set([...libTags.keys(), ...bcColl.keys(), ...bcWish.keys()])) {
    tagScore.set(
      k,
      W_LIB * (libTags.get(k) || 0) +
      W_BC_COLLECTION * (bcColl.get(k) || 0) +
      W_BC_WISHLIST * (bcWish.get(k) || 0),
    )
  }

  // Label & geo are Bandcamp-only (library has neither). Wishlist at ½.
  const labelMap = new Map<string, number>()
  const geoMap = new Map<string, number>()
  if (profile) {
    for (const [k, v] of countBy(profile.collection, (i) => i.label)) labelMap.set(k, v)
    for (const [k, v] of countBy(profile.wishlist, (i) => i.label)) labelMap.set(k, (labelMap.get(k) || 0) + 0.5 * v)
    for (const [k, v] of countBy(profile.collection, (i) => i.geo)) geoMap.set(k, v)
  }

  const decade = blendDecade(library.decadeCounts, profile ? bandcampDecades(profile.collection) : new Map<string, number>())

  return {
    computedAt: Date.now(),
    topTags: toSorted(tagScore),
    labelAffinity: toSorted(labelMap),
    geoClusters: toSorted(geoMap),
    decade: toSorted(decade),
    followedArtists: profile ? profile.following.map((f) => f.name.toLowerCase().trim()).filter(Boolean) : [],
    artistStaples: library.artistStaples,
    ownedFingerprints: [...owned.fingerprints],
    ownedArtistAlbum: [...owned.artistAlbum],
    sources: { library: library.artistCount > 0, bandcamp: !!profile },
  }
}
