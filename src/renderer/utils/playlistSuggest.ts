/**
 * 4.5: per-playlist suggestions — 5 library tracks that fit what's already on
 * the playlist. Pure + deterministic (tested in src/main/__tests__):
 * profiles the playlist's artists / genres / decades, scores every library
 * track not already on it, keeps a top pool, then picks with an
 * artist-diversity cap. `rotate` pages deeper into the pool (the ↻ button).
 *
 * Local compute only — no AI call, instant on every visit, and adding a
 * suggestion naturally re-ranks the rest (the added track joins the profile).
 */
export interface SuggestibleTrack {
  id: number
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  genre?: string
  year?: number | string
  rating?: number
  playCount?: number
  audioMissing?: boolean
}

const norm = (s: string | undefined): string => (s || '').toLowerCase().trim()

export function suggestForPlaylist<T extends SuggestibleTrack>(
  playlistTracks: T[],
  library: T[],
  limit = 5,
  rotate = 0,
): T[] {
  if (playlistTracks.length === 0 || library.length === 0 || limit <= 0) return []
  const inPlaylist = new Set(playlistTracks.map(t => t.id))

  // The playlist's profile.
  const artistCount = new Map<string, number>()
  const genreCount = new Map<string, number>()
  const decadeCount = new Map<number, number>()
  for (const t of playlistTracks) {
    const a = norm(t.albumArtist || t.artist)
    if (a) artistCount.set(a, (artistCount.get(a) || 0) + 1)
    const g = norm(t.genre)
    if (g) genreCount.set(g, (genreCount.get(g) || 0) + 1)
    const y = Number(t.year)
    if (Number.isFinite(y) && y > 1900) {
      const d = Math.floor(y / 10) * 10
      decadeCount.set(d, (decadeCount.get(d) || 0) + 1)
    }
  }

  const scored: Array<{ t: T; score: number }> = []
  for (const t of library) {
    if (inPlaylist.has(t.id) || t.audioMissing) continue
    const a = norm(t.albumArtist || t.artist)
    const g = norm(t.genre)
    let score = 0
    const ac = a ? artistCount.get(a) || 0 : 0
    if (ac > 0) score += 6 + Math.min(ac, 3) * 2          // recurring artists pull hardest
    const gc = g ? genreCount.get(g) || 0 : 0
    if (gc > 0) score += 2 + Math.min(gc, 4)              // genre fit
    const y = Number(t.year)
    if (Number.isFinite(y) && y > 1900) {
      const d = Math.floor(y / 10) * 10
      if (decadeCount.has(d)) score += 2
      else if (decadeCount.has(d - 10) || decadeCount.has(d + 10)) score += 1
    }
    if (score < 3) continue                                // must actually FIT, not just exist
    if ((t.rating || 0) >= 4) score += 1.5                 // taste tiebreakers
    if ((t.playCount || 0) >= 3) score += 1
    scored.push({ t, score })
  }

  scored.sort((x, y) =>
    y.score - x.score ||
    (y.t.rating || 0) - (x.t.rating || 0) ||
    (y.t.playCount || 0) - (x.t.playCount || 0) ||
    norm(x.t.title).localeCompare(norm(y.t.title)),
  )

  // Pool = several pages of candidates; ↻ rotates the starting offset.
  const pool = scored.slice(0, Math.max(limit * 6, limit))
  if (pool.length === 0) return []
  const start = (rotate * limit) % pool.length
  const rotated = [...pool.slice(start), ...pool.slice(0, start)]

  // Diversity: max 2 per artist in the final picks; backfill if short.
  const picks: T[] = []
  const perArtist = new Map<string, number>()
  for (const { t } of rotated) {
    const a = norm(t.albumArtist || t.artist)
    const c = perArtist.get(a) || 0
    if (c >= 2) continue
    perArtist.set(a, c + 1)
    picks.push(t)
    if (picks.length >= limit) break
  }
  if (picks.length < limit) {
    for (const { t } of rotated) {
      if (picks.length >= limit) break
      if (!picks.includes(t)) picks.push(t)
    }
  }
  return picks
}
