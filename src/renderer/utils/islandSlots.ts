import type { Album } from './albumGroups'
import { islandAlbumKey, primaryArtistOf, type IslandAlbum, type IslandSlot } from '../../common/synced-picks.ts'

/// Island slot ↔ library album (2026-10-18).
///
/// What the desktop WRITES for an album is its primary artist (albumArtist,
/// else the track artist before " & " / " feat. " …) — the identity the phone
/// and the backend key albums by (`${primaryArtist}|||${album}`), so one record
/// is one slot on both devices and the backend's duplicate rule sees it once.
///
/// What it ACCEPTS when matching a slot to a library album is either form:
/// that primary artist, or the desktop's own grouping artist (albumArtist ||
/// artist). A slot is never "missing" just because the artist spelling
/// differs — and a slot that truly isn't in this library is drawn faded and
/// KEPT: clearing it here would delete the pick on the phone too.

export function islandPickOf(album: Album): IslandAlbum {
  return {
    artist: primaryArtistOf(album.tracks[0] ?? { artist: album.artist }),
    album: album.name.trim(),
  }
}

/** Every identity a slot may carry for this album (primary form first). */
export function islandKeysOf(album: Album): string[] {
  const primary = islandAlbumKey(islandPickOf(album))
  const grouping = islandAlbumKey({ artist: album.artist, album: album.name })
  return primary === grouping ? [primary] : [primary, grouping]
}

/** Slot identity → library album, under both artist forms. */
export function indexAlbumsForIsland(albums: readonly Album[]): Map<string, Album> {
  const m = new Map<string, Album>()
  for (const a of albums) for (const k of islandKeysOf(a)) if (!m.has(k)) m.set(k, a)
  return m
}

/** Which slot holds this album (either artist form); −1 = none. */
export function slotOfAlbum(values: readonly IslandSlot[], album: Album): number {
  const keys = new Set(islandKeysOf(album))
  return values.findIndex((v) => v !== null && keys.has(islandAlbumKey(v)))
}
