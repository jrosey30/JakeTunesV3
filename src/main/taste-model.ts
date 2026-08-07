/**
 * 4.5.0-118 — Taste Model (Phase 1 of the Discovery Brain).
 *
 * Turns the library into a queryable "taste fingerprint" (genre weights,
 * artist affinities, genre-family spines, era profile) and scores how well a
 * candidate release fits that taste. Phase 2's new-music radar ranks live
 * web-search results with `scoreCandidate`; the `summary` grounds the prompt.
 *
 * Pure (no Electron / fs / network) so `node --test` drives it directly and the
 * renderer could reuse it later. The main-process IPC wraps `computeTaste
 * Fingerprint(libraryCache.tracks)`.
 */

export interface TrackLike {
  artist?: string
  albumArtist?: string
  genre?: string
  year?: string | number
  playCount?: number
  skipCount?: number
  rating?: number
}

export interface GenreWeight { genre: string; tracks: number; plays: number; weight: number }
export interface ArtistAffinity { artist: string; tracks: number; plays: number; skips: number; primaryGenre: string }
export interface Spine { name: string; tracks: number; weight: number }
export interface EraBucket { decade: number; tracks: number }

export interface TasteFingerprint {
  totalTracks: number
  totalPlays: number
  topGenres: GenreWeight[]       // weight 0..1, relative to the strongest genre
  topArtists: ArtistAffinity[]   // by plays
  spines: Spine[]                // genre families, weight = share of library
  eras: EraBucket[]              // by decade, ascending
  peakDecade: number | null
  ownedArtists: string[]         // normalized — feeds the "don't suggest owned" filter
  summary: string                // one-paragraph, prompt-ready
}

export interface Candidate { artist?: string; genre?: string; year?: string | number; anchor?: string; why?: string }
export interface CandidateScore { score: number; reasons: string[]; owned: boolean }

/** A top artist the listener actually engages with — seeds discovery searches. */
export interface TasteAnchor {
  artist: string
  plays: number
  tracks: number
  skips: number
  primaryGenre: string
  /** Effective affinity: plays + ownership depth − skip penalty. */
  score: number
}

export const norm = (s: string): string => (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '')

// Genre → family. First match wins; order matters (rock before pop so "pop punk"
// lands in rock). Tuned to Jake's library spines.
const SPINE_RULES: { name: string; test: RegExp }[] = [
  { name: 'Rock & Alternative', test: /rock|alternativ|\balt\b|punk|grunge|indie|metal|new wave|emo|post.?punk|shoegaze|garage rock/i },
  { name: 'Hip-Hop & Rap', test: /rap|hip.?hop|trap|drill|boom.?bap/i },
  { name: 'Electronic & Dance', test: /electronic|house|techno|\bedm\b|dance|trance|\bidm\b|dubstep|drum.?and.?bass|\bdnb\b|breakbeat|ambient|downtempo|big beat/i },
  { name: 'Soul, Funk & R&B', test: /funk|r&b|rnb|\bsoul\b|motown|disco/i },
  { name: 'Pop', test: /pop/i },
  { name: 'Jazz, Blues & Classical', test: /jazz|blues|classical|orchestr|soundtrack/i },
]
function spineFor(genre: string): string {
  for (const r of SPINE_RULES) if (r.test.test(genre)) return r.name
  return 'Other'
}
function decadeOf(year: string | number | undefined): number | null {
  const y = parseInt(String(year ?? '').slice(0, 4), 10)
  return y > 1900 && y < 2100 ? Math.floor(y / 10) * 10 : null
}

function topMapEntry(m: Map<string, number>): string {
  let best = ''
  let bestN = 0
  for (const [k, n] of m) if (n > bestN) { bestN = n; best = k }
  return best
}

/**
 * Top artists by real listening signal — plays weighted, skips penalized,
 * high skip-ratio artists excluded. These anchor Exa searches + MM prompts.
 */
