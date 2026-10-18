/**
 * An artist's albums, grouped by what each release IS (Jake, 2026-10-18:
 * "do better at grouping what is a compilation, studio release, live
 * concert, single and EP within an artist's discography").
 *
 * Two halves, both pure:
 *  - collectAlbumFacts: library rows → one ReleaseFacts per album, keyed the
 *    way release-kinds.json is. The desktop resolver (main) and the artist
 *    page (renderer) both build facts HERE, so the page's title/shape
 *    fallback is exactly what the resolver stores when MusicBrainz misses.
 *  - groupByReleaseKind: items → sections in RELEASE_KIND_ORDER, labelled
 *    RELEASE_KIND_LABEL, empty sections dropped, input order kept inside
 *    each section.
 *
 * The rules themselves live in release-kind.ts (twinned with the phone).
 */
import {
  classifyRelease, releaseKey, RELEASE_KIND_ORDER, RELEASE_KIND_LABEL,
  type ReleaseKind, type ReleaseFacts, type ReleaseKindsFile,
} from './release-kind.ts'

/** The fields of a library row (Track) an album's facts come from. */
export interface AlbumRow {
  album?: string | null
  artist?: string | null
  albumArtist?: string | null
  trackCount?: number | string | null
  duration?: number | string | null
}

export interface AlbumFacts extends ReleaseFacts {
  /** release-kinds.json key: `${fold(albumArtist || artist)}|${fold(album)}`. */
  key: string
  /** The album artist the key was built from (albumArtist, else artist). */
  artist: string
}

export type StoredReleaseKinds = ReleaseKindsFile['albums']

/** The album a row belongs to: (albumArtist || artist, album). Null when either is blank. */
export function albumIdentity(row: AlbumRow): { artist: string; album: string } | null {
  const album = String(row.album ?? '').trim()
  const artist = (String(row.albumArtist ?? '').trim() || String(row.artist ?? '').trim())
  if (!album || !artist) return null
  return { artist, album }
}

export function albumKeyOf(row: AlbumRow, fold: (s: string) => string): string | null {
  const id = albumIdentity(row)
  return id ? releaseKey(fold, id.artist, id.album) : null
}

/**
 * One fact sheet per album. declaredTrackCount = the largest library
 * trackCount on any of its rows; ownedDurationsMs = every row's duration.
 * The first row seen names the album.
 */
export function collectAlbumFacts(rows: Iterable<AlbumRow>, fold: (s: string) => string): Map<string, AlbumFacts> {
  const out = new Map<string, AlbumFacts>()
  for (const row of rows) {
    const id = albumIdentity(row)
    if (!id) continue
    const key = releaseKey(fold, id.artist, id.album)
    if (!key || key === '|') continue
    let f = out.get(key)
    if (!f) {
      f = { key, artist: id.artist, album: id.album, albumArtist: id.artist, declaredTrackCount: 0, ownedDurationsMs: [] }
      out.set(key, f)
    }
    const n = Number(row.trackCount) || 0
    if (n > (f.declaredTrackCount || 0)) f.declaredTrackCount = n
    ;(f.ownedDurationsMs as number[]).push(Number(row.duration) || 0)
  }
  return out
}

function isKind(k: unknown): k is ReleaseKind {
  return typeof k === 'string' && (RELEASE_KIND_ORDER as readonly string[]).includes(k)
}

/**
 * The kind an album shows under: the stored answer when release-kinds.json
 * has one, otherwise the rulebook on its facts with no MusicBrainz (title,
 * then shape). Rows of one album can disagree on albumArtist, so every row's
 * key is tried before falling back.
 */
export function releaseKindForRows(
  rows: readonly AlbumRow[],
  stored: StoredReleaseKinds | null | undefined,
  facts: ReadonlyMap<string, AlbumFacts>,
  fold: (s: string) => string,
): ReleaseKind {
  const keys: string[] = []
  for (const r of rows) {
    const k = albumKeyOf(r, fold)
    if (k && !keys.includes(k)) keys.push(k)
  }
  for (const k of keys) {
    const s = stored?.[k]
    if (s && isKind(s.kind)) return s.kind
  }
  for (const k of keys) {
    const f = facts.get(k)
    if (f) return classifyRelease({ ...f, mb: null }).kind
  }
  // Rows not in the facts index (a stale index mid-import): their own facts.
  const own = collectAlbumFacts(rows, fold).values().next().value as AlbumFacts | undefined
  return own ? classifyRelease({ ...own, mb: null }).kind : 'album'
}

export interface ReleaseSection<T> { kind: ReleaseKind; label: string; items: T[] }

/** Sections in RELEASE_KIND_ORDER; empty ones are left out; input order is kept inside each. */
export function groupByReleaseKind<T>(items: readonly T[], kindOf: (item: T) => ReleaseKind): ReleaseSection<T>[] {
  const buckets = new Map<ReleaseKind, T[]>()
  for (const item of items) {
    const k = kindOf(item)
    const kind: ReleaseKind = isKind(k) ? k : 'album'
    const b = buckets.get(kind)
    if (b) b.push(item)
    else buckets.set(kind, [item])
  }
  return RELEASE_KIND_ORDER
    .filter((k) => buckets.has(k))
    .map((k) => ({ kind: k, label: RELEASE_KIND_LABEL[k], items: buckets.get(k) as T[] }))
}

/** Position of a kind in RELEASE_KIND_ORDER (for sorting flat lists by section). */
export function releaseKindRank(kind: ReleaseKind): number {
  const i = RELEASE_KIND_ORDER.indexOf(kind)
  return i < 0 ? 0 : i
}
