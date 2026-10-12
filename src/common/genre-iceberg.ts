/**
 * Genre Icebergs (2026-10-11). Every artist on a shelf, placed by how known
 * they are — Deezer fans, from identities confirmed against Jake's own albums
 * or songs. Jake: zoom "both ways… more vague and more specific": a family
 * iceberg (the genre-vocab area) and a single-genre iceberg, both built from
 * each song's CURRENT genre tag — re-file a song and its artist moves.
 *
 * Pure; the view feeds it library tracks, confirmed facts and related lists.
 */
import { GENRES } from './genre-vocab.ts'

export const LAYERS = [
  { id: 0, name: 'The Tip', range: '500K+ fans', min: 500_000 },
  { id: 1, name: 'Just Below', range: '100K–500K', min: 100_000 },
  { id: 2, name: 'Below', range: '10K–100K', min: 10_000 },
  { id: 3, name: 'Deep Water', range: '1K–10K', min: 1_000 },
  { id: 4, name: 'The Abyss', range: 'under 1K', min: 0 },
] as const
export const layerOf = (fans: number): number => LAYERS.find((l) => fans >= l.min)!.id

export const FAMILY_OF: ReadonlyMap<string, string> = new Map(GENRES.map((g) => [g.name, g.area]))
export const FAMILIES: string[] = [...new Set(GENRES.map((g) => g.area))]

export interface IceTrack { artist?: string; contributingArtists?: string[]; genre?: string; playCount?: number; rating?: number }
export interface Member { name: string; songs: number; plays: number; stars: number; tags: Array<[string, number]> }
export interface Scope { name: string; family: string; genre?: string; members: Member[] }

/** Members of a scope = artists with songs tagged in it right now. `canon`
 *  is the app's artist identity (aliases, feat. folded) so one card = one artist. */
export function buildScope(tracks: IceTrack[], canon: (n: string) => string, family: string, genre?: string): Scope {
  const want = (g: string | undefined): boolean => !!g && (genre ? g === genre : FAMILY_OF.get(g) === family)
  const m = new Map<string, { songs: number; plays: number; stars: number; tags: Map<string, number> }>()
  for (const t of tracks) {
    if (!want(t.genre)) continue
    const names = new Set((t.contributingArtists?.length ? t.contributingArtists : [t.artist || '']).map((a) => canon(a || '')).filter(Boolean))
    for (const n of names) {
      const x = m.get(n) ?? { songs: 0, plays: 0, stars: 0, tags: new Map() }
      x.songs++; x.plays += Number(t.playCount) || 0; x.stars += (Number(t.rating) || 0) >= 4 ? 1 : 0
      x.tags.set(t.genre!, (x.tags.get(t.genre!) ?? 0) + 1)
      m.set(n, x)
    }
  }
  return {
    name: genre ?? family, family, genre,
    members: [...m.entries()].map(([name, x]) => ({ name, songs: x.songs, plays: x.plays, stars: x.stars, tags: [...x.tags.entries()].sort((a, b) => b[1] - a[1]) })),
  }
}

/** The genres of a family that have at least `min` artists, biggest first. */
export function familyGenres(tracks: IceTrack[], canon: (n: string) => string, family: string, min = 3): Scope[] {
  return GENRES.filter((g) => g.area === family).map((g) => buildScope(tracks, canon, family, g.name))
    .filter((s) => s.members.length >= min).sort((a, b) => b.members.length - a.members.length)
}

export interface Placed extends Member { fans: number; layer: number }
export interface IceStats { placed: Placed[]; byLayer: Placed[][]; unplaced: string[]; pctBelowTip: number; deepest?: Placed }

export function placeScope(scope: Scope, fans: Record<string, number | undefined>): IceStats {
  const placed: Placed[] = [], unplaced: string[] = []
  for (const m of scope.members) {
    const f = fans[m.name]
    if (typeof f === 'number') placed.push({ ...m, fans: f, layer: layerOf(f) }); else unplaced.push(m.name)
  }
  const byLayer: Placed[][] = LAYERS.map(() => [])
  for (const p of placed) byLayer[p.layer].push(p)
  for (const l of byLayer) l.sort((a, b) => (b.plays + b.stars * 3) - (a.plays + a.stars * 3) || b.fans - a.fans)
  const below = placed.filter((p) => p.layer > 0).length
  return {
    placed, byLayer, unplaced: unplaced.sort(),
    pctBelowTip: placed.length ? Math.round((below / placed.length) * 100) : 0,
    deepest: [...placed].sort((a, b) => a.fans - b.fans)[0],
  }
}

export interface Find { name: string; fans: number; via: string[] }

/** The scene he doesn't own yet: artists Deezer relates to two or more of
 *  this scope's artists, not anywhere in his library (by the same identity). */
export function sceneFinds(
  placed: Array<{ name: string; dz?: number }>,
  related: Record<number, Array<[string, number]>>,
  owned: (name: string) => boolean,
): Find[] {
  const m = new Map<string, Find>()
  for (const p of placed) {
    if (p.dz === undefined) continue
    for (const [name, fans] of related[p.dz] ?? []) {
      if (owned(name)) continue
      const k = name.toLowerCase()
      const e = m.get(k) ?? { name, fans, via: [] }
      if (!e.via.includes(p.name)) e.via.push(p.name)
      m.set(k, e)
    }
  }
  return [...m.values()].filter((f) => f.via.length >= 2).sort((a, b) => b.via.length - a.via.length || a.fans - b.fans)
}
