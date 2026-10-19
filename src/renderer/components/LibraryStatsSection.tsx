/**
 * Settings › Library — the lifetime stats that used to sit on the Home as a
 * strip (total plays, hours of music, top artist, top genre). Jake,
 * 2026-10-18: "stats move to settings." Same numbers as the strip
 * (utils/libraryStats.ts), drawn in the Settings modal's own vocabulary.
 * Names wrap, never clip. Empty library → nothing.
 */
import { useMemo } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { libraryStats } from '../utils/libraryStats'

export default function LibraryStatsSection(): JSX.Element | null {
  const { state: lib } = useLibrary()
  const s = useMemo(() => libraryStats(lib.tracks), [lib.tracks])
  if (lib.tracks.length === 0) return null
  const cells: Array<[string, string]> = [
    [s.totalPlays.toLocaleString(), 'Total Plays'],
    [s.hoursLabel, 'In Your Library'],
    ...(s.topArtist ? [[s.topArtist, 'Top Artist'] as [string, string]] : []),
    ...(s.topGenre ? [[s.topGenre, 'Top Genre'] as [string, string]] : []),
  ]
  return (
    <section aria-label="Library stats">
      <div style={{ marginBottom: 8, fontSize: 13, color: '#3a3a3a', fontWeight: 600 }}>Your library, all time</div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))`, gap: 8 }}>
        {cells.map(([value, label]) => (
          <div key={label} style={{ padding: '10px 12px', background: '#f5f5f5', border: '1px solid #e0e0e0', borderRadius: 6 }}>
            <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.2, color: '#222', overflowWrap: 'anywhere' }}>{value}</div>
            <div style={{ marginTop: 3, fontSize: 11, color: '#666' }}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #d0d0d0', margin: '18px 0 14px' }} />
    </section>
  )
}
