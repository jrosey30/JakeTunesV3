/**
 * A song file's version, for the `?v=` on its ipod-audio:// URL (2026-11-14).
 *
 * Chromium keeps a song's bytes in memory per URL, across media elements: a
 * reload of the same URL reads the OLD header from memory and asks the disk
 * only for the middle (measured in Electron 30; PR #425). After a tag write
 * has rewritten the file, those middles come from the new file at the old
 * file's offsets. So a rewritten file gets a new URL: `?v=<mtime-size>`.
 *
 * One function for both sides: main stamps it on what a tag write measured
 * (library-file-sizes.ts) and the load hold keys by it (audio-load-hold.ts);
 * the renderer puts it on the URL (renderer/audio/audioUrlVersion.ts).
 */
export function fileVersion(st: { mtimeMs: number; size: number }): string {
  return `${Math.round(st.mtimeMs).toString(36)}-${st.size.toString(36)}`
}

/** What a `?v=` may be: what fileVersion makes, nothing else. */
export const FILE_VERSION_SHAPE = /^[0-9a-z-]{1,40}$/
