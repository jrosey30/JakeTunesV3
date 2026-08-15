/**
 * Count-up / countdown pair for the now-playing pill.
 *
 * ⚠️ TWIN: src/renderer/components/playback/NowPlaying.tsx is the only
 * consumer — keep the labels on this helper so song, preview, and tape
 * clocks cannot drift apart again.
 *
 * Two invariants:
 *   1. Brief 025: floor elapsed and duration ONCE, remaining = duration
 *      - elapsed. Independent floors (formatTime(pos) vs
 *      formatTime(dur - pos)) drift by ~1s and tick on different
 *      seconds. The tape path missed this fix; daily mixes use that path.
 *   2. Hour-long totals format BOTH sides as H:MM:SS. Otherwise a mix at
 *      1:03:37 shows remaining as -28:19 and the two clocks look like
 *      they are measuring different things.
 */

export function formatScrubberClock(
  elapsedSec: number,
  durationSec: number,
): { elapsed: string; remaining: string } {
  const elapsed = Math.max(0, Math.floor(Number.isFinite(elapsedSec) ? elapsedSec : 0))
  const duration = Math.max(0, Math.floor(Number.isFinite(durationSec) ? durationSec : 0))
  const remaining = Math.max(0, duration - elapsed)
  const long = duration >= 3600
  return {
    elapsed: formatHMS(elapsed, long),
    remaining: formatHMS(remaining, long),
  }
}

function formatHMS(s: number, forceHours: boolean): string {
  const secs = s % 60
  const mins = Math.floor(s / 60) % 60
  const hours = Math.floor(s / 3600)
  if (hours > 0 || forceHours) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${mins}:${String(secs).padStart(2, '0')}`
}
