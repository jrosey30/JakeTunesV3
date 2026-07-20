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
const LAMBDA = 0.3            // global-center penalty
const PER_CLUSTER_POOL = 60

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
): VibeHit[] {
  if (seeds.length === 0) return []
  const cents = kmeansCentroids(seeds, Math.max(1, Math.min(clusters, seeds.length)))
  const perCluster: Array<Array<{ trackId: number; score: number; rawSim: number }>> = cents.map(() => [])
  for (const [tid, vec] of candidates) {
    let bi = 0, bs = -2
    for (let c = 0; c < cents.length; c++) { const s = cosine(vec, cents[c]); if (s > bs) { bs = s; bi = c } }
    const score = bs - (globalCentroid ? LAMBDA * cosine(vec, globalCentroid) : 0)
    perCluster[bi].push({ trackId: tid, score, rawSim: bs })
  }

  // The floor: what does a GOOD match look like for this playlist? Median
  // of each cluster's 10th-best raw similarity, minus the margin. By
  // construction at least half the clusters clear it.
  const depths = perCluster
    .map((list) => [...list].sort((a, b) => b.rawSim - a.rawSim)[Math.min(FLOOR_PROBE_RANK, Math.max(0, list.length - 1))]?.rawSim)
    .filter((d): d is number => typeof d === 'number')
    .sort((a, b) => a - b)
  const floor = depths.length ? depths[depths.length >> 1] - FLOOR_MARGIN : -Infinity

  const hits: VibeHit[] = []
  perCluster.forEach((list, c) => {
    const servable = list.filter((h) => h.rawSim >= floor)
    servable.sort((a, b) => b.score - a.score)
    for (const h of servable.slice(0, PER_CLUSTER_POOL)) hits.push({ trackId: h.trackId, score: h.score, cluster: c })
  })
  return hits
}
