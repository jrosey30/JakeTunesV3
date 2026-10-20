/**
 * Get Info's three handlers — save the edits, fetch artwork, set custom
 * artwork — as the Songs view has always run them (moved here from
 * SongsView, 2026-10-20, so the Home's song menu opens the same Get Info
 * sheet with the same save path instead of a second copy).
 *
 * Usage: const { onSave, onFetchArt, onSetCustomArt } = useGetInfoHandlers()
 * → <GetInfoModal onSave={onSave} onFetchArt={onFetchArt} onSetCustomArt={onSetCustomArt} …/>
 */
import { useCallback } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { clearArtworkNegativeCache } from '../utils/artworkLookup'
import { setNotice } from '../activity'

export function useGetInfoHandlers(): {
  onSave: (updates: { id: number; field: string; value: string }[]) => Promise<void>
  onFetchArt: (artist: string, album: string, force?: boolean) => Promise<{ key: string; hash: string } | null>
  onSetCustomArt: (artist: string, album: string, imagePath: string) => Promise<{ key: string; hash: string } | null>
} {
  const { state: lib, dispatch: libDispatch } = useLibrary()

  // Save metadata edits from Get Info modal.
  // 4.4.5: we now snapshot each track's PRE-EDIT fingerprint and pass
  // it with every override save. The fingerprint is title|artist|
  // duration computed from the track AS IT WAS BEFORE the user's
  // edits — so on the next library re-parse, the load-time validator
  // can confirm the override still applies to the correct track.
  // Without this snapshot, the post-edit dispatch flips the track's
  // in-memory state, the next save would compute a different
  // fingerprint, and the safeguard logic in main would treat
  // consecutive saves as different identities.
  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      // 4.5.0-67 — save-first ordering for artwork-affecting edits.
      // OLD order: dispatch UPDATE_TRACKS → re-render with new key →
      // requestArtworkResolution(newKey) fires → main's migration hasn't
      // run yet → returns null → renderer caches 60s negative → album
      // tile stays blank until that cache expires even after main
      // completes the migration.
      // NEW order: snapshot old (artist, album), await all saves
      // (migration runs inside save-metadata-override), derive new
      // (artist, album), explicitly clear the negative cache for those
      // keys, THEN dispatch UPDATE_TRACKS. The re-render now triggers
      // a fresh resolveArtwork IPC that finds the migrated entry.
      const fpById = new Map<number, string>()
      const oldArtAlbumById = new Map<number, { artist: string; album: string }>()
      for (const u of updates) {
        if (fpById.has(u.id)) continue
        const t = lib.tracks.find(tr => tr.id === u.id)
        if (!t) continue
        fpById.set(u.id, `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`)
        oldArtAlbumById.set(u.id, { artist: t.artist || '', album: t.album || '' })
      }
      for (const u of updates) {
        await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value, fpById.get(u.id))
      }
      const touchesArtwork = updates.some(u => u.field === 'artist' || u.field === 'album')
      if (touchesArtwork) {
        const newArtAlbumById = new Map<number, { artist: string; album: string }>()
        for (const [id, old] of oldArtAlbumById) newArtAlbumById.set(id, { ...old })
        for (const u of updates) {
          const cur = newArtAlbumById.get(u.id)
          if (!cur) continue
          if (u.field === 'artist') cur.artist = u.value
          else if (u.field === 'album') cur.album = u.value
        }
        for (const v of newArtAlbumById.values()) {
          clearArtworkNegativeCache(v.artist, v.album)
        }
      }
      libDispatch({ type: 'UPDATE_TRACKS', updates })
    },
    [libDispatch, lib.tracks]
  )

  // Fetch artwork for a track (called from Get Info modal)
  const handleFetchArt = useCallback(
    async (artist: string, album: string, force?: boolean): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.fetchAlbumArt(artist, album, force)
      if (result.ok && result.key && result.hash) {
        libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      return null
    },
    [libDispatch]
  )

  const handleSetCustomArt = useCallback(
    async (artist: string, album: string, imagePath: string): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.setCustomArtwork(artist, album, imagePath)
      if (result.ok && result.key && result.hash) {
        libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      // 4.4.12: surface failure (usually sips conversion) so the user
      // doesn't think the art stuck just because the Get Info preview
      // still shows it from localArtHash.
      setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
      return null
    },
    [libDispatch]
  )

  return { onSave: handleGetInfoSave, onFetchArt: handleFetchArt, onSetCustomArt: handleSetCustomArt }
}