export function getTasteAnchors(tracks: TrackLike[], limit = 8): TasteAnchor[] {
  interface Agg { artist: string; plays: number; tracks: number; skips: number; genres: Map<string, number> }
  const byArtist = new Map<string, Agg>()
  // Compilation shelves masquerade as artists: "Various Artists" carries
  // hundreds of tracks and out-scores every real band, then Discovery
  // anchors on it — pulling random VA compilations from MusicBrainz into
  // "You're Missing" and printing "Because you play Various Artists"
  // (Jake, 2026-08-07: "sloppy, inconsistent... absolutely despise").
  // A pseudo-artist can never be a taste anchor.
  const PSEUDO_ARTIST = /^(various(\s+(artists|interprets))?|va|soundtrack|original\s+(motion\s+picture\s+)?soundtrack|original\s+(broadway\s+|london\s+)?cast(\s+recording)?|unknown(\s+artist)?|compilation|karaoke)$/i
  for (const t of tracks) {
    const name = (t.albumArtist || t.artist || '').trim()
    if (!name || PSEUDO_ARTIST.test(name)) continue
    const key = norm(name)
    let a = byArtist.get(key)
    if (!a) {
      a = { artist: name, plays: 0, tracks: 0, skips: 0, genres: new Map() }
      byArtist.set(key, a)
    }
    a.tracks++
    a.plays += Number(t.playCount) || 0
    a.skips += Number(t.skipCount) || 0
    const g = (t.genre || '').trim()
    if (g) a.genres.set(g, (a.genres.get(g) || 0) + 1)
  }
  const scored: TasteAnchor[] = []
  for (const a of byArtist.values()) {
    // Skip artists they actively reject (more skips than plays).
    if (a.skips >= 3 && a.skips > a.plays) continue
    const score = a.plays * 2 + Math.min(a.tracks, 15) - a.skips * 2
    if (score <= 0 && a.plays === 0) continue
    scored.push({
      artist: a.artist,
      plays: a.plays,
      tracks: a.tracks,
      skips: a.skips,
      primaryGenre: topMapEntry(a.genres),
      score,
    })
  }
  scored.sort((x, y) => y.score - x.score || y.plays - x.plays)
  return scored.slice(0, Math.max(0, limit))
}

export function computeTasteFingerprint(tracks: TrackLike[]): TasteFingerprint {
  const gT = new Map<string, number>(), gP = new Map<string, number>()
  const aT = new Map<string, number>(), aP = new Map<string, number>(), aS = new Map<string, number>(), aG = new Map<string, Map<string, number>>()
  const spineT = new Map<string, number>()
  const eraT = new Map<number, number>()
  const owned = new Set<string>()
  let totalPlays = 0

  for (const t of tracks) {
    const plays = Number(t.playCount) || 0
    totalPlays += plays
    const g = (t.genre || '').trim()
    if (g) {
      gT.set(g, (gT.get(g) || 0) + 1)
      gP.set(g, (gP.get(g) || 0) + plays)
      const sp = spineFor(g)
      spineT.set(sp, (spineT.get(sp) || 0) + 1)
    }
    const a = (t.albumArtist || t.artist || '').trim()
    if (a) {
      aT.set(a, (aT.get(a) || 0) + 1)
      aP.set(a, (aP.get(a) || 0) + plays)
      aS.set(a, (aS.get(a) || 0) + (Number(t.skipCount) || 0))
      const g = (t.genre || '').trim()
      if (g) {
        let gm = aG.get(a)
        if (!gm) { gm = new Map(); aG.set(a, gm) }
        gm.set(g, (gm.get(g) || 0) + 1)
      }
      owned.add(norm(a))
    }
    const d = decadeOf(t.year)
    if (d !== null) eraT.set(d, (eraT.get(d) || 0) + 1)
  }

  const totalTracks = tracks.length || 1
  // Genre blend score = track-share + play-share; normalize to the strongest.
  const blended = [...gT.keys()].map((g) => ({
    genre: g, tracks: gT.get(g) || 0, plays: gP.get(g) || 0,
    blend: (gT.get(g) || 0) / totalTracks + (gP.get(g) || 0) / (totalPlays || 1),
  }))
  const maxBlend = Math.max(1e-9, ...blended.map((b) => b.blend))
  const topGenres: GenreWeight[] = blended
    .sort((a, b) => b.blend - a.blend)
    .slice(0, 15)
    .map((b) => ({ genre: b.genre, tracks: b.tracks, plays: b.plays, weight: Math.round((b.blend / maxBlend) * 100) / 100 }))

  const topArtists: ArtistAffinity[] = [...aP.keys()]
    .map((a) => ({
      artist: a,
      tracks: aT.get(a) || 0,
      plays: aP.get(a) || 0,
      skips: aS.get(a) || 0,
      primaryGenre: topMapEntry(aG.get(a) || new Map()),
    }))
    .sort((a, b) => b.plays - a.plays || b.tracks - a.tracks)
    .slice(0, 20)

  const anchors = getTasteAnchors(tracks, 6)
  const anchorNames = anchors.map((a) => a.artist).join(', ')

  const spines: Spine[] = [...spineT.entries()]
    .filter(([name]) => name !== 'Other')
    .map(([name, tracks]) => ({ name, tracks, weight: Math.round((tracks / totalTracks) * 100) / 100 }))
    .sort((a, b) => b.tracks - a.tracks)

  const eras: EraBucket[] = [...eraT.entries()].map(([decade, tracks]) => ({ decade, tracks })).sort((a, b) => a.decade - b.decade)
  const peakDecade = eras.length ? eras.reduce((m, e) => (e.tracks > m.tracks ? e : m)).decade : null

  const topSpineNames = spines.slice(0, 3).map((s) => s.name).join(', ')
  const topArtistNames = anchors.length > 0
    ? anchors.slice(0, 6).map((a) => `${a.artist} (${a.plays} plays)`).join(', ')
    : topArtists.slice(0, 6).map((a) => a.artist).join(', ')
  const summary = [
    `${totalTracks.toLocaleString()} tracks.`,
    anchors.length ? `Most played: ${anchorNames}.` : '',
    spines.length ? `Taste centers on ${topSpineNames}.` : '',
    topArtists.length && !anchors.length ? `Top artists: ${topArtistNames}.` : '',
    peakDecade ? `Heaviest era: the ${peakDecade}s.` : '',
  ].filter(Boolean).join(' ')

  return { totalTracks: tracks.length, totalPlays, topGenres, topArtists, spines, eras, peakDecade, ownedArtists: [...owned], summary }
}

