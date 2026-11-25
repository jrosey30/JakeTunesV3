/**
 * A song's length as the lists show it: 3:30, 12:05, 1:02:05 (V7, 2026-11-24).
 * Seconds are floored, as the Songs list always did. Nothing (0, negative,
 * missing) is an empty cell, never "0:00". It was copied into a dozen views.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || !(ms > 0)) return ''
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = s.toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
