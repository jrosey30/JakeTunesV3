/**
 * 4.5: per-playlist suggestions — 5 library tracks that fit what's already on
 * the playlist. Pure + deterministic (tested in src/main/__tests__):
 * profiles the playlist's artists / genres / decades, scores every library
 * track not already on it, keeps a top pool, then picks ONE per artist for
 * variety (relaxing only if the pool is artist-poor). `rotate` pages deeper (↻).
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
  /** AI taxonomy (2026-06): broad subgenre + full general→specific path. */
  subgenre?: string
  subgenrePath?: string
  year?: number | string
  rating?: number
  playCount?: number
  bpm?: number
  camelotKey?: string
  audioMissing?: boolean
}

// ── Taxonomy distance (2026-08-07, Jake: "master the songs genre by genre",
// validated punk-first on METAL VOL 1). Every song carries an AI-classified
// path like "Rock › Punk › Hardcore"; suggestion fit walks that tree:
// same micro-shelf > same family (level-2 subtree) > same root > elsewhere.
// This is what lets a 4-song playlist with a clear identity get suggestions
// that RESPECT it — the vibe engine alone can't see that Punk and Metal are
// neighbors while Synth-Pop is a different continent.
const pathSegs = (p: string | undefined): string[] =>
  (p || '').split('›').map((s) => s.trim().toLowerCase()).filter(Boolean)

/** Playlist taxonomy profile: weight per level-2 family + per root. */
export function buildGenreProfile(tracks: SuggestibleTrack[]): { fam: Map<string, number>; root: Map<string, number>; total: number } {
  const fam = new Map<string, number>()
  const root = new Map<string, number>()
  let total = 0
  for (const t of tracks) {
    const segs = pathSegs(t.subgenrePath || t.subgenre)
    if (segs.length === 0) continue
    total++
    root.set(segs[0], (root.get(segs[0]) || 0) + 1)
    const famKey = segs.slice(0, 2).join('›')
    fam.set(famKey, (fam.get(famKey) || 0) + 1)
  }
  return { fam, root, total }
}

/** 0..1 taxonomy fit of one candidate against the playlist profile. */
export function genreFit(t: SuggestibleTrack, profile: { fam: Map<string, number>; root: Map<string, number>; total: number }): number {
  if (profile.total === 0) return 0.5           // no taxonomy data → neutral
  const segs = pathSegs(t.subgenrePath || t.subgenre)
  if (segs.length === 0) return 0.35            // unclassified candidate: mild penalty
  const famKey = segs.slice(0, 2).join('›')
  const famW = (profile.fam.get(famKey) || 0) / profile.total
  const rootW = (profile.root.get(segs[0]) || 0) / profile.total
  // Family membership dominates; root membership keeps neighbors (Punk on a
  // Metal list) in the running; elsewhere sinks.
  return Math.min(1, 0.15 + 0.65 * famW + 0.35 * rootW)
}

const norm = (s: string | undefined): string => (s || '').toLowerCase().trim()

// Camelot harmonic neighbours of a key (e.g. "8A" → 8A, 7A, 9A, 8B): the same
// key, ±1 around the wheel (same letter), and the relative major/minor (same
// number, other letter). Standard DJ harmonic-mixing compatibility.
function camelotNeighbors(c: string): string[] {
  const m = /^(\d{1,2})([AB])$/.exec(c)
  if (!m) return []
  const n = Number(m[1]); const L = m[2]; const o = L === 'A' ? 'B' : 'A'
  const up = (n % 12) + 1; const down = ((n - 2 + 12) % 12) + 1
  return [`${n}${L}`, `${up}${L}`, `${down}${L}`, `${n}${o}`]
}

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

  const gProfile = buildGenreProfile(playlistTracks)
  const scored: Array<{ t: T; score: number }> = []
  for (const t of library) {
    if (inPlaylist.has(t.id) || t.audioMissing) continue
    const a = norm(t.albumArtist || t.artist)
    const g = norm(t.genre)
    let score = 0
    const ac = a ? artistCount.get(a) || 0 : 0
    if (ac > 0) score += 6 + Math.min(ac, 3) * 2          // recurring artists pull hardest
    const gc = g ? genreCount.get(g) || 0 : 0
    if (gc > 0) score += 2 + Math.min(gc, 4)              // raw-tag genre fit
    // Taxonomy fit — counts toward the entry threshold, so a playlist thin
    // in exact tags (METAL VOL 1 in a library with 5 Metal-tagged songs)
    // still fills from its genre FAMILY (Punk/Hardcore/Hard Rock shelves).
    if (gProfile.total > 0) score += 5 * genreFit(t, gProfile)
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

  // Diversity: ONE pick per artist, for maximum variety. Only when the pool is
  // too artist-poor to reach `limit` do we relax the cap by one and pass again
  // (→ 2 each, then 3…), so a playlist dominated by a few artists still fills.
  // No uncapped backfill — that was what produced same-artist clusters.
  const picks: T[] = []
  const perArtist = new Map<string, number>()
  for (let cap = 1; picks.length < limit && cap <= limit; cap++) {
    for (const { t } of rotated) {
      if (picks.length >= limit) break
      if (picks.includes(t)) continue
      const a = norm(t.albumArtist || t.artist)
      if ((perArtist.get(a) || 0) >= cap) continue
      perArtist.set(a, (perArtist.get(a) || 0) + 1)
      picks.push(t)
    }
  }
  return picks
}

