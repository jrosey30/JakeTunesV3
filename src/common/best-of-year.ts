/**
 * Best of <year> — the default year-end playlist (2026-08-22, Jake: "build
 * an default playlist: best of 2026. no more than 2 songs per album. mix
 * them up. 40 songs").
 *
 * Pure and node-tested; lives in common/ because the shared smart-playlist
 * evaluator (renderer + iPod sync) is the consumer.
 *
 * "Best" is Jake's own signals, nothing invented: stars dominate, plays
 * refine. "Mix them up" is a SEEDED shuffle — the same year always deals
 * the same order (a default playlist that silently reshuffles between
 * visits reads as broken) — followed by a spread pass so the same artist
 * or album never plays back-to-back when it can be helped.
 */

export interface BestOfInput {
  id: number
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  year?: string | number
  rating?: number
  playCount?: number
}

const nk = (s: string | undefined): string => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()

/** Deterministic PRNG (mulberry32) — the mix must be stable per seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function albumKey(t: BestOfInput): string {
  const album = nk(t.album)
  // An album-less single can't hog a cap it doesn't belong to.
  if (!album) return `solo|${t.id}`
  return `${nk(t.albumArtist || t.artist)}|${album}`
}

const artistKey = (t: BestOfInput): string => nk(t.albumArtist || t.artist)

export function pickBestOfYear<T extends BestOfInput>(
  tracks: T[],
  opts: { year: number; limit?: number; perAlbum?: number; seed?: number },
): T[] {
  const limit = opts.limit ?? 40
  const perAlbum = opts.perAlbum ?? 2
  const seed = opts.seed ?? opts.year

  const score = (t: T): number => (Number(t.rating) || 0) * 25 + Math.min(Number(t.playCount) || 0, 40)
  const ranked = tracks
    .filter((t) => Number(t.year) === opts.year)
    .sort((a, b) => score(b) - score(a)
      || (Number(b.playCount) || 0) - (Number(a.playCount) || 0)
      || String(a.title || '').localeCompare(String(b.title || '')))

  // Greedy take under the per-album cap.
  const perAlbumCount = new Map<string, number>()
  const chosen: T[] = []
  for (const t of ranked) {
    const k = albumKey(t)
    const n = perAlbumCount.get(k) || 0
    if (n >= perAlbum) continue
    perAlbumCount.set(k, n + 1)
    chosen.push(t)
    if (chosen.length >= limit) break
  }

  // Seeded Fisher–Yates: the mix.
  const rand = rng(seed)
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[chosen[i], chosen[j]] = [chosen[j], chosen[i]]
  }

  // Spread pass: if a neighbor repeats the artist or album, swap in the
  // next later track that breaks the run. One sweep — best-effort, not a
  // solver; a two-album year can still touch, and that's fine.
  for (let i = 1; i < chosen.length; i++) {
    const prev = chosen[i - 1]
    if (artistKey(chosen[i]) !== artistKey(prev) && albumKey(chosen[i]) !== albumKey(prev)) continue
    for (let j = i + 1; j < chosen.length; j++) {
      if (artistKey(chosen[j]) !== artistKey(prev) && albumKey(chosen[j]) !== albumKey(prev)) {
        ;[chosen[i], chosen[j]] = [chosen[j], chosen[i]]
        break
      }
    }
  }

  return chosen
}
