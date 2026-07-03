// V5 Live Concert Mode — the declare orchestration, shared by
// AlbumDetailView's button and AlbumsView's context menu.
//
// declare = merge (main process) → enqueue the merged file through the
// EXISTING import queue (id minting, dupe guard, ALAC play-cache prewarm,
// imports-panel UI, App.tsx's onTrackImported → ADD_IMPORTED_TRACKS all
// come free) → register the sidecar entry with the minted track id.
//
// Correlation note: onTrackImported doesn't carry srcPath, so the merged
// track is matched by the exact title+album WE stamped into the file's
// tags one step earlier. That's text matching, but it's ADDITIVE
// (registering a sidecar row) — the id captured here becomes the identity
// anchor every later DESTRUCTIVE step gates on, per the project's
// identity-not-text rule for irreversible ops.

import type { Track, LiveSetEntry } from './types'
import { enqueueFiles, onTrackImported } from './importQueue'
import { registerLiveSet } from './liveSets'
import { verifyLiveSetCompleteness } from './utils/liveSetCompleteness'

export interface DeclareAlbumInput {
  albumKey: string
  name: string
  artist: string
  genre?: string
  year?: string | number
  tracks: Track[]   // the album's tracks in play order (sortAlbumTracks order)
}

// One declare at a time — the merge is CPU/disk heavy and the scratch dir
// is single-tenant (each run wipes it). The UI disables the affordance
// while this is set.
let declareInFlight = false
export function isDeclareInFlight(): boolean {
  return declareInFlight
}

const IMPORT_LANDING_TIMEOUT_MS = 5 * 60 * 1000

export async function declareLiveSet(album: DeclareAlbumInput, opts?: { confirmedComplete?: boolean }): Promise<LiveSetEntry> {
  if (declareInFlight) throw new Error('another live set is already being merged')
  // Jake's rule: Live Mode IF AND ONLY IF the library holds the COMPLETE
  // album. This is the hard gate — both UI surfaces route through here,
  // so a future affordance can't skip it. Two tiers:
  //   incomplete            → always refused (gaps/dupes/count mismatch)
  //   complete, unverified  → the files can't prove the TOTAL (no
  //                           trackCount tags, e.g. vinyl-style rips);
  //                           requires Jake's explicit per-album confirm
  //                           (opts.confirmedComplete), collected by the
  //                           UI's ConfirmDialog — he is the canonical
  //                           source when the files aren't.
  const completeness = verifyLiveSetCompleteness(album.tracks)
  if (!completeness.complete) {
    throw new Error(`incomplete album — ${completeness.reason}`)
  }
  if (!completeness.verifiedTotal && !opts?.confirmedComplete) {
    throw new Error('the files cannot confirm the album\'s total track count — confirm completeness on the album page first')
  }
  declareInFlight = true
  try {
    const res = await window.electronAPI.liveSetMerge(
      album.tracks.map(t => ({
        id: t.id,
        title: t.title || '',
        artist: t.artist || '',
        path: String(t.path || ''),
        durationMs: Number(t.duration) || 0,
      })),
      { name: album.name, artist: album.artist, genre: album.genre, year: album.year },
    )
    if (!res.ok || !res.mergedPath || !res.cues) {
      throw new Error(res.error || 'merge failed')
    }
    const mergedPath = res.mergedPath
    const cues = res.cues
    const totalDurationMs = res.totalDurationMs || cues.reduce((s, c) => s + c.durationMs, 0)

    // Expected tag values — must mirror the tags written in
    // src/main/live-set-merge.ts stage 3.
    const expectTitle = `${album.name} — Full Set`
    const expectAlbum = `${album.name} (Live Set)`

    const landed = new Promise<Track>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        unsub()
        reject(new Error('merged set import did not complete in time'))
      }, IMPORT_LANDING_TIMEOUT_MS)
      const unsub = onTrackImported((t) => {
        if ((t.title || '') === expectTitle && (t.album || '') === expectAlbum) {
          window.clearTimeout(timer)
          unsub()
          resolve(t)
        }
      })
    })

    const added = await enqueueFiles([mergedPath], 'alac')
    if (added === 0) {
      throw new Error('merged file could not be enqueued for import')
    }
    const mergedTrack = await landed

    const entry: LiveSetEntry = {
      mergedTrackId: mergedTrack.id,
      cues,
      totalDurationMs,
      createdAt: new Date().toISOString(),
    }
    await registerLiveSet(album.albumKey, entry)

    // The import queue COPIED the file into the library farm; the scratch
    // original is now redundant. Path-gated main-side (scratch dir only).
    void window.electronAPI.liveSetCleanup(mergedPath)

    return entry
  } finally {
    declareInFlight = false
  }
}