/**
 * 4.5: brain-driven suggestions. `hits` are candidates tagged with the playlist
 * SUB-VIBE cluster they best match (the `playlist-similar` IPC k-means the seeds
 * into the playlist's distinct moods). We blend each by vibe + adaptive BPM +
 * harmonic key, drop same-album/playlist tracks, prefer fresh artists, then
 * ROUND-ROBIN one per cluster so EVERY mood on the playlist is represented — not
 * just the densest one (a Brazilian-heavy eclectic playlist still surfaces its
 * electronic / hip-hop corners). ↻ advances the rank within each cluster.
 * Falls back to suggestForPlaylist (metadata) when no embeddings exist.
 */
export interface SuggestBlendWeights { vibe?: number; genre?: number; taste?: number; era?: number }
export interface SuggestDiag { vn: number; g: number; b: number; ta: number; e: number }

export function suggestFromVibeHits<T extends SuggestibleTrack>(
  playlistTracks: T[],
  library: T[],
  hits: Array<{ trackId: number; score: number; cluster: number }>,
  limit = 5,
  rotate = 0,
  clusterSeeds: number[] = [],
  // Taste-ledger loop (2026-08-07): learned per-playlist multipliers from
  // the nightly learner, plus an out-map of each candidate's blend
  // components so accept/pass events record WHY a pick ranked where it
  // did — the learner needs that to know which dial to turn.
  weights: SuggestBlendWeights = {},
  diagOut?: Map<number, SuggestDiag>,
): T[] {
  if (playlistTracks.length === 0 || hits.length === 0 || limit <= 0) return []
  // Seat eligibility by SEED SHARE (2026-08-07, Jake: "pool dos sometimes
  // suggests like pantera or rage against the machine"): farthest-point
  // clustering deliberately isolates outliers, and equal round-robin then
  // GUARANTEED a 1-song corner a strip seat every time. On a playlist big
  // enough to have a real character (≥7 tracks), a sub-vibe must be seeded
  // by at least 2 songs or 15% of the playlist to earn seats. Tiny
  // playlists keep every cluster — with 5 songs, each one IS the vibe.
  const totalSeeds = clusterSeeds.reduce((s, n) => s + n, 0)
  // Only playlists with a clear dominant character drop their outliers — a
  // GENUINELY eclectic playlist (no vibe holds half the songs) keeps every
  // corner, or the strip thins out to two vibes (Jake, same day: "now
  // there is less suggestions… UGH"). pool dos (chill-dominant) still
  // sheds its one metal track; a 5-vibe mosaic keeps all five.
  const maxShare = totalSeeds > 0 ? Math.max(...clusterSeeds) / totalSeeds : 0
  const clusterEligible = (c: number): boolean => {
    if (playlistTracks.length < 7 || totalSeeds === 0) return true
    if (maxShare < 0.5) return true
    const seeds = clusterSeeds[c] ?? 0
    return seeds >= 2 || seeds / totalSeeds >= 0.15
  }
  const byId = new Map(library.map(t => [t.id, t]))
  const inPlaylist = new Set(playlistTracks.map(t => t.id))
  const albumKey = (t: T): string => norm(t.albumArtist || t.artist) + ' ' + norm(t.album)
  const plArtists = new Set(playlistTracks.map(t => norm(t.albumArtist || t.artist)).filter(Boolean))
  const plAlbums = new Set(playlistTracks.map(albumKey).filter(s => s.length > 1))

  // Score each candidate: vibe (primary) + ADAPTIVE BPM fit + harmonic (Camelot)
  // fit. BPM matching is a Gaussian centered on the playlist's median tempo with
  // σ = the playlist's OWN BPM spread — a tight-tempo playlist gets tight
  // suggestions, an eclectic one stays broad (a fixed window wrongly collapsed
  // everything to one BPM). Camelot only counts when the playlist is genuinely
  // key-cohesive (else every key looks "compatible" and it's just noise).
  const plBpms = playlistTracks.map(t => Number(t.bpm) || 0).filter(b => b > 0).sort((a, b) => a - b)
  const median = plBpms.length ? plBpms[plBpms.length >> 1] : 0
  let sigma = 8
  if (plBpms.length > 1) {
    const mean = plBpms.reduce((s, b) => s + b, 0) / plBpms.length
    sigma = Math.max(8, Math.sqrt(plBpms.reduce((s, b) => s + (b - mean) ** 2, 0) / plBpms.length))
  }
  const compat = new Set<string>()
  for (const t of playlistTracks) {
    const c = (t.camelotKey || '').toUpperCase()
    if (c) for (const nb of camelotNeighbors(c)) compat.add(nb)
  }
  const keyWeight = compat.size > 0 && compat.size <= 14 ? 0.15 : 0   // only when key-cohesive
  // ERA (2026-09-04, Jake: "wrong decade picks are unacceptable but not
  // all of those are supposed to be centered around a decade"). Two kinds
  // of playlist: ERA-CENTERED (Y2k Burnt CD, 90's Music, Q104.3, Weirdtronic
  // — the middle half of its songs spans ≤10 years) and everything else
  // (Dinner Party, Movies, METAL VOL 1 — a mood across decades). Centered:
  // a dated candidate outside [Q1−3, Q3+3] is CUT outright (a demotion was
  // not enough — the round-robin hands every sub-vibe a seat, so a cluster
  // of 1991 grunge kept reaching a 2002–2006 CD) and the survivors rank by
  // a Gaussian on the median year (σ = the playlist's own spread, floor 3).
  // Not centered: era is switched OFF — neutral 0.5 for every candidate,
  // no cut — a 1975 Zeppelin cut on Dinner Party is right; a 1975 cut
  // because the median happens to be 1998 is not. Playlists with <7 dated
  // songs rank by era but never cut (each song IS the vibe). Undated
  // candidates are always neutral. Calibrated on the real playlists
  // (IQR: Y2k 4, Weirdtronic 4, 90's 8, Q104.3 10 · Dinner Party 43,
  // Movies 19, METAL VOL 1 23).
  const plYears = playlistTracks.map(t => Number(t.year) || 0).filter(y => y > 1900).sort((a, b) => a - b)
  const medianYear = plYears.length >= 3 ? plYears[plYears.length >> 1] : 0
  let ySigma = 3
  if (plYears.length > 1) {
    const ymean = plYears.reduce((s, y) => s + y, 0) / plYears.length
    ySigma = Math.max(3, Math.sqrt(plYears.reduce((s, y) => s + (y - ymean) ** 2, 0) / plYears.length))
  }
  const q1 = plYears.length ? plYears[Math.floor(plYears.length / 4)] : 0
  const q3 = plYears.length ? plYears[Math.floor((3 * plYears.length) / 4)] : 0
  const eraCentered = plYears.length >= 7 && q3 - q1 <= 10
  const eraRanks = eraCentered || plYears.length < 7
  const eraFit = (t: T): number => {
    const y = Number(t.year) || 0
    return (eraRanks && y > 1900 && medianYear > 0) ? Math.exp(-0.5 * ((y - medianYear) / ySigma) ** 2) : 0.5
  }
  const eraCut = (t: T): boolean => {
    if (!eraCentered) return false
    const y = Number(t.year) || 0
    return y > 1900 && (y < q1 - 3 || y > q3 + 3)
  }

  // Group candidates by their SUB-VIBE cluster (vibe score = sim to that cluster).
  const byCluster = new Map<number, Array<{ t: T; vibe: number }>>()
  let vmin = Infinity, vmax = -Infinity
  for (const h of hits) {
    if (!clusterEligible(h.cluster)) continue
    const t = byId.get(h.trackId)
    if (!t || inPlaylist.has(t.id) || t.audioMissing || plAlbums.has(albumKey(t))) continue
    if (eraCut(t)) continue   // era-centered playlist, wrong decade — out (see above)
    let arr = byCluster.get(h.cluster)
    if (!arr) { arr = []; byCluster.set(h.cluster, arr) }
    arr.push({ t, vibe: h.score })
    if (h.score < vmin) vmin = h.score
    if (h.score > vmax) vmax = h.score
  }
  if (byCluster.size === 0) return []
  const vrange = vmax - vmin || 1

  // Within each cluster: blend (vibe + taxonomy fit + adaptive BPM + harmonic
  // key), fresh first. Taxonomy fit is the "master the genres" layer — a
  // candidate from the playlist's own genre family outranks an equal-vibe
  // stranger, so METAL VOL 1 pulls from the Punk/Metal shelves, not from
  // whatever happens to share its energy.
  const gProfile = buildGenreProfile(playlistTracks)
  const blendSort = (list: Array<{ t: T; vibe: number }>): T[] => {
    const scored = list.map(({ t, vibe }) => {
      const vn = (vibe - vmin) / vrange
      const b = Number(t.bpm) || 0
      const bpmFit = (b > 0 && median > 0) ? Math.exp(-0.5 * ((b - median) / sigma) ** 2) : 0.5
      const key = (t.camelotKey || '').toUpperCase()
      const keyFit = key ? (compat.has(key) ? 1 : 0.15) : 0.5
      const gFit = genreFit(t, gProfile)
      // Taste voice (2026-08-07, Jake: "the AI has no feel for playlists"):
      // stars + play history nudge the songs he'd actually ADD above
      // equal-vibe strangers. Small weight — fit still leads.
      const taste = Math.min(1, ((Number(t.rating) || 0) / 5) * 0.6 + Math.min((Number(t.playCount) || 0) / 8, 1) * 0.4)
      const eFit = eraFit(t)
      if (diagOut) diagOut.set(t.id, { vn, g: gFit, b: bpmFit, ta: taste, e: eFit })
      const wV = weights.vibe ?? 1, wG = weights.genre ?? 1, wT = weights.taste ?? 1, wE = weights.era ?? 1
      return { t, s: 0.45 * wV * vn + 0.22 * wG * gFit + 0.15 * bpmFit + keyWeight * keyFit + 0.10 * wT * taste + 0.15 * wE * eFit }
    })
    scored.sort((a, b) => b.s - a.s)
    const fr = scored.filter(x => !plArtists.has(norm(x.t.albumArtist || x.t.artist))).map(x => x.t)
    const fa = scored.filter(x => plArtists.has(norm(x.t.albumArtist || x.t.artist))).map(x => x.t)
    return [...fr, ...fa]
  }
  // Denser sub-vibes fill first — the playlist's dominant character leads.
  const clusterLists = [...byCluster.entries()]
    .sort((a, b) => (clusterSeeds[b[0]] ?? 0) - (clusterSeeds[a[0]] ?? 0))
    .map(([, list]) => blendSort(list))

  // Interleave the clusters round-robin into ONE ranked pool (denser
  // sub-vibes lead each round; one-per-artist until the pool runs thin),
  // then PAGE the strip through it. Every ↻ press replaces ALL five slots
  // (2026-08-07, Jake: "a lot of songs that stay every refresh, in the
  // same spots. all 5 need to rotate") — the old per-cluster modulo pinned
  // a 1-candidate cluster to the same song in the same slot forever.
  // Pages walk the whole pool before wrapping, so a healthy playlist gives
  // dozens of fully-fresh strips.
  const pool: T[] = []
  const inPool = new Set<T>()
  const perArtist = new Map<string, number>()
  for (let cap = 1; cap <= 3 && pool.length < limit * 12; cap++) {
    for (let rank = 0; ; rank++) {
      let any = false
      for (const list of clusterLists) {
        const t = list[rank]
        if (!t) continue
        any = true
        if (inPool.has(t)) continue
        const a = norm(t.albumArtist || t.artist)
        if ((perArtist.get(a) || 0) >= cap) continue
        perArtist.set(a, (perArtist.get(a) || 0) + 1)
        inPool.add(t)
        pool.push(t)
      }
      if (!any) break
    }
  }
  if (pool.length === 0) return []
  if (pool.length <= limit) return pool
  const start = (rotate * limit) % pool.length
  const picks: T[] = []
  for (let i = 0; i < pool.length && picks.length < limit; i++) {
    picks.push(pool[(start + i) % pool.length])
  }
  return picks
}
