/**
 * The library, indexed by artist — built once per library, not once per page.
 *
 * 2026-11-10 (Jake on the artist page: "slow to appear"). Every time the page
 * opened it walked all 13,498 tracks four times before its first frame: twice
 * asking "is this track by this artist?" (24–38 ms each — the alias rules run
 * per track), once collecting every artist the library owns (13–29 ms), once
 * collecting every album's facts (6–8 ms). About 90–130 ms of script before
 * anything could paint, on every mount.
 *
 * Those answers depend on the library and the alias map, not on which artist
 * is open. So they are built once here, keyed on the `tracks` array itself
 * (the reducer hands out a new array whenever the library changes, so a
 * changed library can never be answered from an old index) and on the alias
 * version, and warmed in idle time after the library loads or changes
 * (prewarmArtistLibraryIndex) so that opening an artist is a map lookup.
 *
 * Pure of React and of the DOM: node --test runs it on a real-shaped library
 * (__tests__/artist-library-index.test.ts) and scripts/bench-artist-page.mjs
 * times it against the old passes.
 */
import type { Track } from './types.ts'
import { artistIdentityKey, canonicalArtist, getAliasVersion } from './utils/artistAlias.ts'
import { albumKeyFromStrings } from './utils/albumKey.ts'
import { collectAlbumFacts, type AlbumFacts } from '../common/release-sections.ts'

export interface ArtistLibraryIndex {
  aliasVersion: number
  /** Identity key → every track that artist is credited on (as the artist or a contributor), in library order. */
  byArtist: Map<string, Track[]>
  /** Identity keys of every track's own artist: "is this artist in the library?" */
  ownedArtistKeys: Set<string>
  trackById: Map<number, Track>
  /** Every distinct artist string in the library, as tagged. */
  names: string[]
}

const indexes = new WeakMap<readonly Track[], ArtistLibraryIndex>()

function build(tracks: readonly Track[], aliasVersion: number): ArtistLibraryIndex {
  // The alias rules cost the same for every track of one artist: ask once per
  // distinct string (about 2,350 of them), not once per track.
  const keyOf = new Map<string, string>()
  const key = (name: string): string => {
    let k = keyOf.get(name)
    if (k === undefined) { k = artistIdentityKey(name); keyOf.set(name, k) }
    return k
  }
  const ownedKeyOf = new Map<string, string>()
  const ownedKey = (name: string): string => {
    let k = ownedKeyOf.get(name)
    if (k === undefined) { k = artistIdentityKey(canonicalArtist(name)); ownedKeyOf.set(name, k) }
    return k
  }
  const byArtist = new Map<string, Track[]>()
  const ownedArtistKeys = new Set<string>()
  const trackById = new Map<number, Track>()
  const add = (k: string, t: Track): void => {
    const list = byArtist.get(k)
    if (!list) byArtist.set(k, [t])
    else if (list[list.length - 1] !== t) list.push(t)   // credited twice on one track: once
  }
  for (const t of tracks) {
    trackById.set(t.id, t)
    const own = key(t.artist || '')
    // As the page asks it: artistIdentityKey(canonicalArtist(name)) on both sides.
    if ((t.artist || '').trim()) ownedArtistKeys.add(ownedKey((t.artist || '').trim()))
    if (own) add(own, t)
    const others = t.contributingArtists
    if (others) for (const x of others) { const k = key(x || ''); if (k && k !== own) add(k, t) }
  }
  return { aliasVersion, byArtist, ownedArtistKeys, trackById, names: [...keyOf.keys()].filter(Boolean) }
}

/** The index for this library (built on first ask, then remembered until the library or the alias map changes). */
export function artistLibraryIndex(tracks: readonly Track[]): ArtistLibraryIndex {
  const version = getAliasVersion()
  const hit = indexes.get(tracks)
  if (hit && hit.aliasVersion === version) return hit
  const made = build(tracks, version)
  indexes.set(tracks, made)
  return made
}

const NONE: Track[] = []

/**
 * Every track of this artist, in library order: the same set
 * `tracks.filter(t => isSameArtist(t.artist, name) || t.contributingArtists.some(x => isSameArtist(x, name)))`
 * returns, without walking the library.
 */
export function tracksOfArtist(tracks: readonly Track[], canonicalName: string): Track[] {
  const k = artistIdentityKey(canonicalName)
  return (k && artistLibraryIndex(tracks).byArtist.get(k)) || NONE
}

// ── per-library answers that do not depend on the alias map ──

const facts = new WeakMap<readonly Track[], Map<string, AlbumFacts>>()
/** collectAlbumFacts over the whole library, once per library (`fold` is the page's foldName). */
export function libraryAlbumFacts(tracks: readonly Track[], fold: (s: string) => string): Map<string, AlbumFacts> {
  let f = facts.get(tracks)
  if (!f) { f = collectAlbumFacts(tracks, fold); facts.set(tracks, f) }
  return f
}

const idSets = new WeakMap<readonly Track[], Set<number>>()
/** The ids in this list, once per list (the regular-library projection is a second array). */
export function trackIdSet(tracks: readonly Track[]): Set<number> {
  let s = idSets.get(tracks)
  if (!s) { s = new Set(tracks.map((t) => t.id)); idSets.set(tracks, s) }
  return s
}

const albumTitles = new WeakMap<readonly Track[], Map<string, string>>()
/** An album's title as tagged, from its (lowercased) key: the first owning track's, as a scan would find it. */
export function albumTitleForKey(tracks: readonly Track[], albumKey: string): string | null {
  let m = albumTitles.get(tracks)
  if (!m) {
    m = new Map()
    for (const t of tracks) {
      const k = albumKeyFromStrings(t.albumArtist || t.artist, t.album)
      if (!m.has(k)) m.set(k, t.album || '')
    }
    albumTitles.set(tracks, m)
  }
  return m.get(albumKey) || null
}

/**
 * Build the index for this library when the app is next idle, so the first
 * artist page after a launch (or after the library changed) does not pay for
 * it. Returns a cancel for the effect that scheduled it.
 */
export function prewarmArtistLibraryIndex(
  tracks: readonly Track[],
  fold: (s: string) => string,
  onReady?: (index: ArtistLibraryIndex) => void,
): () => void {
  if (tracks.length === 0) return () => {}
  const run = (): void => {
    const index = artistLibraryIndex(tracks)
    libraryAlbumFacts(tracks, fold)
    onReady?.(index)
  }
  const w = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(run, { timeout: 2000 })
    return () => w.cancelIdleCallback?.(id)
  }
  const id = setTimeout(run, 200)
  return () => clearTimeout(id)
}
