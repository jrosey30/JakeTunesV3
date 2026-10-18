/**
 * Keep the display awake for the length of an iPod sync.
 *
 * 2026-10-17: a 1000-song Activity Sync (25 min — hi-res songs are now
 * converted on the way) outlived the screen saver. At 15:51 the screen
 * locked; at 15:58 the Verify step's clean unmount was refused —
 * loginwindow's CopySLUnmountApprovalCallback answers "Allow = NO" for
 * every unmount while the screen is locked ("dissented by PID 604
 * loginwindow"). The engine never force-unmounts a dirty FAT32 card, so
 * it aborted after the wipe and re-emptied Music.
 *
 * loginwindow checks PMDisplaySleepIsBlocked before it locks on screen
 * saver fade; a 'prevent-display-sleep' blocker (the assertion video
 * players hold) keeps the lock from ever arming mid-sync. Held only while
 * the sync runs, released in finally — success, refusal, cancel or throw.
 */

export interface DisplaySleepBlocker {
  start(type: 'prevent-display-sleep'): number
  stop(id: number): void
}

export async function withDisplayAwake<T>(blocker: DisplaySleepBlocker, run: () => Promise<T>): Promise<T> {
  let id: number | null = null
  try {
    id = blocker.start('prevent-display-sleep')
  } catch (err) {
    // A sync must not fail because the blocker did; it just may lock.
    console.warn('[sync-awake] could not hold the display awake:', err instanceof Error ? err.message : err)
  }
  try {
    return await run()
  } finally {
    if (id !== null) {
      try {
        blocker.stop(id)
      } catch (err) {
        console.warn('[sync-awake] could not release the display blocker:', err instanceof Error ? err.message : err)
      }
    }
  }
}
