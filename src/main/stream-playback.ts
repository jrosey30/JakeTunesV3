/**
 * Playback routing for machines that do not hold a full local library.
 *
 * workmini (and any future cache-farm install) sets library.streamRoot to the
 * NAS mount. Most track files under musicRoot are then SYMLINKS into that
 * mount. Reading through those links — or even realpath()/existsSync() on
 * them — blocks in the kernel when the SMB mount wedges. Measured on
 * workmini 2026-08-10: 203s for one directory listing; playback that touched
 * the mount never returned.
 *
 * The phone never hits this: it only speaks HTTP to homemini. Desktop must
 * do the same whenever THIS machine is a streaming/cache-farm client.
 *
 * History: a 2026-07-10 gate deliberately kept streamRoot machines OFF the
 * homemini path so "NAS playback" would keep working. Aug 10 proved NAS
 * playback is the hang. Homemini is the correct path for both shapes.
 */

export type StreamSource = 'homemini' | null

/**
 * True when ipod-audio:// must fetch from homemini BEFORE any filesystem
 * call, and must never follow a symlink into streamRoot.
 */
export function isHomeminiPlaybackClient(opts: {
  streamSource: StreamSource
  streamRoot: string | null | undefined
}): boolean {
  if (opts.streamSource === 'homemini') return true
  return typeof opts.streamRoot === 'string' && opts.streamRoot.length > 0
}
