/**
 * Conversions that run behind Jake's music run at background priority
 * (2026-11-20: Jake's music popped during iPod syncs).
 *
 * An iPod sync converts songs for the iPod (ffmpeg decode + afconvert encode:
 * buildAacMirror and buildIpodSafeAlacMirror, both into the sync-convert cache).
 * Each one took a whole core and the disk at normal priority while the player
 * was decoding, and the player's audio thread missed its deadline: a pop.
 *
 * On macOS the child is started through `taskpolicy -b`: Apple's background
 * class, which throttles its CPU and its disk reads and writes behind every
 * normal-priority process. taskpolicy execs the program in place (same pid), so
 * execFile's timeout and kill still reach the converter itself, and the program
 * is still found on PATH. Elsewhere: `nice -n 15` on Linux, unchanged on
 * Windows (no such wrapper there).
 *
 * Only for work nobody is waiting to hear: the play cache and the streamed-ALAC
 * decode serve the song being played and stay at normal priority, so playback
 * is never slowed by this.
 */
export const TASKPOLICY = '/usr/sbin/taskpolicy'

/** [file, args] for execFile / spawn: `cmd args…` at background priority. */
export function atBackgroundPriority(cmd: string, args: readonly string[], platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'darwin') return [TASKPOLICY, ['-b', cmd, ...args]]
  if (platform === 'linux') return ['nice', ['-n', '15', cmd, ...args]]
  return [cmd, [...args]]
}
