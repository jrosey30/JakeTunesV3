// Display formatters.
//
// ⚠️ TWIN: src/renderer/views/SongsView.tsx::formatDuration (and 8
// other near-duplicate copies sprinkled across desktop components —
// see grep `function formatDuration` in src/renderer/). They all take
// MILLISECONDS as input. Mobile must too, because the contract on
// `Track.duration` is set in src/main/index.ts (line ~2126):
//
//     durationMs = Math.round((format.duration || 0) * 1000)
//     ...
//     duration: durationMs
//
// The library JSON the desktop writes carries duration-in-ms. The
// mobile snapshot reads that JSON. So `formatDuration` here is in the
// same unit. **Don't** convert at the row level; convert only when
// crossing into a system that uses different units (TrackPlayer's
// `useProgress` returns SECONDS — see queueAdapter for the boundary).
//
// If you change the rounding/formatting here, update the desktop's
// copies (they're scattered, but conceptually one twin).

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const totalSeconds = Math.round(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}
