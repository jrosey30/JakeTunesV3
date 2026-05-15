// Library snapshot exporter — writes the desktop's library state to
// disk in the wire format JakeTunes Mobile reads.
//
// ⚠️ TWIN: mobile/src/types.ts (LibrarySnapshot, LIBRARY_SNAPSHOT_VERSION).
// The shape AND the version constant must stay in sync across both
// sides. Mobile refuses snapshots with a higher version than it
// understands; desktop must bump this constant when the shape
// changes, in the same commit as the corresponding mobile reader
// update. (Citation: docs/postmortems/2026-04-26-ipod-songcount-counter.md
// — the 0x64 mediaKind incident: a writer silently re-purposed a
// field the consumer treated as a classifier and filtered out 150
// tracks. Schema versioning is the prophylactic.)
//
// Path format contract:
//   - Desktop's track.path is COLON-separated, iPod-style:
//       ":iPod_Control:Music:F12:ABCD.m4a"
//   - The exporter writes paths SLASH-separated, leading-slash
//     stripped, so they're directly appendable to a NAS prefix:
//       "iPod_Control/Music/F12/ABCD.m4a"
//   - Mobile's services/nas/streamUrl.ts prepends its configured
//     libraryRootPath (e.g. "/music") to produce the absolute NAS
//     path used by Audio Station / WebDAV / File Station.
//
// The conversion happens HERE, at the export boundary — mobile
// doesn't need to know the desktop stores paths colon-separated.

import { writeFile, rename, mkdir } from 'fs/promises'
import { dirname } from 'path'

// Bump this when the snapshot shape changes. Update mobile/src/types.ts
// LIBRARY_SNAPSHOT_VERSION in the same commit, and update the mobile
// reader to handle the new shape, before shipping the desktop change.
export const LIBRARY_SNAPSHOT_VERSION = 1

export interface SnapshotTrack {
  id: number
  title: string
  // Slash-separated, NO leading slash. See contract above.
  path: string
  album: string
  artist: string
  albumArtist: string
  genre: string
  year: number | string
  duration: number       // ms — see CLAUDE.md "Unit contracts"
  dateAdded: string
  playCount: number
  trackNumber: number | string
  trackCount: number | string
  discNumber: number | string
  discCount: number | string
  fileSize: number
  rating: number
  audioFingerprint?: string
  audioMissing?: boolean
  lastPlayedAt?: number
  skipCount?: number
  bpm?: number
  keyRoot?: string
  keyMode?: 'major' | 'minor'
  camelotKey?: string
  audioAnalysisAt?: number
}

export interface SnapshotPlaylist {
  id: string
  name: string
  trackIds: number[]
  commentary?: string
}

export interface LibrarySnapshot {
  version: number
  exportedAt: string
  // The libraryRootPath the desktop assumes mobile will prepend.
  // Optional — if empty, mobile uses its own configured prefix
  // unconditionally. Set this when the desktop knows where the user
  // intends the music share to live (e.g. when we add an explicit
  // "NAS music root" preference field).
  libraryRootPath: string
  tracks: SnapshotTrack[]
  playlists: SnapshotPlaylist[]
}

// Convert a JakeTunes colon-path to the slash-relative path mobile
// expects. Idempotent: if the input is already slash-separated (e.g.
// from a future writer that bypasses the colon convention), the
// result is unchanged except for the leading-slash trim.
export function colonPathToSlashRelative(colonPath: string): string {
  if (!colonPath) return ''
  // Replace colons with slashes, then strip any leading slashes that
  // either were originally there or got introduced by a leading colon.
  const slashed = colonPath.replace(/:/g, '/')
  return slashed.replace(/^\/+/, '')
}

interface SnapshotInput {
  tracks: SnapshotTrack[]
  playlists: SnapshotPlaylist[]
  libraryRootPath?: string
}

// Build the on-the-wire snapshot. Pure function; no I/O. Exposed for
// unit-testing the path normalization without touching disk.
export function buildLibrarySnapshot(input: SnapshotInput): LibrarySnapshot {
  const tracks: SnapshotTrack[] = input.tracks.map((t) => ({
    ...t,
    path: colonPathToSlashRelative(t.path),
  }))
  return {
    version: LIBRARY_SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    libraryRootPath: input.libraryRootPath ?? '',
    tracks,
    playlists: input.playlists,
  }
}

// Write the snapshot to disk atomically (tmp + rename), per the same
// rule save-library uses. Mobile may be reading concurrently from a
// synced copy; a half-written file would fail JSON.parse on the
// mobile side and surface as "library snapshot is corrupt." Atomic
// rename means readers see either the old file or the new one,
// never a mid-write slice.
export async function writeLibrarySnapshot(
  destPath: string,
  input: SnapshotInput,
): Promise<{ ok: true; trackCount: number; bytes: number } | { ok: false; error: string }> {
  try {
    const snap = buildLibrarySnapshot(input)
    const json = JSON.stringify(snap, null, 2)
    await mkdir(dirname(destPath), { recursive: true })
    const tmp = `${destPath}.partial.json`
    await writeFile(tmp, json, 'utf-8')
    await rename(tmp, destPath)
    return { ok: true, trackCount: snap.tracks.length, bytes: Buffer.byteLength(json, 'utf-8') }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
