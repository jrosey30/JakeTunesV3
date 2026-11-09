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

import { isJunkArtistName, looksLikeCoverFactory } from '../common/junk-artist.ts'
import { nameKey } from '../common/fold-text.ts'

export interface SupplyDeps {
  fetchJson: (url: string) => Promise<unknown>
  /** true when the library already has this album (artist+album). */
  ownsAlbum: (artist: string, album: string) => boolean
  /** true when the library already has this song (artist+title). */
  ownsSong: (artist: string, title: string) => boolean
  /** true when the library already has this ARTIST at all. */
  ownsArtist: (artist: string) => boolean
  /** Song and album titles Jake KNOWS by this artist (library + Spotify), to
   *  tell a same-named stranger from the band (resolveDeezerArtist). Absent
   *  or empty = nothing to check against. */
  knownTitles?: (artist: string) => string[]
}

export interface SupplyAlbum { artist: string; title: string; year?: string; artUrl?: string; recordType?: string; deezerId?: number; because?: string }
export interface SupplySong { artist: string; title: string; artUrl?: string; previewUrl?: string; deezerId?: number; because?: string; curated?: string }

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

/** A title as an identity key: brackets and " - Radio Edit" tails dropped. */
const titleKey = (t: string): string =>
  nameKey(String(t || '').replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s+[-–—]\s+.*$/, ''), '')

/**
 * Which Deezer artist IS this anchor? (2026-11-08)
 *
 * The supply lane used to take Deezer's FIRST search hit (`limit=1`), and
 * Deezer ranks a tiny namesake above the band people mean: on 2026-11-08
 * "Eminem" resolved to "Emine'm" (920 fans), "Nirvana" to "Nirvana (UK)",
 * "Sublime" to a 17-fan "SuBlime", "Underworld" to a 40-fan namesake, and
 * "JOSIE." to Jessie J. Their neighbours filled the shop: Nick Jonas, Pixie
 * Lott and Christina Aguilera "because JOSIE.", "The Beatles Revival Band"
 * "because Nirvana" (Jake: "weird/random picks", "not my taste").
 *
 * Now only a hit whose NAME is the anchor's name counts (case, accents and
 * punctuation folded). Same-named acts are tried most fans first, and when
 * Jake knows songs or albums by the anchor (library, Spotify), the act must
 * have one of them among its top tracks or albums: Deezer's only "josie" is
 * a 100-fan stranger with none of JOSIE.'s songs. Nothing confirmed = no
 * anchor: a wrong anchor's neighbours are worse than one anchor fewer.
 */
export async function resolveDeezerArtist(
  anchor: string,
  deps: Pick<SupplyDeps, 'fetchJson' | 'knownTitles'>,
): Promise<{ id: number; name: string } | null> {
  const want = nameKey(anchor, '')
  if (!want) return null
  const found = arr(await deps.fetchJson(`${API}/search/artist?q=${encodeURIComponent(anchor)}&limit=25`).catch(() => null))
  const same: Array<{ id: number; name: string; fans: number }> = []
  for (const r of found) {
    const id = Number((r as { id?: unknown }).id)
    const name = nameOf(r)
    if (!Number.isFinite(id) || nameKey(name, '') !== want) continue
    const fansRaw = Number((r as { nb_fan?: unknown }).nb_fan)
    same.push({ id, name, fans: Number.isFinite(fansRaw) ? fansRaw : -1 })
  }
  same.sort((a, b) => b.fans - a.fans)
  const known = new Set((deps.knownTitles?.(anchor) ?? []).map(titleKey).filter(Boolean))
  if (known.size === 0) return same[0] ? { id: same[0].id, name: same[0].name } : null
  for (const c of same.slice(0, 3)) {
    const top = arr(await deps.fetchJson(`${API}/artist/${c.id}/top?limit=50`).catch(() => null))
    if (top.some((t) => known.has(titleKey(str(t.title))))) return { id: c.id, name: c.name }
    const albums = arr(await deps.fetchJson(`${API}/artist/${c.id}/albums?limit=50`).catch(() => null))
    if (albums.some((al) => known.has(titleKey(str(al.title))))) return { id: c.id, name: c.name }
  }
  return null
}

