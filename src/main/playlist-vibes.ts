/**
 * Playlist sub-vibe clustering + candidate scoring — the brain half of the
 * "Suggested for this playlist" strip (pure; IPC marshaling stays in
 * index.ts, blending/round-robin stays in renderer playlistSuggest.ts).
 *
 * Design history (don't regress — each rule fixed a real complaint):
 *  1. NEVER the playlist's mean centroid — eclectic playlists all average
 *     to the same bland middle.
 *  2. Global-center penalty (λ=0.3) removes generic fits-everything tracks.
 *  3. K-means sub-vibes + renderer round-robin — a Brazilian-heavy playlist
 *     still surfaces its electronic/disco corners.
 *  4. (2026-07-19, Jake: "there is no reason why system of a down should be
 *     there") THE QUALITY FLOOR: farthest-point init hands every outlier
 *     song its own cluster, and the round-robin then GUARANTEED that
 *     cluster a strip slot — one rock song on a 21-track pool playlist gave
 *     nu-metal a permanent seat, served from candidates the brain scored a
 *     weak ~0.5 (nothing in the library actually matches "protest rock on
 *     a pool playlist" — measured healthy-cluster matches run ~0.7+).
 *     Fix: per-playlist floor = median of every cluster's 10th-best raw
 *     similarity, minus a margin. Self-calibrating — an outlier cluster's
 *     junk pool sits far below what the playlist's healthy clusters prove
 *     is achievable, while a genuinely eclectic playlist (all clusters
 *     thin) keeps a proportionally lower bar. A floored-out cluster serves
 *     NOTHING and the renderer's round-robin fills from real vibes.
 */

export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) sum += a[i] * b[i]
  return sum
}

/** Cosine Lloyd's with farthest-point init (moved verbatim from index.ts). */
export function kmeansCentroids(vecs: Float32Array[], k: number, iters = 10): Float32Array[] {
  const n = vecs.length
  k = Math.max(1, Math.min(k, n))
  const dim = vecs[0].length
  const centroids: Float32Array[] = [vecs[0].slice()]
  while (centroids.length < k) {
    let far = 0, farD = -1
    for (let i = 0; i < n; i++) {
      let nearest = 2
      for (const c of centroids) { const d = 1 - cosine(vecs[i], c); if (d < nearest) nearest = d }
      if (nearest > farD) { farD = nearest; far = i }
    }
    centroids.push(vecs[far].slice())
  }
  for (let it = 0; it < iters; it++) {
    const sums = centroids.map(() => new Float32Array(dim))
    const counts = new Array(k).fill(0)
    for (const v of vecs) {
      let bi = 0, bs = -2
      for (let c = 0; c < k; c++) { const s = cosine(v, centroids[c]); if (s > bs) { bs = s; bi = c } }
      const sum = sums[bi]; for (let i = 0; i < dim; i++) sum[i] += v[i]; counts[bi]++
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue
      const sum = sums[c]; let nm = 0
      for (let i = 0; i < dim; i++) { sum[i] /= counts[c]; nm += sum[i] * sum[i] }
      nm = Math.sqrt(nm) || 1
      for (let i = 0; i < dim; i++) sum[i] /= nm
      centroids[c] = sum
    }
  }
  return centroids
}

export interface VibeHit { trackId: number; score: number; cluster: number }

/** Margin below the playlist's proven match quality where serving stops.
 *  Calibrated on real playlists (2026-07-19): healthy clusters' 10th-best
 *  candidates spread ≈0.73–0.81 within one playlist (spread ~0.08) while
 *  an outlier cluster's best sat 0.19 below the median — 0.08 cleanly
 *  separates "this playlist's weaker corner" from "nothing fits". */
