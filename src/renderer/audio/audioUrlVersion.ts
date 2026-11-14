/**
 * The `?v=` on a rewritten song's ipod-audio:// URL (2026-11-14).
 *
 * Chromium keeps a song's bytes in memory per URL. After a tag write has
 * rewritten a file, a reload of the SAME URL reads the old header from memory
 * and asks the disk only for the middle, which now comes from the new file at
 * the old file's offsets: PIPELINE_ERROR_DECODE, and a skip (measured in
 * Electron 30, PR #425; Jake's "Stalks (Greenpoint Mix)", 2026-11-14). A new
 * URL is a new load, read whole from the new file.
 *
 * Where the version comes from: the only moments this app rewrites a file
 * under itself are tag writes, and main already sends the renderer what each
 * one measured (the per-edit 'tag-writeback:file-changed' event and the
 * "Apply Overrides to Files…" result). Main stamps that with the file's
 * mtime-size (common/audio-file-version.ts), so no new round trip: the URL is
 * marked from the moment the write is done, and only the songs written this
 * run carry a marker. Every other URL stays exactly what it was, so nothing
 * Chromium holds for an unchanged file is thrown away. The map lives as long
 * as the renderer, which is as long as Chromium's memory of the old bytes.
 */
import { FILE_VERSION_SHAPE } from '../../common/audio-file-version.ts'

const versions = new Map<string, string>()

/** A tag write left this song's file at `version`. `path` is the library's colon path. */
export function noteFileVersion(path: string, version: string): void {
  if (!path || !FILE_VERSION_SHAPE.test(version)) return
  versions.set(path, version)
}

/** The tag writes main just measured, matched to the tracks by id. */
export function noteMeasuredVersions(
  tracks: ReadonlyArray<{ id: number; path?: string }>,
  measured: ReadonlyArray<{ id: number; fileVersion?: string }>,
): void {
  const want = new Map(measured.filter((m) => m.fileVersion).map((m) => [m.id, m.fileVersion!]))
  if (!want.size) return
  for (const t of tracks) {
    const v = want.get(t.id)
    if (v && t.path) noteFileVersion(t.path, v)
  }
}

/** `url` with this song's `?v=`, when a tag write has rewritten its file this run. */
export function withFileVersion(url: string, path: string): string {
  const v = versions.get(path)
  return v ? `${url}?v=${v}` : url
}

/** Tests only. */
export function _resetFileVersions(): void { versions.clear() }
