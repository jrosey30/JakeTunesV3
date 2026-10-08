/**
 * Library track path → ipod-audio:// URL. Library paths are stored
 * iPod-style (":iPod_Control:Music:F39:x.m4a") relative to the music root;
 * the protocol handler serves ABSOLUTE paths and refuses anything else.
 *
 * 2026-09-27: the record shop's player skipped this conversion, every
 * request was refused, and its error handler walked the whole library
 * (34,546 refusals in 13 seconds on 9/21) — the shop never played a note.
 * Same conversion as useAudio's ipodPathToAudioURL and DJView's absPathFor.
 */
export function libraryAudioUrl(musicRoot: string, path: string): string | null {
  const p = String(path || '')
  if (!p) return null
  if (p.startsWith('/')) return 'ipod-audio://' + encodeURIComponent(p)
  if (!musicRoot) return null            // root not known yet: never send a relative path
  return 'ipod-audio://' + encodeURIComponent(musicRoot + p.replace(/:/g, '/'))
}
