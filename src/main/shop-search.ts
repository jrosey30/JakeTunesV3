/**
 * The Record Shop's grouped search and its artist page (Brief 256).
 *
 * One search asks Apple three things at once: songs (the existing
 * searchItunesSuggestions, unchanged), artists (`entity=musicArtist`) and
 * albums (`entity=album`, searched directly instead of built from song hits).
 * Apple's album search leaves explicit editions out, so a cleaned album row
 * is repointed at its uncensored edition the way the song rows are
 * (fetchExplicitAlbumMap + resolveExplicitEdition).
 *
 * Apple 403s the whole home connection after a few hundred searches, so a
 * whole answer is kept for ten minutes per query, every Apple question this
 * module asks (the song search's included) is kept as well (appleJson), and
 * two callers asking the same thing share one request. A new query costs
 * what the song search cost before the shop, plus the one album search. The ranking is common/shop-search.ts (pure).
 */
import { createAnswerCache } from '../common/answer-cache.ts'
import { appleAlbumRows, appleArtistRows, artistReleases, rankShop, type ArtistReleases, type ShopAlbum, type ShopArtistAnswer, type ShopSearchAnswer as ShopSearchAnswerOf } from '../common/shop-search.ts'
import { nameKey } from '../common/fold-text.ts'
import { addExplicitAlbums, explicitLookupUrl, resolveExplicitEdition, searchItunesSuggestions, shopArtistSearchUrl, type ItunesSuggestion } from './download-search.ts'

export type ShopSearchAnswer = ShopSearchAnswerOf<ItunesSuggestion>
export type { ShopArtistAnswer }

const TEN_MIN = 10 * 60_000
const apple = createAnswerCache<{ results?: Array<Record<string, unknown>> }>({ ttlMs: TEN_MIN, failQuietMs: 3000, maxEntries: 300, now: () => Date.now() })
const answers = createAnswerCache<ShopSearchAnswer>({ ttlMs: TEN_MIN, failQuietMs: 0, maxEntries: 100, now: () => Date.now() })

/**
 * One Apple question, kept ten minutes, shared by every caller asking the same
 * URL. `retry`: a refusal (Apple's throttle: 403, 429, 5xx) gets one more try
 * 400 ms later, as the song search always did; a timeout or a dropped
 * connection is not asked twice. Null = no answer.
 */
export function appleJson(url: string, timeoutMs: number, o: { retry?: boolean } = {}): Promise<{ results?: Array<Record<string, unknown>> } | null> {
  return apple.ask(url, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response
      try { res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }) } catch { return null }
      if (res.ok) {
        try { return (await res.json()) as { results?: Array<Record<string, unknown>> } } catch { return null }
      }
      if (!o.retry || attempt > 0) return null
      await new Promise((r) => setTimeout(r, 400))
    }
    return null
  })
}

/**
 * Cleaned album rows repointed at their uncensored edition, when Apple has one
 * under the same record. The lookups go through appleJson, so the song
 * search's own explicit lookups and an artist page opened next are the same
 * requests. A rescued row wears the explicit edition's own size and cover;
 * a size the lookup didn't give is left unset, never the clean one's.
 */
async function rescueExplicit(albums: ShopAlbum[]): Promise<ShopAlbum[]> {
  const ids = [...new Set(albums.filter((a) => a.explicitness === 'cleaned' && a.artistId).map((a) => a.artistId as number))].slice(0, 3)
  if (!ids.length) return albums
  const map = new Map<string, { id: number; trackCount?: number }>()
  const editions = new Map<number, ShopAlbum>()
  await Promise.all(ids.map(async (id) => {
    const raw = await appleJson(explicitLookupUrl(id), 6000, { retry: false })
    if (!raw) return
    addExplicitAlbums(map, raw.results)
    for (const e of appleAlbumRows(raw.results)) if (!editions.has(e.collectionId)) editions.set(e.collectionId, e)
  }))
  if (!map.size) return albums
  return albums.map((a) => {
    if (a.explicitness !== 'cleaned') return a
    const up = resolveExplicitEdition(a.name, a.trackCount, map)
    if (!up) return a
    const ed = editions.get(up.id)
    return { ...a, collectionId: up.id, explicitness: 'explicit', trackCount: ed?.trackCount, artworkUrl: ed?.artworkUrl ?? a.artworkUrl }
  })
}

const searching = new Map<string, Promise<ShopSearchAnswer>>()

export async function searchShopCatalog(query: string): Promise<ShopSearchAnswer> {
  const q = String(query || '').trim()
  if (q.length < 2) return { ok: true, songs: [], songsOk: true, artists: [], albums: [], albumsOk: true }
  const k = nameKey(q)
  const have = answers.get(k)
  if (have) return have
  const running = searching.get(k)
  if (running) return running
  const p = (async (): Promise<ShopSearchAnswer> => {
    const term = encodeURIComponent(q)
    const [songs, artistsRaw, albumsRaw] = await Promise.all([
      // Through appleJson: its artist question below and its explicit lookups
      // are the same requests as the shop's own, asked once.
      searchItunesSuggestions(q, { json: appleJson }).catch(() => ({ ok: false, results: [] as ItunesSuggestion[], source: undefined })),
      appleJson(shopArtistSearchUrl(q), 3500, { retry: false }),
      appleJson(`https://itunes.apple.com/search?term=${term}&entity=album&limit=50`, 4000, { retry: true }),
    ])
    const albums = albumsRaw ? await rescueExplicit(appleAlbumRows(albumsRaw.results)) : []
    const ranked = rankShop(q, appleArtistRows(artistsRaw?.results), albums)
    const out: ShopSearchAnswer = {
      ok: songs.ok || !!albumsRaw || !!artistsRaw,
      songs: songs.results,
      songsOk: songs.ok,
      artists: ranked.artists,
      albums: ranked.albums,
      albumsOk: !!albumsRaw,
    }
    // Only a whole answer is kept: a throttled half is asked again next time.
    // Songs from Deezer mean Apple refused the song search: not whole either.
    if (songs.ok && songs.source === 'apple' && albumsRaw && artistsRaw) answers.put(k, out)
    return out
  })().finally(() => { searching.delete(k) })
  searching.set(k, p)
  return p
}

/** An artist's own albums, EPs and singles (one lookup, kept ten minutes). */
export async function shopArtistReleases(artistId: number, name: string): Promise<ShopArtistAnswer> {
  const id = Number(artistId)
  const empty: ArtistReleases = { albums: [], eps: [], singles: [] }
  if (!Number.isFinite(id) || id <= 0) return { ok: false, releases: empty }
  const raw = await appleJson(explicitLookupUrl(id), 8000, { retry: true })
  if (!raw) return { ok: false, releases: empty }
  const artist = appleArtistRows(raw.results).find((a) => a.artistId === id) ?? { artistId: id, name: String(name || '') }
  return { ok: true, artist, releases: artistReleases(appleAlbumRows(raw.results), artist) }
}

/** Tests only. */
export function resetShopSearchCachesForTests(): void { apple.clear(); answers.clear(); searching.clear() }
