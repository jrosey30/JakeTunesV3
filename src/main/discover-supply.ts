/**
 * Bulk discovery supply (2026-08-26).
 *
 * Jake: "the record shop is a waste of my time....it shows an insane amount of
 * minimal music. i need a huge amount of new music suggestions in here. 25 new
 * songs each day as well as 25 new albums that I DO NOT HAVE IN MY LIBRARY.
 * NO LESS"
 *
 * The old shop was built around a handful of journalism picks — a dozen names a
 * day, then whatever survived verification. It structurally could not reach 50.
 * This does, from a source that is both deep and taste-shaped: Deezer's
 * related-artist graph. Each anchor returns ~20 neighbours and each neighbour
 * ~13 albums plus top tracks, so 16 anchors is thousands of candidates — all
 * adjacent to what Jake already plays, no key required, no Apple rate limit.
 *
 * THE HARD RULE is the quota: 25 albums and 25 songs, none of them already in
 * the library. If a pass falls short it widens (more anchors, more neighbours,
 * second-hop) rather than shipping 19 and calling it done.
 */

export interface SupplyDeps {
  fetchJson: (url: string) => Promise<unknown>
  /** true when the library already has this album (artist+album). */
  ownsAlbum: (artist: string, album: string) => boolean
  /** true when the library already has this song (artist+title). */
  ownsSong: (artist: string, title: string) => boolean
  /** true when the library already has this ARTIST at all. */
  ownsArtist: (artist: string) => boolean
}

export interface SupplyAlbum { artist: string; title: string; year?: string; artUrl?: string; recordType?: string; deezerId?: number; because?: string }
export interface SupplySong { artist: string; title: string; artUrl?: string; previewUrl?: string; deezerId?: number; because?: string }

const API = 'https://api.deezer.com'
const arr = (o: unknown): Array<Record<string, unknown>> => {
  const d = (o as { data?: unknown })?.data
  return Array.isArray(d) ? d as Array<Record<string, unknown>> : []
}
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const nameOf = (o: unknown): string => str((o as { name?: unknown })?.name)

/** Deterministic per-day rotation: same picks all day, different tomorrow. */
export function dayStride(dayNumber: number, poolSize: number, want: number): number[] {
  if (poolSize <= 0) return []
  const target = Math.min(want, poolSize)
  const start = (dayNumber * 13) % poolSize
  // The stride MUST be coprime with the pool size: a shared factor makes the
  // walk cycle over a subset forever (stride 8 on a pool of 10 only ever
  // visits 5 indices). Bump until coprime — stride 1 always is, so this
  // terminates. Coprimality then guarantees the first `target` hops are
  // unique with no bookkeeping.
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  let stride = 1 + (dayNumber * 7) % Math.max(1, poolSize - 1)
  while (gcd(stride % poolSize || poolSize, poolSize) !== 1) stride++
  const out: number[] = []
  for (let k = 0; k < target; k++) out.push((start + k * stride) % poolSize)
  return out
}

/** Neighbours of the anchors, nearest first, de-duplicated, owned artists last. */
export async function relatedArtistPool(
  anchors: string[],
  deps: SupplyDeps,
): Promise<Array<{ id: number; name: string; anchor: string; owned: boolean }>> {
  const seen = new Set<string>()
  const pool: Array<{ id: number; name: string; anchor: string; owned: boolean }> = []
  for (const anchor of anchors) {
    const found = arr(await deps.fetchJson(`${API}/search/artist?q=${encodeURIComponent(anchor)}&limit=1`).catch(() => null))
    const id = Number((found[0] as { id?: unknown })?.id)
    if (!Number.isFinite(id)) continue
    for (const r of arr(await deps.fetchJson(`${API}/artist/${id}/related?limit=50`).catch(() => null))) {
      const name = nameOf(r)
      const rid = Number((r as { id?: unknown }).id)
      const key = name.toLowerCase()
      if (!name || !Number.isFinite(rid) || seen.has(key)) continue
      seen.add(key)
      pool.push({ id: rid, name, anchor, owned: deps.ownsArtist(name) })
    }
  }
  // Artists Jake does NOT already own lead — that is what "new music" means.
  return [...pool.filter((a) => !a.owned), ...pool.filter((a) => a.owned)]
}

// ⚠️ TWIN: src/main/discover-feed.ts JUNK_RELEASE (journalism/gap lanes) —
// same purpose, different lane. This one ALSO refuses non-canonical
// EDITIONS: the shop's doctrine is canonical studio releases only, and the
// first live harvest (2026-08-27) seated "Culture III (Deluxe)" and "The
// Best of Sid Vicious (Live)". Over-refusal is the safe direction — the
// 40-card headroom absorbs a false reject; a Deluxe on the shelf is the
// "insane amount of minimal music" complaint all over again.
const JUNK = new RegExp([
  'karaoke', 'tribute', 'made famous', 'instrumental version', '\\bcovers? of\\b',
  '\\bdeluxe\\b', '\\bexpanded\\b', 'remaster', '\\banniversary\\b', '\\breissue\\b',
  '\\bbest of\\b', 'greatest hits', '\\banthology\\b', '\\bb-?sides\\b',
  '\\blive (at|in|from)\\b', '\\([^)]*\\b(live|acoustic|demos?|unplugged)\\b[^)]*\\)',
  '\\bdemos?\\b', '\\bunplugged\\b', '\\bsessions?\\b', '\\bbootleg\\b', '\\bouttakes?\\b',
].join('|'), 'i')

