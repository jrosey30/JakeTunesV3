/**
 * Lifetime library stats — total plays, hours of music, top artist, top
 * genre. Lifted from the Home's stats strip (4.4.33) when the strip
 * moved to Settings › Library (Jake, 2026-10-18: "stats move to settings").
 * One implementation, so the Home strip (switched off) and the Settings
 * section can't drift apart.
 *
 * Ranking weight is plays + 1 per track, so an artist with a big unplayed
 * shelf still counts. Pure — no React, no IPC.
 */
export interface StatsTrack {
  playCount?: number | string | null
  duration?: number | string | null
  albumArtist?: string | null
  artist?: string | null
  genre?: string | null
}

export interface LibraryStats {
  totalPlays: number
  /** "1.2k hrs" / "640 hrs" / "12.5 hrs" */
  hoursLabel: string
  topArtist: string
  topGenre: string
}

export function libraryStats(tracks: readonly StatsTrack[]): LibraryStats {
  let totalPlays = 0
  let totalDurationMs = 0
  const byArtist = new Map<string, number>()
  const byGenre = new Map<string, number>()
  for (const t of tracks) {
    const plays = Number(t.playCount) || 0
    totalPlays += plays
    totalDurationMs += Number(t.duration) || 0
    const artist = t.albumArtist || t.artist
    if (artist) byArtist.set(artist, (byArtist.get(artist) || 0) + plays + 1)
    if (t.genre) byGenre.set(t.genre, (byGenre.get(t.genre) || 0) + plays + 1)
  }
  const topArtist = Array.from(byArtist.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const topGenre = Array.from(byGenre.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const totalHours = totalDurationMs / 3_600_000
  const hoursLabel =
    totalHours >= 1000 ? `${(totalHours / 1000).toFixed(1)}k hrs` :
    totalHours >= 100  ? `${Math.round(totalHours)} hrs` :
                         `${totalHours.toFixed(1)} hrs`   // (the strip's 10–100 tier printed the same)
  return { totalPlays, hoursLabel, topArtist, topGenre }
}
