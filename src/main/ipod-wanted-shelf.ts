/**
 * "For your iPods" — the Record Shop section for what the iPod lists are
 * missing (2026-11-09).
 *
 * Jake: "the songs i dont have for y2k, 80's and indie sleaze....thats the
 * type of stuff that should go in the record shop."
 *
 * homemini keeps, per iPod list, a `wanted` list (JakeTunesMobile backend,
 * util/ipodListWanted.ts): the artists and songs the list's purpose calls for
 * that the library doesn't have. This turns each into a shop row ("Wanted for
 * Indie Sleeze"): for an artist, their best-known record; for a song, that
 * song. Each card says why ("Indie Sleeze is missing Uffie").
 *
 * The rules are the shop's own (#386):
 *   • the act is the one Deezer has under EXACTLY that name, most fans first
 *     (discover-supply resolveDeezerArtist): never a namesake by a near spelling
 *   • the record is a studio album (record_type 'album') that is not a
 *     compilation, box set, live record, tribute, deluxe or soundtrack
 *     (discover-supply isJunkEdition); best-known = the album most of the
 *     artist's top tracks come from, then the one with the most fans
 *   • an artist the library owns never appears (homemini's list may be a day
 *     behind the desktop's library); a song the library owns never appears
 * It recommends only: "+ List" puts it on the Listen List, the same as any shop
 * card. Nothing here downloads.
 *
 * Its own section, after the shop's daily picks: it never takes a New For You
 * slot. Pure but for `fetchJson`; node --test loads it.
 */
import type { IpodList, IpodListWanted } from '../common/ipod-list-doc.ts'
import { isJunkEdition, resolveDeezerArtist } from './discover-supply.ts'
import { nameKey } from '../common/fold-text.ts'

const API = 'https://api.deezer.com'
const VERSION = /\b(remix|mix|live|demo|edit|acoustic|version|instrumental|karaoke|cover|re-?recorded|sped up|slowed)\b/i

export interface WantedCard {
  lane: 'ipod-wanted'
  type: 'album' | 'song'
  artist: string
  title: string
  year?: string
  why: string
  artUrl?: string
  previewUrl?: string
}

export interface WantedShelf { listId: string; listName: string; title: string; cards: WantedCard[] }

export interface WantedShelfDeps {
  fetchJson: (url: string) => Promise<unknown>
  ownsArtist: (artist: string) => boolean
  ownsSong: (artist: string, title: string) => boolean
  ownsAlbum: (artist: string, album: string) => boolean
}

/** What a lookup found for one wanted item; null = nothing that passes the rules. Cacheable. */
export type WantedHit = Omit<WantedCard, 'lane' | 'why'> | null

const rows = (o: unknown): Array<Record<string, unknown>> => {
  const d = (o as { data?: unknown } | null)?.data
  return Array.isArray(d) ? d as Array<Record<string, unknown>> : []
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : -1)

/** The card's line: "Indie Sleeze is missing Uffie" / "… is missing Klaxons' “Golden Skans”". */
export function wantedWhy(listName: string, w: Pick<IpodListWanted, 'artist' | 'title'>): string {
  return w.title ? `${listName} is missing ${w.artist}’s “${w.title}”` : `${listName} is missing ${w.artist}`
}

/** Pure: of an artist's albums, the best-known studio record (null = none passes). */
export function bestKnownAlbum(
  albums: Array<Record<string, unknown>>,
  topTracks: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  const ok = albums.filter((a) => str(a.record_type) === 'album' && str(a.title) && !isJunkEdition(str(a.title)))
  if (!ok.length) return null
  const fromTop = new Map<number, number>()
  topTracks.forEach((t, i) => {
    const id = num((t.album as { id?: unknown } | undefined)?.id)
    if (id >= 0) fromTop.set(id, (fromTop.get(id) ?? 0) + (topTracks.length - i))
  })
  return [...ok].sort((a, b) =>
    (fromTop.get(num(b.id)) ?? 0) - (fromTop.get(num(a.id)) ?? 0) || num(b.fans) - num(a.fans))[0] ?? null
}