const FLOOR_MARGIN = 0.08
const FLOOR_PROBE_RANK = 9    // 10th-best candidate = the cluster's proven depth
// Enough candidates for the renderer's round-robin to actually have a choice.
// Below this the strip visibly starves — see the backfill below.
const MIN_SERVABLE_HITS = 40
const LAMBDA = 0.3            // global-center penalty
const PER_CLUSTER_POOL = 60
// Playlist NAME + DESCRIPTION as a clue (2026-09-04, Jake: "use the playlist
// title and description as clues as to what should be suggested as well as
// the music inside"). The text is embedded with the same model as the
// tracks, then (a) every candidate gets a small bonus for matching it and
// (b) the best text matches form their OWN sub-vibe pool with a seat share,
// so "Dinner Party" pulls dinner-party songs the audio alone wouldn't reach.
// Text↔track cosines sit on a lower scale than track↔track, so the hint
// pool is ranked on its own and never enters the quality-floor math.
const HINT_W = 0.15
const HINT_SEED_SHARE = 0.2
// The name only counts when the MUSIC agrees with it (Jake: "sometimes a
// playlist name I use means absolutely nothing (baseball, fuck) but
// sometimes they do mean something!!! it varies!"). Gate: how much closer
// are the playlist's own songs to the hint text than the library at large,
// in library-σ units. Calibrated on the real playlists 2026-09-04:
// METAL VOL 1 2.05, Rhymes 1.47, Songs That Mix Well 1.49, Movies 1.20,
// Weirdtronic 1.04, Salt Air Drift 0.81, Indie sleaze 0.68 → ON;
// Fuck 0.43, Pool 0.42, Bops 0.21, Dinner Party 0.04, Baseball 0.03 → OFF.
const HINT_MIN_Z = 0.6

/**
 * The full scoring pass: k-means the seed vectors into sub-vibes, assign
 * every candidate to its nearest sub-vibe, floor out clusters that can't
 * produce real matches, return the per-cluster top pools (cluster-tagged
 * for the renderer's round-robin).
 */
