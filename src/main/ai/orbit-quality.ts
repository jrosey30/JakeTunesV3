/**
 * Orbit / "Because You Played" neighbor quality floor.
 *
 * Top-K cosine against a single seed ALWAYS fills the list — even when the
 * 10th neighbor is sonically unrelated junk. That is how Red Hot Chili
 * Peppers and Violet Grohl landed in the orbit of Robson Jorge & Lincoln
 * Olivetti's "Ginga": the mix builder asked for 25 nearest and the brain
 * obliged with weak matches instead of stopping.
 *
 * Same lesson as playlist-vibes.ts (2026-07-19, SOAD on a pool playlist):
 * a weak cosine is not a vibe. Serve nothing before serving garbage.
 *
 * ⚠️ TWIN: JakeTunesMobile daily-mix orbit / because-you-played builders
 *    (`backend/src/routes/mixes.ts`). Apply this floor AT GENERATION so
 *    the phone never ships a 25-track tape padded with false neighbors.
 *    Desktop re-applies it on hydration as a safety net.
 */

import { cosine } from '../playlist-vibes.ts'

/** Below this raw cosine to the seed, the neighbor is not in orbit. */
export const ORBIT_ABS_FLOOR = 0.58

/**
 * Drop trails that sit this far below the best neighbor in the set.
 * Keeps a tight cloud around the seed instead of a long mediocre tail.
 */
export const ORBIT_REL_MARGIN = 0.12

export interface OrbitSeedRef {
  /** 'title' = named song ("orbit of 'Ginga'"); 'artist' = Because You Played X */
  kind: 'title' | 'artist'
  query: string
}

/** Pull the seed name out of mix chrome. */
export function parseOrbitSeed(title: string, subtitle = ''): OrbitSeedRef | null {
  const blob = `${title}\n${subtitle}`
  const orbit = blob.match(/\borbit of\s+['"“‘](.+?)['"”’]/i)
  if (orbit) {
    const q = orbit[1].trim()
    if (q) return { kind: 'title', query: q }
  }
  const because = title.match(/^\s*because you played\s+(.+?)\s*$/i)
  if (because) {
    // Titles truncate on the card ("Robson Jo...") — strip ellipsis junk.
    const q = because[1].replace(/(?:\.{2,}|…|\s)+$/u, '').trim()
    if (q.length >= 2) return { kind: 'artist', query: q }
  }
  return null
}

function foldName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

export interface OrbitSeedTrack {
  id: number
  title?: string
  artist?: string
  albumArtist?: string
}

/**
 * Resolve seed track ids from the library. Title seeds prefer exact title
 * match; artist seeds match artist / albumArtist, allowing prefix match so
 * a truncated "Robson Jo" still finds "Robson Jorge & Lincoln Olivetti".
 */
export function resolveOrbitSeedIds(
  seed: OrbitSeedRef,
  library: OrbitSeedTrack[],
  cap = 40,
): number[] {
  const q = foldName(seed.query)
  if (!q) return []
  const hits: number[] = []
  if (seed.kind === 'title') {
    for (const t of library) {
      const title = foldName(t.title || '')
      if (title === q || title.includes(q) || q.includes(title)) {
        hits.push(t.id)
        if (hits.length >= cap) break
      }
    }
    return hits
  }
  // artist — exact first, then prefix (truncated card titles)
  for (const t of library) {
    for (const raw of [t.artist, t.albumArtist]) {
      const a = foldName(raw || '')
      if (!a) continue
      if (a === q || a.startsWith(q) || q.startsWith(a) || a.includes(q)) {
        hits.push(t.id)
        break
      }
    }
    if (hits.length >= cap) break
  }
  return hits
}

export interface OrbitScored {
  trackId: number
  score: number
}

/**
 * Keep candidates whose best cosine to any seed vector clears the absolute
 * floor AND sits within relMargin of the best score in this candidate set.
 * Seed track ids are always kept (score forced to 1) so the named song
 * cannot be floored out of its own orbit.
 */
export function filterOrbitNeighbors(
  seedVecs: Float32Array[],
  candidates: Array<{ trackId: number; vec: Float32Array }>,
  opts?: {
    absFloor?: number
    relMargin?: number
    alwaysKeep?: ReadonlySet<number>
  },
): OrbitScored[] {
  if (seedVecs.length === 0 || candidates.length === 0) return []
  const absFloor = opts?.absFloor ?? ORBIT_ABS_FLOOR
  const relMargin = opts?.relMargin ?? ORBIT_REL_MARGIN
  const alwaysKeep = opts?.alwaysKeep

  const scored: OrbitScored[] = []
  for (const c of candidates) {
    if (alwaysKeep?.has(c.trackId)) {
      scored.push({ trackId: c.trackId, score: 1 })
      continue
    }
    let best = -1
    for (const s of seedVecs) {
      const sim = cosine(c.vec, s)
      if (sim > best) best = sim
    }
    if (best >= absFloor) scored.push({ trackId: c.trackId, score: best })
  }
  if (scored.length === 0) return []
  const peak = Math.max(...scored.map((s) => s.score))
  const relFloor = peak - relMargin
  return scored
    .filter((s) => s.score >= relFloor || alwaysKeep?.has(s.trackId))
    .sort((a, b) => b.score - a.score)
}
