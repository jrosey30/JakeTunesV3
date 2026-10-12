/**
 * Provenance sidecars for artwork the app fetched from the web.
 *
 * Every cover in the artwork cache can carry a `<hash>.meta.json` saying
 * where its bytes came from. extractAndSaveEmbeddedArtwork writes
 * `source: 'embedded'` and set-custom-artwork writes `'user-custom'`, but
 * fetch-album-art wrote nothing. A forced re-fetch replaced the jpg and
 * left the old `embedded` sidecar beside it, so the cache vouched for a
 * downloaded cover as the original (45 entries by 2026-10-12). The cover
 * vault (scripts/cover-vault.mjs) trusts only `embedded`; this keeps that
 * word true.
 *
 * Kept free of electron imports so tests can load it.
 */

export type ArtworkFetchProvider = 'coverartarchive' | 'deezer'

export interface FetchedArtworkSidecar {
  artist: string
  album: string
  key: string
  source: 'fetched'
  provider: ArtworkFetchProvider
  url: string
  bytes: number
  importedAt: string
}

export function fetchedArtworkSidecar(
  artist: string,
  album: string,
  provider: ArtworkFetchProvider,
  url: string,
  bytes: number,
  at: Date = new Date(),
): FetchedArtworkSidecar {
  const cleanArtist = (artist || '').trim()
  const cleanAlbum = (album || '').trim()
  return {
    artist: cleanArtist,
    album: cleanAlbum,
    // ⚠️ TWIN: artwork-engine.ts artworkHash builds the same key.
    key: `${cleanArtist.toLowerCase()}|||${cleanAlbum.toLowerCase()}`,
    source: 'fetched',
    provider,
    url,
    bytes,
    importedAt: at.toISOString(),
  }
}