/**
 * Score how well a candidate release fits the taste (0..1) with human reasons.
 * Genre/spine fit dominates; era fit is a modifier. `owned` flags artists the
 * library already has (the radar should skip them — discovery, not re-buys).
 */
export function scoreCandidate(fp: TasteFingerprint, c: Candidate): CandidateScore {
  const reasons: string[] = []
  const cg = (c.genre || '').trim()

  // Genre fit: exact top-genre weight, else the candidate's spine weight, else low.
  let genreScore = 0.12
  const exact = fp.topGenres.find((g) => norm(g.genre) === norm(cg))
  if (exact) {
    genreScore = Math.max(0.35, exact.weight)
    reasons.push(`${exact.genre} is in heavy rotation for you`)
  } else if (cg) {
    const sp = spineFor(cg)
    const spine = fp.spines.find((s) => s.name === sp)
    if (spine && spine.weight > 0.03) {
      genreScore = Math.min(0.7, 0.25 + spine.weight)
      reasons.push(`sits in your ${sp} wheelhouse`)
    }
  }

  // Era fit: peak/top-3 decade = strong; adjacent = ok; else neutral-low.
  let eraScore = 0.5
  const d = decadeOf(c.year)
  if (d !== null && fp.eras.length) {
    const ranked = [...fp.eras].sort((a, b) => b.tracks - a.tracks)
    const idx = ranked.findIndex((e) => e.decade === d)
    if (idx === 0) { eraScore = 1; reasons.push(`${d}s — your most-collected era`) }
    else if (idx > 0 && idx < 3) { eraScore = 0.8; reasons.push(`${d}s, an era you actively collect`) }
    else if (idx >= 3) eraScore = 0.5
    else eraScore = 0.35
  }

  const score = Math.round((genreScore * 0.7 + eraScore * 0.3) * 100) / 100
  const owned = !!c.artist && fp.ownedArtists.includes(norm(c.artist))
  if (owned) reasons.push('you already own this artist')
  return { score, reasons, owned }
}

/** Score a radar candidate with taste-anchor bonus (because-you-play-X). */
export function scoreCandidateForRadar(
  fp: TasteFingerprint,
  c: Candidate,
  anchors: TasteAnchor[],
): CandidateScore {
  const base = scoreCandidate(fp, c)
  if (base.owned) return base
  const reasons = [...base.reasons]
  let bonus = 0

  if (c.anchor) {
    const idx = anchors.findIndex((a) => norm(a.artist) === norm(c.anchor!))
    if (idx >= 0) {
      bonus += 0.28
      reasons.unshift(`because you play ${anchors[idx].artist}`)
    }
  }

  const why = (c.why || '').toLowerCase()
  for (const a of anchors.slice(0, 6)) {
    if (why.includes(a.artist.toLowerCase())) {
      bonus += 0.12
      if (!reasons.some((r) => r.includes(a.artist))) {
        reasons.unshift(`connects to ${a.artist}`)
      }
      break
    }
  }

  if (c.genre && c.anchor) {
    const anchor = anchors.find((a) => norm(a.artist) === norm(c.anchor!))
    if (anchor?.primaryGenre && norm(anchor.primaryGenre) === norm(c.genre)) {
      bonus += 0.08
    }
  }

  return {
    score: Math.min(1, Math.round((base.score + bonus) * 100) / 100),
    reasons,
    owned: false,
  }
}
