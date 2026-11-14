/**
 * Is the player using this song's file? (2026-11-14)
 *
 * Jake changed the artist of "Stalks (Greenpoint Mix)" in Get Info while it
 * played. The tag write-back copied the file, mutagen grew the tags on the
 * copy (which moves the audio further into the file), and the copy was
 * renamed over the original. 50 s later the player asked for more bytes, got
 * the new file at the old file's offsets, and failed ("DEMUXER_ERROR … PTS is
 * not defined"); its reload failed too and the song was skipped.
 *
 * The tag write-back asks this before it writes a file
 * (tag-writeback-queue.ts `inUse`). A song is in use when:
 *   • the player asked for it within its length + 2 minutes (what is playing,
 *     and what it loaded ahead as next: both come through ipod-audio://, and
 *     `playerTouches` notes every request), or
 *   • a load still holds the file open (audio-load-hold.ts): a song paused
 *     for an hour is still the current song, and its next read must be the
 *     file it started on.
 *
 * Pure; every effect is injected (__tests__/song-in-use.test.ts).
 */

/** Past the song's own length, how long a touched song still counts as in use. */
export const IN_USE_GRACE_MS = 2 * 60_000
/** A song whose length isn't known counts as this long. */
export const IN_USE_UNKNOWN_LENGTH_MS = 15 * 60_000

export interface SongInUseInput {
  /** The song's library path (colon form). */
  colonPath: string
  /** Its length in ms (the library's `duration`). 0 or missing = unknown. */
  durationMs: number
  now: number
  /** When the player last asked for it, or null. */
  lastTouchAt: number | null
  /** A load is holding this song's file open right now. */
  heldOpen: boolean
}

export function songInUse(i: SongInUseInput): boolean {
  if (i.heldOpen) return true
  if (i.lastTouchAt == null) return false
  const len = Number.isFinite(i.durationMs) && i.durationMs > 0 ? i.durationMs : IN_USE_UNKNOWN_LENGTH_MS
  // A touch "in the future" (a clock step back) counts as now.
  return i.now - i.lastTouchAt < len + IN_USE_GRACE_MS
}