/** Neighbours of the anchors, nearest first, de-duplicated, owned artists last. */
export async function relatedArtistPool(
  anchors: string[],
  deps: SupplyDeps,
): Promise<Array<{ id: number; name: string; anchor: string; owned: boolean }>> {
  const seen = new Set<string>()
  const pool: Array<{ id: number; name: string; anchor: string; owned: boolean }> = []
  const refused: string[] = []
  const unresolved: string[] = []
  for (const anchor of anchors) {
    const hit = await resolveDeezerArtist(anchor, deps)
    if (!hit) { unresolved.push(anchor); continue }
    const id = hit.id
    for (const r of arr(await deps.fetchJson(`${API}/artist/${id}/related?limit=50`).catch(() => null))) {
      const name = nameOf(r)
      const rid = Number((r as { id?: unknown }).id)
      const key = name.toLowerCase()
      if (!name || !Number.isFinite(rid) || seen.has(key)) continue
      seen.add(key)
      // Deezer's related graph is polluted with cover factories — "Yoyo
      // International Orchestra" is RELATED to Nirvana there. The name and
      // the numbers (fans, fans per album) refuse them before any album is
      // ever looked at (2026-09-21, Jake: "this crap cannot be recommended").
      const { nb_fan, nb_album } = r as { nb_fan?: unknown; nb_album?: unknown }
      if (isJunkArtistName(name) || looksLikeCoverFactory(nb_fan, nb_album)) {
        refused.push(`${name} (${isJunkArtistName(name) ? 'name' : `${nb_fan} fans / ${nb_album} albums`})`)
        continue
      }
      pool.push({ id: rid, name, anchor, owned: deps.ownsArtist(name) })
    }
  }
  if (unresolved.length) console.warn(`[discover-supply] ${unresolved.length} anchor(s) have no Deezer artist of that exact name, left out: ${unresolved.slice(0, 8).join('; ')}${unresolved.length > 8 ? '; …' : ''}`)
  if (refused.length) console.log(`[discover-supply] refused ${refused.length} related act(s) as cover factories: ${refused.slice(0, 6).join('; ')}${refused.length > 6 ? '; …' : ''}`)
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
  'karaoke', 'tribute', 'made famous', 'made popular', 'instrumental version', '\\bcovers? of\\b',
  // 2026-09-21: "The Love Songs of the Beatles - Instrumentals Volume 1"
  // carried none of the words above. Instrumental records, "performed /
  // conducted by" credits and "in the style of" are covers by construction.
  '\\binstrumentals?\\b', '\\bperformed by\\b', '\\bconducted by\\b', '\\bin the style of\\b', '\\boriginally performed\\b', '\\bcover versions?\\b',
  '\\bplays the (music|songs|hits) of\\b', '\\b(music|songs|hits) of the\\b.*\\b(vol|volume)\\b',
  '\\bdeluxe\\b', '\\bexpanded\\b', 'remaster', '\\banniversary\\b', '\\breissue\\b',
  '\\bbest of\\b', 'greatest hits', '\\banthology\\b', '\\bb-?sides\\b',
  '\\blive (at|in|from)\\b', '\\([^)]*\\b(live|acoustic|demos?|unplugged)\\b[^)]*\\)',
  '\\bdemos?\\b', '\\bunplugged\\b', '\\bsessions?\\b', '\\bbootleg\\b', '\\bouttakes?\\b',
  // 2026-11-08, cards on the shelf that day: "The Essential Foo Fighters"
  // (Jake owns nine of their albums: a best-of is songs he already has),
  // "The Sire Years: Complete Albums Box", "Collected Recordings 1983-1989",
  // "Power Ballad (Music From The Motion Picture)", "Tout va bien (Original
  // Soundtrack)", "La hija de todas las rabias (Original Score)", and two
  // Rolling Thunder Revue 1976 tapes named by date and city.
  '\\bessential\\b', '\\bcollected\\b', '\\bcollection\\b', '\\bbox\\s*set\\b', '\\balbums box\\b',
  '\\bcomplete (albums|recordings|works|studio)\\b', '\\bretrospective\\b', '\\bsampler\\b', '\\bvery best\\b',
  '\\bsoundtrack\\b', '\\boriginal score\\b', '\\bmotion picture\\b', '\\bmusic from (the|and inspired)\\b',
  '\\bhome (jam|recordings?)\\b',
  // A concert named by its date: "1976: Fort Collins", "May 23rd".
  '\\b(19|20)\\d\\d:\\s', '\\b(january|february|march|april|may|june|july|august|september|october|november|december) \\d{1,2}(st|nd|rd|th)\\b',
].join('|'), 'i')

/** A title that is not a canonical studio release (compilation, box set, live, tribute, deluxe…). */
export const isJunkEdition = (title: string): boolean => JUNK.test(title)

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

/**
 * Curator picks (2026-09-01): songs from a followed curator's public
 * playlists, resolved on Deezer for art + a 30s preview. Same gates as
 * the graph harvest — JUNK editions refused, owned songs refused,
 * per-artist cap — plus a strict Deezer identity match (wrong artist
 * NEVER resolves; an unresolvable pick is skipped, the pool is deep).
 */