/** Albums he does not own, real records only, newest first. */
export async function harvestAlbums(
  pool: Array<{ id: number; name: string; anchor: string }>,
  want: number,
  deps: SupplyDeps,
): Promise<SupplyAlbum[]> {
  const out: SupplyAlbum[] = []
  const perArtist = new Map<string, number>()
  for (const a of pool) {
    if (out.length >= want) break
    for (const al of arr(await deps.fetchJson(`${API}/artist/${a.id}/albums?limit=25`).catch(() => null))) {
      if (out.length >= want) break
      const title = str(al.title)
      if (!title || JUNK.test(title)) continue
      if (String(al.record_type || '') !== 'album') continue      // no singles/EPs padding the count
      if (deps.ownsAlbum(a.name, title)) continue                  // THE hard rule
      const n = perArtist.get(a.name) || 0
      if (n >= 2) continue                                         // no one artist owning the shelf
      perArtist.set(a.name, n + 1)
      out.push({
        artist: a.name, title,
        year: str(al.release_date).slice(0, 4) || undefined,
        artUrl: str(al.cover_big) || str(al.cover_medium) || undefined,
        recordType: str(al.record_type) || undefined,
        deezerId: Number(al.id) || undefined,
        because: a.anchor,
      })
    }
  }
  return out
}

/** Songs he does not own, with a 30s preview wherever Deezer has one. */
export async function harvestSongs(
  pool: Array<{ id: number; name: string; anchor: string }>,
  want: number,
  deps: SupplyDeps,
): Promise<SupplySong[]> {
  const out: SupplySong[] = []
  const perArtist = new Map<string, number>()
  for (const a of pool) {
    if (out.length >= want) break
    for (const t of arr(await deps.fetchJson(`${API}/artist/${a.id}/top?limit=10`).catch(() => null))) {
      if (out.length >= want) break
      const title = str(t.title)
      if (!title || JUNK.test(title)) continue
      if (deps.ownsSong(a.name, title)) continue                   // THE hard rule
      const n = perArtist.get(a.name) || 0
      if (n >= 2) continue
      perArtist.set(a.name, n + 1)
      const album = t.album as { cover_big?: string; cover_medium?: string } | undefined
      out.push({
        artist: a.name, title,
        artUrl: album?.cover_big || album?.cover_medium,
        previewUrl: str(t.preview) || undefined,
        deezerId: Number(t.id) || undefined,
        because: a.anchor,
      })
    }
  }
  return out
}

export interface DailyDiscovery {
  albums: SupplyAlbum[]
  songs: SupplySong[]
  /** What actually happened — so a shortfall is REPORTED, never hidden. */
  report: { albumsWanted: number; songsWanted: number; poolSize: number; passes: number; shortfall: string[] }
}

/**
 * The daily shop: N albums and N songs, none of them already owned.
 *
 * Jake's spec is a QUOTA, not a suggestion — "25 new songs each day as well as
 * 25 new albums that I DO NOT HAVE IN MY LIBRARY. NO LESS". So this widens
 * until it fills: pass 1 walks the nearest neighbours, and each later pass
 * reaches further out (neighbours of the neighbours) rather than giving up at
 * 19 and calling it a day.
 *
 * If it still cannot fill after `maxPasses` it does NOT pad with owned music or
 * with singles — it returns what it has AND says so in `report.shortfall`. A
 * quiet 19 is how the old shop got away with being thin for weeks.
 */
export async function buildDailyDiscovery(
  anchors: string[],
  deps: SupplyDeps,
  opts: { want?: number; dayNumber?: number; maxPasses?: number } = {},
): Promise<DailyDiscovery> {
  const want = opts.want ?? 25
  const maxPasses = opts.maxPasses ?? 3
  const dayNumber = opts.dayNumber ?? Math.floor(Date.now() / 86_400_000)
  const shortfall: string[] = []

  let pool = await relatedArtistPool(anchors, deps)
  // Rotate the ENTRY POINT daily so today's shop is not yesterday's shop, while
  // staying stable within the day (no reshuffling under Jake mid-browse).
  if (pool.length > 1) {
    const order = dayStride(dayNumber, pool.length, pool.length)
    pool = order.map((i) => pool[i])
  }

  const albums: SupplyAlbum[] = []
  const songs: SupplySong[] = []
  const seenAlbum = new Set<string>()
  const seenSong = new Set<string>()
  const key = (a: string, b: string): string => `${a} ${b}`.toLowerCase()

  let passes = 0
  let frontier = pool
  while (passes < maxPasses && (albums.length < want || songs.length < want)) {
    passes++
    if (albums.length < want) {
      for (const a of await harvestAlbums(frontier, (want - albums.length) * 3, deps)) {
        const k = key(a.artist, a.title)
        if (seenAlbum.has(k)) continue
        seenAlbum.add(k)
        albums.push(a)
        if (albums.length >= want) break
      }
    }
    if (songs.length < want) {
      for (const s of await harvestSongs(frontier, (want - songs.length) * 3, deps)) {
        const k = key(s.artist, s.title)
        if (seenSong.has(k)) continue
        seenSong.add(k)
        songs.push(s)
        if (songs.length >= want) break
      }
    }
    if (albums.length >= want && songs.length >= want) break
    // Reach further: neighbours OF the neighbours we just used.
    const nextNames = frontier.slice(0, 8).map((a) => a.name)
    if (!nextNames.length) break
    const deeper = await relatedArtistPool(nextNames, deps)
    const known = new Set(frontier.map((a) => a.name.toLowerCase()))
    frontier = deeper.filter((a) => !known.has(a.name.toLowerCase()))
    if (!frontier.length) break
  }

  if (albums.length < want) shortfall.push(`albums ${albums.length}/${want}`)
  if (songs.length < want) shortfall.push(`songs ${songs.length}/${want}`)
  return {
    albums: albums.slice(0, want),
    songs: songs.slice(0, want),
    report: { albumsWanted: want, songsWanted: want, poolSize: pool.length, passes, shortfall },
  }
}
