// Loads the desktop-exported library.json from the NAS, validates it,
// and hands back tracks + playlists. The desktop is the source of
// truth — mobile only reads.
//
// Phase 0: fetch a single JSON blob over HTTP (File Station download).
// Phase 1+ : delta sync, ETag/If-None-Match, partial track-art prefetch.

import type { LibrarySnapshot } from '@/types'
import { LIBRARY_SNAPSHOT_VERSION } from '@/types'
import type { SynologyClient } from '@/services/nas/synologyClient'

export interface LibraryFetchResult {
  ok: boolean
  snapshot?: LibrarySnapshot
  error?: string
}

export async function fetchLibrarySnapshot(
  client: SynologyClient,
): Promise<LibraryFetchResult> {
  const { libraryJsonPath } = client.config
  const url = client.webapiUrl('SYNO.FileStation.Download', 'download', {
    path: encodeURI(libraryJsonPath),
    mode: 'open',
  })
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    return { ok: false, error: `Network error: ${(err as Error).message}` }
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status} fetching library.json` }
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    return { ok: false, error: `Invalid JSON in library.json: ${(err as Error).message}` }
  }
  const snap = json as Partial<LibrarySnapshot>
  if (typeof snap.version !== 'number') {
    return { ok: false, error: 'library.json missing version field' }
  }
  if (snap.version > LIBRARY_SNAPSHOT_VERSION) {
    return {
      ok: false,
      error:
        `library.json was written by a newer desktop (v${snap.version}). ` +
        `Update JakeTunes Mobile to read it.`,
    }
  }
  if (!Array.isArray(snap.tracks) || !Array.isArray(snap.playlists)) {
    return { ok: false, error: 'library.json missing tracks or playlists arrays' }
  }
  return { ok: true, snapshot: snap as LibrarySnapshot }
}