export async function harvestCuratorSongs(
  pool: Array<{ artist: string; title: string; curator: string; playlist: string }>,
  want: number,
  deps: SupplyDeps,
  dayNumber: number,
): Promise<SupplySong[]> {
  const out: SupplySong[] = []
  if (want <= 0 || pool.length === 0) return out
  const order = dayStride(dayNumber, pool.length, pool.length)
  const perArtist = new Map<string, number>()
  const norm = (x: string): string => x.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim()
  for (const idx of order) {
    if (out.length >= want) break
    const c = pool[idx]
    if (!c || JUNK.test(c.title)) continue
    if (deps.ownsSong(c.artist, c.title)) continue
    const n = perArtist.get(c.artist) || 0
    if (n >= 2) continue
    // 2026-09-09: Deezer's advanced syntax (artist:"x" track:"y") returns
    // ZERO rows unauthenticated now — verified on PJ Harvey / Rid of Me and
    // Nirvana / Lithium. Every song in this lane silently missed, and the
    // report called it a shortfall. Plain query; the strict artist/title
    // match below is what keeps it honest, so limit goes up to give the
    // exact row room among covers and remixes.
    const q = encodeURIComponent(`${c.artist} ${c.title}`)
    const rows = arr(await deps.fetchJson(`${API}/search?q=${q}&limit=10`).catch(() => null))
    const hit = rows.find((t) => {
      const ra = norm(str((t.artist as { name?: string } | undefined)?.name || ''))
      const rt = norm(str(t.title))
      const wa = norm(c.artist); const wt = norm(c.title)
      return ra === wa && (rt === wt || (wt.length >= 3 && (rt.startsWith(wt) || wt.startsWith(rt))))
    })
    if (!hit) continue
    perArtist.set(c.artist, n + 1)
    const album = hit.album as { cover_big?: string; cover_medium?: string } | undefined
    out.push({
      artist: c.artist, title: c.title,
      artUrl: album?.cover_big || album?.cover_medium,
      previewUrl: str(hit.preview) || undefined,
      deezerId: Number(hit.id) || undefined,
      curated: c.playlist ? `${c.curator} · ${c.playlist}` : c.curator,
    })
  }
  return out
}

/**
 * Rotate the ENTRY POINT daily so today's shop is not yesterday's shop, while
 * staying stable within the day (no reshuffling under Jake mid-browse).
 *
 * The rotation runs INSIDE each half (2026-11-08). It used to permute the
 * whole pool, which threw away relatedArtistPool's one ordering promise,
 * "artists Jake does NOT own come first": on 2026-11-08 20 of the 50 quota
 * cards were by artists already in the library (Lou Reed, Bob Dylan, John
 * Lennon, Foo Fighters, Metronomy, +44, ...), which is what "already own
 * them" looked like. Owned artists still fill in when the new ones run dry.
 */
export function rotateKeepingNewFirst<T extends { owned: boolean }>(pool: T[], dayNumber: number): T[] {
  const rotate = (part: T[]): T[] => part.length > 1 ? dayStride(dayNumber, part.length, part.length).map((i) => part[i]) : part
  return [...rotate(pool.filter((a) => !a.owned)), ...rotate(pool.filter((a) => a.owned))]
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
  opts: { want?: number; dayNumber?: number; maxPasses?: number; curatorSongs?: Array<{ artist: string; title: string; curator: string; playlist: string }>; curatorSlots?: number } = {},
): Promise<DailyDiscovery> {
  const want = opts.want ?? 25
  const maxPasses = opts.maxPasses ?? 3
  const dayNumber = opts.dayNumber ?? Math.floor(Date.now() / 86_400_000)
  const shortfall: string[] = []

  const pool = rotateKeepingNewFirst(await relatedArtistPool(anchors, deps), dayNumber)

  const albums: SupplyAlbum[] = []
  const songs: SupplySong[] = []
  const seenAlbum = new Set<string>()
  const seenSong = new Set<string>()
  const key = (a: string, b: string): string => `${a} ${b}`.toLowerCase()

  // Curator picks seat first (a few reserved slots, rotated daily); the
  // graph fills the rest of the quota as always.
  if (opts.curatorSongs?.length) {
    const slots = Math.min(opts.curatorSlots ?? 5, want)
    for (const s of await harvestCuratorSongs(opts.curatorSongs, slots, deps, dayNumber)) {
      const k = key(s.artist, s.title)
      if (seenSong.has(k)) continue
      seenSong.add(k)
      songs.push(s)
    }
  }

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
