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
 *
 * ⚠️ INVARIANTS (locked by __tests__/stream-playback*.test.ts):
 *   1. streamRoot set ⇒ homemini playback client (even if streamSource unset)
 *   2. homemini client + symlink ⇒ NEVER follow into streamRoot / SMB
 *   3. Fully-local MacBook (neither flag) is unchanged
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

/**
 * After homemini has been asked (or skipped), may we read through a
 * filesystem symlink on the playback path?
 *
 * Streaming/cache-farm clients: NO. The symlink target is the NAS mount.
 * Following it is the hang. Return 404 instead.
 *
 * Fully-local machines: YES — a symlink there is unusual but not the
 * workmini SMB shape, and historical local behavior stands.
 */
export function mayFollowPlaybackSymlink(opts: {
  isHomeminiClient: boolean
  isSymlink: boolean
}): boolean {
  if (!opts.isSymlink) return true
  if (opts.isHomeminiClient) return false
  return true
}

/** Where bytes should come from for one play attempt. Pure decision table. */
export type PlaybackBytePlan =
  | { action: 'fetch-homemini-first' }
  | { action: 'serve-local-file' }
  | { action: 'refuse-smb-symlink' }
  | { action: 'serve-disk-default' }

export function planPlaybackBytes(opts: {
  streamSource: StreamSource
  streamRoot: string | null | undefined
  /** Set once lstat has run on the local path. null = not yet / missing. */
  localIsSymlink: boolean | null
  homeminiReturnedAudio: boolean
}): PlaybackBytePlan {
  const client = isHomeminiPlaybackClient({
    streamSource: opts.streamSource,
    streamRoot: opts.streamRoot,
  })

  if (client && !opts.homeminiReturnedAudio && opts.localIsSymlink === null) {
    // Hot path entry: ask homemini before any fs call.
    return { action: 'fetch-homemini-first' }
  }
  if (client && opts.homeminiReturnedAudio) {
    return { action: 'serve-local-file' } // unused — caller already returned the Response
  }
  if (client && opts.localIsSymlink === true) {
    return { action: 'refuse-smb-symlink' }
  }
  if (client && opts.localIsSymlink === false) {
    return { action: 'serve-local-file' }
  }
  return { action: 'serve-disk-default' }
}
