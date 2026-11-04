/**
 * Wiring for artist-spellings.ts: the cache file (userData/
 * artist-spellings.json) and one background fill at a time.
 *
 * Never waits on the network. The spellings already cached are used now;
 * missing or stale ones are looked up behind the reply, through the app's
 * shared MusicBrainz throttle, and count from the next call. A failed lookup
 * (MusicBrainz busy) is not cached, so it is asked again next time.
 */
import { join } from 'path'
import { nameKey } from '../common/fold-text.ts'
import { STATE_DIR } from './state-dir.ts'
import { JsonFileCache } from './state-cache.ts'
import {
  cachedSpellings, ensureSpellings, musicBrainzSpellings, otherScriptArtists, staleSpellingArtists, type SpellingCache,
} from './artist-spellings.ts'

const spellingsCache = new JsonFileCache<SpellingCache>(() => join(STATE_DIR, 'artist-spellings.json'), () => ({}), 'artist-spellings')
let filling: Promise<void> | null = null

/** Every other name MusicBrainz knows this artist by, for the downloader
 *  (2026-11-03): Qobuz files The English Beat as "The Beat". Unlike the rest of
 *  this file it waits on the network, because the download is waiting anyway, at
 *  most once per artist per TTL. A busy MusicBrainz answers the stale entry or
 *  nothing, and is asked again next time.
 *  ⚠️ TWIN: JakeTunesMobile/backend/src/util/artistSpellingsStore.ts artistAliases. */
export async function artistAliases(artist: string, deps: { throttle: () => Promise<void>; userAgent: string }): Promise<string[]> {
  const name = artist.trim()
  if (!nameKey(name)) return []
  const work: SpellingCache = { ...(await spellingsCache.get()) }
  const answered = await ensureSpellings([name], work, { fetchSpellings: (a) => musicBrainzSpellings(a, deps.userAgent), throttle: deps.throttle, now: Date.now() })
  if (answered > 0) await spellingsCache.update((cur) => ({ ...cur, [nameKey(name)]: work[nameKey(name)] }))
  return cachedSpellings(work, [name])
}

/** Other spellings of the library's non-Latin artists ("Molchat Doma" for
 *  "Молчат Дома"), as far as they are known right now. */
export async function librarySpellings(
  tracks: Array<{ artist?: string; albumArtist?: string }>,
  deps: { throttle: () => Promise<void>; userAgent: string },
): Promise<string[]> {
  const artists = otherScriptArtists(tracks.map((t) => t.albumArtist || t.artist || ''))
  if (artists.length === 0) return []
  const cache = await spellingsCache.get()
  if (!filling && staleSpellingArtists(cache, artists, Date.now()).length > 0) {
    const work: SpellingCache = { ...cache }
    filling = ensureSpellings(artists, work, { fetchSpellings: (a) => musicBrainzSpellings(a, deps.userAgent), throttle: deps.throttle, now: Date.now() })
      .then(async (n) => {
        if (n === 0) return
        await spellingsCache.update((cur) => ({ ...cur, ...work }))
        console.log(`[spellings] ${n} artist(s) looked up on MusicBrainz`)
      })
      .catch((err) => console.warn('[spellings] lookup failed:', err instanceof Error ? err.message : err))
      .finally(() => { filling = null })
  }
  return cachedSpellings(cache, artists)
}