/** Deezer: the record the shop shows for one wanted item. */
export async function lookupWanted(w: Pick<IpodListWanted, 'artist' | 'title'>, deps: Pick<WantedShelfDeps, 'fetchJson'>): Promise<WantedHit> {
  if (w.title) {
    const want = { a: nameKey(w.artist, ''), t: nameKey(w.title.replace(/\s*[([].*?[)\]]/g, ''), '') }
    const hits = rows(await deps.fetchJson(`${API}/search?q=${encodeURIComponent(`${w.artist} ${w.title}`)}&limit=15`).catch(() => null))
    // The recording itself: the exact title first; a bracketed tail only when
    // it isn't another version (a remix, live take, demo, edit, cover…).
    const byArtist = hits.filter((t) => nameKey(str((t.artist as { name?: unknown } | undefined)?.name), '') === want.a)
    const hit = byArtist.find((t) => nameKey(str(t.title), '') === nameKey(w.title!, ''))
      ?? byArtist.find((t) => !VERSION.test(str(t.title)) && nameKey(str(t.title).replace(/\s*[([].*?[)\]]/g, ''), '') === want.t)
    if (!hit) return null
    const album = hit.album as { cover_big?: string; cover_medium?: string } | undefined
    return {
      type: 'song', artist: str((hit.artist as { name?: unknown }).name) || w.artist, title: w.title,
      ...(album?.cover_big || album?.cover_medium ? { artUrl: album.cover_big || album.cover_medium } : {}),
      ...(str(hit.preview) ? { previewUrl: str(hit.preview) } : {}),
    }
  }
  const act = await resolveDeezerArtist(w.artist, { fetchJson: deps.fetchJson })
  if (!act) return null
  const albums = rows(await deps.fetchJson(`${API}/artist/${act.id}/albums?limit=100`).catch(() => null))
  const top = rows(await deps.fetchJson(`${API}/artist/${act.id}/top?limit=10`).catch(() => null))
  const best = bestKnownAlbum(albums, top)
  if (!best) return null
  return {
    type: 'album', artist: act.name, title: str(best.title),
    ...(str(best.release_date) ? { year: str(best.release_date).slice(0, 4) } : {}),
    ...(str(best.cover_big) || str(best.cover_medium) ? { artUrl: str(best.cover_big) || str(best.cover_medium) } : {}),
  }
}

export const wantedLookupKey = (w: Pick<IpodListWanted, 'artist' | 'title'>): string => `${nameKey(w.artist, '')}|${nameKey(w.title ?? '', '')}`

/**
 * The section: one shelf per list that wants anything, in the lists' order,
 * at most `perList` cards each. `lookup` may answer from a cache. An owned
 * artist (or song) is skipped before any lookup and again after (Deezer's
 * spelling of the name may be the one the library uses).
 */
export async function buildWantedShelves(
  lists: readonly IpodList[],
  deps: WantedShelfDeps,
  lookup: (w: IpodListWanted) => Promise<WantedHit>,
  opts: { perList?: number } = {},
): Promise<WantedShelf[]> {
  const perList = opts.perList ?? 12
  const out: WantedShelf[] = []
  for (const list of lists) {
    const cards: WantedCard[] = []
    const seen = new Set<string>()
    for (const w of list.wanted ?? []) {
      if (cards.length >= perList) break
      const owned = (artist: string): boolean => w.title ? deps.ownsSong(artist, w.title) : deps.ownsArtist(artist)
      if (owned(w.artist)) continue
      const hit = await lookup(w)
      if (!hit || owned(hit.artist)) continue
      if (hit.type === 'album' && deps.ownsAlbum(hit.artist, hit.title)) continue
      const k = `${nameKey(hit.artist, '')}|${nameKey(hit.title, '')}`
      if (seen.has(k)) continue
      seen.add(k)
      cards.push({ lane: 'ipod-wanted', ...hit, why: wantedWhy(list.name, w) })
    }
    if (cards.length) out.push({ listId: list.id, listName: list.name, title: `Wanted for ${list.name}`, cards })
  }
  return out
}