export function scorePlaylistCandidates(
  seeds: Float32Array[],
  candidates: Iterable<[number, Float32Array]>,
  globalCentroid: Float32Array | null,
  clusters = 5,
  hint: Float32Array | null = null,
): { hits: VibeHit[]; clusterSeeds: number[] } {
  if (seeds.length === 0) return { hits: [], clusterSeeds: [] }
  const cents = kmeansCentroids(seeds, Math.max(1, Math.min(clusters, seeds.length)))
  // How many PLAYLIST songs seeded each sub-vibe. The renderer weights
  // strip seats by this share: farthest-point init deliberately hands an
  // outlier its own cluster (that's the quality-floor design), but a
  // 1-song corner on a 21-track playlist must not buy a guaranteed seat —
  // that's how Pantera kept landing on pool dos (Jake, 2026-08-07).
  const clusterSeeds = new Array<number>(cents.length).fill(0)
  for (const s of seeds) {
    let bi = 0, bs = -2
    for (let c = 0; c < cents.length; c++) { const sim = cosine(s, cents[c]); if (sim > bs) { bs = sim; bi = c } }
    clusterSeeds[bi]++
  }
  const perCluster: Array<Array<{ trackId: number; score: number; rawSim: number; hs: number; gpen: number }>> = cents.map(() => [])
  let hsSum = 0, hsSq = 0, hsN = 0
  for (const [tid, vec] of candidates) {
    let bi = 0, bs = -2
    for (let c = 0; c < cents.length; c++) { const s = cosine(vec, cents[c]); if (s > bs) { bs = s; bi = c } }
    const gpen = globalCentroid ? LAMBDA * cosine(vec, globalCentroid) : 0
    const hs = hint ? cosine(vec, hint) : 0
    if (hint) { hsSum += hs; hsSq += hs * hs; hsN++ }
    perCluster[bi].push({ trackId: tid, score: bs - gpen, rawSim: bs, hs, gpen })
  }
  // Does the music agree with the name? (see HINT_MIN_Z)
  let hintOn = false
  if (hint && hsN > 1 && seeds.length > 0) {
    const cmean = hsSum / hsN
    const csd = Math.sqrt(Math.max(0, hsSq / hsN - cmean * cmean)) || 1
    const smean = seeds.reduce((a, v) => a + cosine(v, hint), 0) / seeds.length
    hintOn = (smean - cmean) / csd >= HINT_MIN_Z
  }
  if (hintOn) for (const list of perCluster) for (const h of list) h.score += HINT_W * h.hs

  // The floor: what does a GOOD match look like for this playlist? Median
  // of each cluster's 10th-best raw similarity, minus the margin. By
  // construction at least half the clusters clear it.
  const depths = perCluster
    .map((list) => [...list].sort((a, b) => b.rawSim - a.rawSim)[Math.min(FLOOR_PROBE_RANK, Math.max(0, list.length - 1))]?.rawSim)
    .filter((d): d is number => typeof d === 'number')
    .sort((a, b) => a - b)
  const floor = depths.length ? depths[depths.length >> 1] - FLOOR_MARGIN : -Infinity

  // 2026-08-25 (Jake, on a 7-song playlist: "only 2 suggestions?????") —
  // BACKFILL. The floor asks "what does a good match look like for THIS
  // playlist", which is right for a playlist with one clear character. On a
  // genuinely eclectic one (School of Rock -> Kompromat -> India Ramey -> XTC)
  // the clusters scatter, almost nothing clears the bar, and the strip served
  // TWO cards. An empty strip is not a quality signal, it just looks broken.
  // So: take the floor's picks first, then, if the pool is too thin for the
  // renderer to choose from, relax in steps and keep taking the best remaining
  // — still best-first, never random. Same doctrine as the discovery lane's
  // LANE_MIN: a small shelf of decent picks beats an empty one.
  const collect = (cut: number): VibeHit[] => {
    const out: VibeHit[] = []
    perCluster.forEach((list, c) => {
      const servable = list.filter((h) => h.rawSim >= cut)
      servable.sort((a, b) => b.score - a.score)
      for (const h of servable.slice(0, PER_CLUSTER_POOL)) out.push({ trackId: h.trackId, score: h.score, cluster: c })
    })
    return out
  }
  let hits = collect(floor)
  // ...but ONLY for a mosaic. A playlist with a dominant character is SUPPOSED
  // to shed its outlier corner — the one metal track in a chill playlist must
  // not start pulling metal suggestions, which is the contract the
  // "outlier seed cluster ... serves NOTHING" test pins. Relax only when no
  // single vibe holds half the seeds, i.e. the playlist really is a mosaic and
  // there is no dominant character to protect.
  const totalSeeds = clusterSeeds.reduce((a, b) => a + b, 0)
  const dominant = totalSeeds > 0 && Math.max(...clusterSeeds) / totalSeeds >= 0.5
  if (!dominant) {
    for (const relax of [0.05, 0.12, 0.25]) {
      if (hits.length >= MIN_SERVABLE_HITS) break
      hits = collect(floor - relax)
    }
  }
  // The hint's own pool: cluster index K (after the audio sub-vibes), seeded
  // as if a fifth of the playlist had voted for it (min 2 → seat-eligible),
  // so the name/description always earns a strip seat but never outvotes
  // the music. Ranked on its own scale; the floor above never sees it.
  if (hintOn) {
    const K = cents.length
    // "Matches the name AND sounds like the playlist": text matches that
    // fail the audio floor are lyrics-only coincidences ("Movies" pulled
    // Arcade Fire's Everything Now, Tenacious D's The Metal) — out.
    const hintPool = perCluster.flat().filter((h) => h.rawSim >= floor).map((h) => ({ trackId: h.trackId, score: h.hs - h.gpen })).sort((a, b) => b.score - a.score)
    for (const h of hintPool.slice(0, PER_CLUSTER_POOL)) hits.push({ trackId: h.trackId, score: h.score, cluster: K })
    clusterSeeds.push(Math.max(2, Math.round(seeds.length * HINT_SEED_SHARE)))
  }
  return { hits, clusterSeeds }
}
