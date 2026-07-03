/**
 * Cynthia overhaul — persistent MusicBrainz release cache.
 *
 * musicBrainzAlbumLookup (index.ts) is rate-limited to 1 req/s by MB's
 * rules and was previously uncached across launches — every Cynthia
 * investigation re-paid 1-2s per tool round. This wraps ANY fetcher with
 * a 7-day disk cache (JsonFileCache, same atomic-write machinery as the
 * other sidecars), so the background sweep pays the MB tax once per album
 * per week and interactive investigations get canonical data in
 * microseconds.
 *
 * The fetcher is INJECTED (no import of index.ts — avoids a cycle and
 * makes this trivially testable with a mock).
 */

import { join } from 'path'
import { STATE_DIR } from './state-dir'
import { JsonFileCache } from './state-cache'

interface MbCacheEntry {
  fetchedAt: number   // epoch ms
  raw: string         // the JSON string the lookup returned, verbatim
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000

const mbCache = new JsonFileCache<Record<string, MbCacheEntry>>(
  () => join(STATE_DIR, 'mb-release-cache.json'),
  () => ({}),
  'mb-release-cache',
)

export function mbCacheKey(artist: string, album: string): string {
  return `${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`
}

/**
 * Cached lookup. `fetcher` is only invoked on miss/expiry; errors from the
 * fetcher are returned but NOT cached (a transient MB outage shouldn't
 * poison a week of lookups).
 */
export async function getCachedMbRelease(
  artist: string,
  album: string,
  fetcher: (artist: string, album: string) => Promise<string>,
): Promise<{ raw: string; fromCache: boolean }> {
  const key = mbCacheKey(artist, album)
  const store = await mbCache.get()
  const hit = store[key]
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
    return { raw: hit.raw, fromCache: true }
  }
  const raw = await fetcher(artist, album)
  let isError = false
  try {
    const parsed = JSON.parse(raw) as { error?: string }
    isError = typeof parsed?.error === 'string' && parsed.error.length > 0
  } catch {
    isError = true
  }
  if (!isError) {
    await mbCache.update(store2 => ({ ...store2, [key]: { fetchedAt: Date.now(), raw } }))
  }
  return { raw, fromCache: false }
}

/** Synchronous peek — true if a fresh entry exists (sweep scheduling hint). */
export function hasFreshMbEntry(artist: string, album: string): boolean {
  const store = mbCache.peek()
  if (!store) return false
  const hit = store[mbCacheKey(artist, album)]
  return !!hit && Date.now() - hit.fetchedAt < TTL_MS
}
