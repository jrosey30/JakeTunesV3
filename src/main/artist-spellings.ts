/**
 * Other spellings of a library artist, from MusicBrainz (2026-10-11).
 *
 * The library tags Molchat Doma as "Молчат Дома" and Hadag Nahash as
 * "הדג נחש", but venue feeds and Ticketmaster write "Molchat Doma" and
 * "Hadag Nahash". No fold bridges a transliteration, so a show by one of
 * Jake's own artists never read as his. MusicBrainz knows both: the name,
 * the sort name ("Sakharof, Berry", put back in order) and the aliases.
 *
 * Only artists whose name has letters of another script are looked up — a
 * Latin name is already what the feeds print. Pure: the network and the
 * cache file are injected (artist-spellings-store.ts wires them).
 * ⚠️ TWIN: ~/JakeTunesMobile/backend/src/util/artistSpellings.ts — same
 * picker, same spellings; SPELLING_FIXTURES is shared verbatim by both suites.
 */
import { hasOtherScript, nameKey } from '../common/fold-text.ts'
import { MB_ARTIST_QUERY } from './artist-tags.ts'

export interface SpellingEntry { spellings: string[]; at: number }
export type SpellingCache = Record<string, SpellingEntry>

/** Re-ask after this long; aliases change rarely. */
export const SPELLING_TTL_MS = 120 * 24 * 3600 * 1000

export type MbArtistNames = {
  id?: string
  name?: string
  'sort-name'?: string
  score?: number
  aliases?: Array<{ name?: string }>
}

/**
 * The ONE artist MusicBrainz lists under exactly this name, as its name or
 * an alias. Two or more → none: a wrong artist's spellings would mark a
 * stranger's show as Jake's.
 */
export function pickMbArtist(artists: MbArtistNames[] | undefined, artist: string): MbArtistNames | undefined {
  const want = nameKey(artist, '')
  if (!want) return undefined
  const hits = (artists ?? []).filter((a) => (a.score ?? 0) >= 80
    && [a.name, ...(a.aliases ?? []).map((x) => x.name)].some((n) => nameKey(n, '') === want))
  return hits.length === 1 ? hits[0] : undefined
}

/** "Sakharof, Berry" → "Berry Sakharof"; "Doors, The" → "The Doors". */
function unSorted(sortName: string): string {
  const m = /^([^,]+),\s*([^,]+)$/.exec(sortName.trim())
  return m ? `${m[2]} ${m[1]}` : sortName.trim()
}

/** Every other way MusicBrainz writes the artist, the library's own spelling
 *  left out, one per folded key. */
export function mbSpellings(a: MbArtistNames, libraryName: string): string[] {
  const own = nameKey(libraryName, '')
  const seen = new Set<string>([own])
  const out: string[] = []
  for (const s of [a.name, a['sort-name'] ? unSorted(a['sort-name']) : undefined, ...(a.aliases ?? []).map((x) => x.name)]) {
    const k = nameKey(s, '')
    if (!s || !k || seen.has(k)) continue
    seen.add(k)
    out.push(s.trim())
  }
  return out
}

/** MusicBrainz → the spellings. null when MusicBrainz could not answer (busy,
 *  offline) — not cached, asked again later. [] is a real answer. */
export async function musicBrainzSpellings(artist: string, userAgent: string, fetchFn: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const res = await fetchFn(`https://musicbrainz.org/ws/2/artist?query=${MB_ARTIST_QUERY(artist)}&fmt=json&limit=5`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const hit = pickMbArtist(((await res.json()) as { artists?: MbArtistNames[] }).artists, artist)
    return hit ? mbSpellings(hit, artist) : []
  } catch { return null }
}

/** The library artists worth looking up: names with another script's letters. */
export function otherScriptArtists(names: Iterable<string>): string[] {
  const out = new Map<string, string>()
  for (const n of names) {
    const t = String(n ?? '').trim()
    if (t && hasOtherScript(t) && !out.has(nameKey(t))) out.set(nameKey(t), t)
  }
  return [...out.values()]
}

/** Every cached spelling of these artists (stale entries still count — an
 *  old alias is still an alias). */
export function cachedSpellings(cache: SpellingCache, artists: string[]): string[] {
  return artists.flatMap((a) => cache[nameKey(a)]?.spellings ?? [])
}

/** Artists with no entry, or one older than the TTL. */
export function staleSpellingArtists(cache: SpellingCache, artists: string[], now: number): string[] {
  return artists.filter((a) => { const e = cache[nameKey(a)]; return !e || now - e.at >= SPELLING_TTL_MS })
}

/** Look up stale artists, at most `maxLookups`, through the shared throttle.
 *  Writes answers into `cache`; returns how many were answered. */
export async function ensureSpellings(
  artists: string[],
  cache: SpellingCache,
  opts: { fetchSpellings: (artist: string) => Promise<string[] | null>; throttle: () => Promise<void>; now: number; maxLookups?: number },
): Promise<number> {
  let n = 0
  for (const a of staleSpellingArtists(cache, artists, opts.now).slice(0, opts.maxLookups ?? 10)) {
    await opts.throttle()
    const spellings = await opts.fetchSpellings(a)
    if (spellings) { cache[nameKey(a)] = { spellings, at: opts.now }; n++ }
  }
  return n
}
