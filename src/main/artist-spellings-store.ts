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
import { STATE_DIR } from './state-dir.ts'
import { JsonFileCache } from './state-cache.ts'
import {
  cachedSpellings, ensureSpellings, musicBrainzSpellings, otherScriptArtists, staleSpellingArtists, type SpellingCache,
} from './artist-spellings.ts'

const spellingsCache = new JsonFileCache<SpellingCache>(() => join(STATE_DIR, 'artist-spellings.json'), () => ({}), 'artist-spellings')
let filling: Promise<void> | null = null

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
