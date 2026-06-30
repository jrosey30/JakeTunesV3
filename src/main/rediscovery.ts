/** Pure "Rediscover" engine — mines the OWNED library for artists the listener
 *  invested in but has barely/never played INSIDE JakeTunes.
 *
 *  The key insight (Jake's): a low local play count is NOT "disliked." Because
 *  his real listening lives partly on Spotify, "0 plays here" usually means
 *  "loved elsewhere, just never spun in JakeTunes yet" — exactly the overlooked-
 *  treasure pool. So we treat unplayed-but-owned as the prime rediscovery signal,
 *  rank by how much intent the ownership shows, and diversify by genre.
 *
 *  Unit-tested in __tests__/rediscovery.test.ts. No Node/Electron imports. */

export interface RediscoveryTrack {
  artist?: string
  albumArtist?: string
  album?: string
  genre?: string
  year?: number | string
  playCount?: number
  rating?: number
  dateAdded?: string
}

export interface RediscoveryPick {
  artist: string // display name (albumArtist || artist)
  album: string // representative album (most-owned by this artist)
  genre: string
  ownedTracks: number
  plays: number // total JakeTunes plays across owned tracks
  rating: number // best rating among their tracks (0 if none)
  addedAt: string // newest dateAdded among their tracks
  reason: string // heuristic one-liner (fallback if a Music Man pitch isn't available)
}

const DAY = 24 * 60 * 60 * 1000
const SKIP_ARTISTS = new Set(['', 'various artists', 'various', 'va', 'unknown artist', 'soundtrack', 'compilation'])

function topEntry(m: Map<string, number>): string {
  let best = ''
  let bestN = 0
  for (const [k, n] of m) if (n > bestN) { bestN = n; best = k }
  return best
}

export function computeRediscovery(tracks: RediscoveryTrack[], now: Date, limit = 12): RediscoveryPick[] {
  // Top played genres (the listener's ACTUAL local listening) — used as a
  // "this is your lane" boost so picks feel like rediscoveries, not noise.
  const genrePlays = new Map<string, number>()
  for (const t of tracks) {
    const p = Number(t.playCount) || 0
    if (p > 0 && t.genre) genrePlays.set(t.genre, (genrePlays.get(t.genre) || 0) + p)
  }
  const topGenres = new Set(
    [...genrePlays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g),
  )

  interface Agg {
    artist: string
    ownedTracks: number
    plays: number
    rating: number
    newestAddedMs: number
    addedAt: string
    genres: Map<string, number>
    albums: Map<string, number>
  }
  const byArtist = new Map<string, Agg>()
  for (const t of tracks) {
    const name = (t.albumArtist || t.artist || '').trim()
    if (!name || SKIP_ARTISTS.has(name.toLowerCase())) continue
    const key = name.toLowerCase()
    let a = byArtist.get(key)
    if (!a) {
      a = { artist: name, ownedTracks: 0, plays: 0, rating: 0, newestAddedMs: 0, addedAt: '', genres: new Map(), albums: new Map() }
      byArtist.set(key, a)
    }
    a.ownedTracks++
    a.plays += Number(t.playCount) || 0
    a.rating = Math.max(a.rating, Number(t.rating) || 0)
    const ms = t.dateAdded ? Date.parse(t.dateAdded) : NaN
    if (!Number.isNaN(ms) && ms > a.newestAddedMs) { a.newestAddedMs = ms; a.addedAt = t.dateAdded! }
    if (t.genre) a.genres.set(t.genre, (a.genres.get(t.genre) || 0) + 1)
    if (t.album) a.albums.set(t.album, (a.albums.get(t.album) || 0) + 1)
  }

  const nowMs = now.getTime()
  const scored: Array<{ pick: RediscoveryPick; score: number; genre: string }> = []
  for (const a of byArtist.values()) {
    // Need a real chunk owned (you bought in) AND barely spun here (overlooked).
    if (a.ownedTracks < 2) continue
    if (a.plays / a.ownedTracks >= 1) continue // played enough — not overlooked

    const primaryGenre = topEntry(a.genres)
    const repAlbum = topEntry(a.albums)
    const recentDays = a.newestAddedMs ? (nowMs - a.newestAddedMs) / DAY : 99999

    let score = 0
    score += Math.min(a.ownedTracks, 20) * 2 // ownership depth = intent
    if (a.plays === 0) score += 6 // totally untouched here
    if (recentDays <= 120) score += 8 // recently sought out, then forgotten
    else if (recentDays <= 365) score += 3
    if (a.rating >= 4) score += 7 // rated high yet unplayed (!)
    if (primaryGenre && topGenres.has(primaryGenre)) score += 5 // squarely your lane

    const reason = a.rating >= 4
      ? `You starred ${a.artist} but never spun them here`
      : recentDays <= 120
        ? 'Added recently, still unplayed'
        : a.plays === 0
          ? `${a.ownedTracks} tracks, never played here`
          : 'Owned but overlooked'

    scored.push({
      genre: primaryGenre,
      score,
      pick: {
        artist: a.artist,
        album: repAlbum,
        genre: primaryGenre,
        ownedTracks: a.ownedTracks,
        plays: a.plays,
        rating: a.rating,
        addedAt: a.addedAt,
        reason,
      },
    })
  }

  // Stable tiebreak by artist so ties don't reshuffle between calls.
  scored.sort((x, y) => (y.score - x.score) || x.pick.artist.localeCompare(y.pick.artist))

  // Diversify: cap 3 per genre so it isn't a monoculture (helps break a slump).
  const perGenre = new Map<string, number>()
  const out: RediscoveryPick[] = []
  for (const s of scored) {
    const g = s.genre || '—'
    const c = perGenre.get(g) || 0
    if (c >= 3) continue
    perGenre.set(g, c + 1)
    out.push(s.pick)
    if (out.length >= limit) break
  }
  return out
}
