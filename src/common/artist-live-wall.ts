/**
 * The artist page's Live section as a poster wall (Jake, 2026-10-18, on the
 * Geese page: "live albums doesnt look right here … needs to be displayed
 * via poster presentation").
 *
 * The wall holds one tile per show:
 *  - every DECLARED concert of the artist (live-sets.json) — its poster
 *    opens the concert page;
 *  - every live ALBUM that is not a declared concert (release kind 'live')
 *    — its cover opens the album page.
 * A declared concert's tracks never show up as an album as well: they are
 * projected out of the regular library already, and a song that was
 * promoted back into it is folded into its show here (withoutConcertTracks).
 *
 * Newest first, like every other section of the page. Pure.
 */
import { RELEASE_KIND_LABEL, RELEASE_KIND_ORDER } from './release-kind.ts'
import type { ReleaseSection } from './release-sections.ts'
import { firstNightMs, parseConcertMeta } from './concert-meta.ts'

/** The fields of a declared concert the wall orders by (see DeclaredConcert). */
export interface WallConcertLike {
  albumKey: string
  band: string
  show: string
  when: number
  year: number
}

/** The fields of an owned album group the wall needs. */
export interface WallAlbumLike {
  name: string
  year?: number | string | null
  tracks: ReadonlyArray<{ title?: string | null }>
}

export type LiveWallTile<C, A> =
  | { type: 'concert'; key: string; concert: C; when: number }
  | { type: 'album'; key: string; album: A; venue?: string; date?: string; when: number }

/**
 * Album groups with every concert-owned track taken out; a group left
 * empty is dropped. Untouched groups are returned as the same object.
 */
export function withoutConcertTracks<G extends { tracks: ReadonlyArray<{ id: number }> }>(
  groups: readonly G[],
  concertIds: ReadonlySet<number>,
): G[] {
  if (concertIds.size === 0) return groups.slice()
  const out: G[] = []
  for (const g of groups) {
    const kept = g.tracks.filter((t) => !concertIds.has(t.id))
    if (kept.length === g.tracks.length) out.push(g)
    else if (kept.length > 0) out.push({ ...g, tracks: kept })
  }
  return out
}

/**
 * Which persona (raw artist tag) each concert sits under: the persona with
 * the band's exact tag, else the first one — the page sorts the artist's
 * main identity first. No personas → no assignments.
 */
export function concertsByPersona<C extends { band: string }>(
  concerts: readonly C[],
  personaNames: readonly string[],
): Map<string, C[]> {
  const out = new Map<string, C[]>()
  if (personaNames.length === 0) return out
  const byTag = new Map<string, string>()
  for (const name of personaNames) {
    const k = name.trim().toLowerCase()
    if (!byTag.has(k)) byTag.set(k, name)
  }
  for (const c of concerts) {
    const persona = byTag.get(c.band.trim().toLowerCase()) ?? personaNames[0]
    const list = out.get(persona)
    if (list) list.push(c)
    else out.set(persona, [c])
  }
  return out
}

function yearMs(year: unknown): number {
  const y = Number(year)
  return y > 0 && y < 10000 ? Date.UTC(y, 0, 1) : Number.NEGATIVE_INFINITY
}

/** Grounded venue / date for a live album: its own title first, then its first song's tags. */
export function liveAlbumMeta(album: WallAlbumLike): { venue?: string; date?: string } {
  const own = parseConcertMeta(album.name, album.name)
  if (own.venue || own.date) return own
  return parseConcertMeta(album.name, String(album.tracks[0]?.title || ''))
}

/** Concerts + live albums → one tile per show, newest first; undated last. */
export function buildLiveWall<C extends WallConcertLike, A extends WallAlbumLike>(
  concerts: readonly C[],
  liveAlbums: readonly A[],
): LiveWallTile<C, A>[] {
  const tiles: LiveWallTile<C, A>[] = []
  for (const c of concerts) {
    const when = Number.isFinite(c.when) ? c.when : yearMs(c.year)
    tiles.push({ type: 'concert', key: `concert:${c.albumKey}`, concert: c, when })
  }
  for (const a of liveAlbums) {
    const { venue, date } = liveAlbumMeta(a)
    const night = firstNightMs(date)
    const when = Number.isFinite(night) ? night : yearMs(a.year)
    tiles.push({ type: 'album', key: `album:${a.name.toLowerCase()}`, album: a, venue, date, when })
  }
  const title = (t: LiveWallTile<C, A>) => (t.type === 'concert' ? t.concert.show : t.album.name)
  return tiles.sort((x, y) =>
    (y.when - x.when || 0)
    || (x.type === y.type ? 0 : x.type === 'concert' ? -1 : 1)
    || title(x).localeCompare(title(y)))
}

export type ArtistSection<A, C> = ReleaseSection<A> & { wall?: LiveWallTile<C, A>[] }

/**
 * The artist page's sections with the Live one turned into the wall: its
 * live albums plus the persona's declared concerts. A persona with
 * concerts but no live album gets a Live section in its usual place.
 */
export function withLiveWall<A extends WallAlbumLike, C extends WallConcertLike>(
  sections: readonly ReleaseSection<A>[],
  concerts: readonly C[],
): ArtistSection<A, C>[] {
  const live = sections.find((s) => s.kind === 'live')
  const wall = buildLiveWall(concerts, live?.items ?? [])
  if (wall.length === 0) return sections.slice()
  const out: ArtistSection<A, C>[] = sections.filter((s) => s.kind !== 'live')
  const liveSection: ArtistSection<A, C> = { kind: 'live', label: RELEASE_KIND_LABEL.live, items: live?.items ?? [], wall }
  const rank = (k: string) => RELEASE_KIND_ORDER.indexOf(k as (typeof RELEASE_KIND_ORDER)[number])
  const at = out.findIndex((s) => rank(s.kind) > rank('live'))
  if (at < 0) out.push(liveSection)
  else out.splice(at, 0, liveSection)
  return out
}
