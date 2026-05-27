/**
 * 4.5: robust artwork lookup. Pre-fix, artwork was keyed by the exact
 * `artist.toLowerCase().trim()|||album.toLowerCase().trim()` string,
 * so any metadata variation between when the artwork was captured and
 * when the row was rendered (a "(Remastered)" suffix, a "feat." in the
 * artist, a diacritic, an edit via Get Info) silently broke the match
 * and the cover faded into the abyss.
 *
 * This module centralizes lookups so every view falls back through:
 *   1. The exact original key (fast path, ~100% hit for un-edited rows)
 *   2. An aggressively normalized key (strips parens, diacritics, etc.)
 *   3. A linear fuzzy scan that normalizes every map key and compares
 *      (catches the rare case where the stored key has variants the
 *      caller doesn't)
 *
 * The artwork-IPC writer side keeps writing the original format — we
 * just teach the renderer to be tolerant on the read.
 */

/**
 * Strip parens-bound modifiers ("(Remastered)", "(Deluxe Edition)",
 * "(feat. X)"), trailing dash suffixes ("- 2019 Mix"), diacritics,
 * and non-alphanumeric punctuation. Aggressive — leans toward false
 * matches over false misses since a wrong artwork (rare) is less
 * confusing than a missing one.
 */
function normalizeArtworkPart(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')                                 // strip diacritics
    .toLowerCase()
    .replace(/\s*\((?:remaster(?:ed)?|deluxe|bonus|live|expanded|reissue|remix|special|anniversary|edition|mono|stereo)[^)]*\)/g, '')
    .replace(/\s*\[(?:remaster(?:ed)?|deluxe|bonus|live|expanded|reissue|remix|special|anniversary|edition|mono|stereo)[^\]]*\]/g, '')
    .replace(/\s*\((?:feat\.?|featuring|with|prod\.?|produced by)[^)]+\)/g, '')
    .replace(/\s*\[(?:feat\.?|featuring|with)[^\]]+\]/g, '')
    .replace(/\s+-\s+(?:remaster(?:ed)?|deluxe|bonus|live|expanded|reissue|remix|special|anniversary|edition|mono|stereo)[^-]*$/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

export function normalizedArtworkKey(artist: string, album: string): string {
  return `${normalizeArtworkPart(artist)}|||${normalizeArtworkPart(album)}`
}

/**
 * Build a normalized-key → hash map from the raw artworkMap. Use this
 * once per render in a component (useMemo) and pass it to lookupArt
 * instead of re-scanning all keys per row. Cuts repeat-scan cost on
 * lists with many rows that share an album.
 */
export function buildNormalizedArtworkIndex(artworkMap: Record<string, string>): Map<string, string> {
  const idx = new Map<string, string>()
  for (const [k, hash] of Object.entries(artworkMap)) {
    const [a, al] = k.split('|||')
    const nk = normalizedArtworkKey(a || '', al || '')
    if (!idx.has(nk)) idx.set(nk, hash)
  }
  return idx
}

/**
 * Look up artwork for (artist, album). Tries the original-format key
 * first (fast path), then the normalized key against a prebuilt
 * normalized index. Returns undefined when both miss.
 */
export function lookupArtwork(
  artworkMap: Record<string, string>,
  normalizedIndex: Map<string, string>,
  artist: string,
  album: string,
): string | undefined {
  const original = `${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`
  if (artworkMap[original]) return artworkMap[original]
  const nk = normalizedArtworkKey(artist, album)
  return normalizedIndex.get(nk)
}

/**
 * Single-shot lookup for one-off sites that don't memoize the
 * normalized index. Builds the index inline (small libraries fine;
 * for hot paths use buildNormalizedArtworkIndex + lookupArtwork).
 */
export function lookupArtworkOneShot(
  artworkMap: Record<string, string>,
  artist: string,
  album: string,
): string | undefined {
  const original = `${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`
  if (artworkMap[original]) return artworkMap[original]
  const nk = normalizedArtworkKey(artist, album)
  for (const [k, hash] of Object.entries(artworkMap)) {
    const [a, al] = k.split('|||')
    if (normalizedArtworkKey(a || '', al || '') === nk) return hash
  }
  return undefined
}

// ── 4.5.0-51: server-authoritative miss resolver ─────────────────────
/**
 * When lookupArtwork returns undefined for an (artist, album), the
 * renderer's in-memory map doesn't have it — but the JPG file might
 * still be sitting on disk (Get Info renamed the key, stale JSON,
 * etc.). This util fires a deduped IPC to ask main to do the full
 * lookup (normalized + disk-existence-check) and caches the result
 * by dispatching ADD_ARTWORK on success.
 *
 * Dedup: an in-flight request for the same (artist, album) is shared,
 * and a "negative" result (no hash found) is cached for 60s so we
 * don't hammer main every render.
 *
 * Fire-and-forget. The caller doesn't await — they just trigger and
 * trust that the next render after resolution will pick up the new map
 * entry via the LibraryContext reducer.
 */
type ResolveDispatch = (action: { type: 'ADD_ARTWORK'; key: string; hash: string }) => void

const inFlight = new Map<string, Promise<string | null>>()
const negativeCache = new Map<string, number>()  // key → expiry timestamp
const NEGATIVE_CACHE_MS = 60_000

function cacheKey(artist: string, album: string): string {
  return `${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`
}

/**
 * 4.5.0-67 — explicit invalidation for the negative cache. Call when
 * we KNOW the state changed (Get Info save just landed for a new
 * artist/album combo, fetchAlbumArt completed, set-custom-artwork
 * landed). Without this, the 60s NEGATIVE_CACHE_MS holds for a full
 * minute after a successful metadata edit — so the album tile stays
 * blank until the cache expires even though the artwork is now
 * available under the new key.
 */
export function clearArtworkNegativeCache(artist: string, album: string): void {
  if (!artist || !album) return
  negativeCache.delete(cacheKey(artist, album))
}

export function requestArtworkResolution(
  artist: string,
  album: string,
  dispatch: ResolveDispatch,
): void {
  if (!artist || !album) return
  const key = cacheKey(artist, album)
  // Skip if we already asked and got a no-go recently.
  const neg = negativeCache.get(key)
  if (neg && neg > Date.now()) return
  // Share in-flight promise.
  if (inFlight.has(key)) return
  const electronAPI = (window as unknown as { electronAPI?: { resolveArtwork?: (a: string, b: string) => Promise<{ ok: boolean; hash: string | null }> } }).electronAPI
  if (!electronAPI?.resolveArtwork) return
  const p = electronAPI.resolveArtwork(artist, album).then(r => {
    inFlight.delete(key)
    if (r?.ok && r.hash) {
      // Cache positively in the renderer map so future renders skip
      // the IPC entirely. The hash from main is already versioned
      // (or bare if it came from a disk-only match — still valid for
      // the album-art:// protocol since it strips _\d+ suffixes).
      dispatch({ type: 'ADD_ARTWORK', key, hash: r.hash })
      return r.hash
    }
    negativeCache.set(key, Date.now() + NEGATIVE_CACHE_MS)
    return null
  }).catch(() => {
    inFlight.delete(key)
    negativeCache.set(key, Date.now() + NEGATIVE_CACHE_MS)
    return null
  })
  inFlight.set(key, p)
}

/**
 * Convenience: do the local lookup, fire async resolution on miss,
 * return whatever the local lookup found right now. Use this in views
 * that currently call lookupArtwork(...) — same sync signature, but
 * misses trigger a background fetch that will populate the map for
 * subsequent renders.
 */
export function lookupArtworkWithFallback(
  artworkMap: Record<string, string>,
  normalizedIndex: Map<string, string>,
  artist: string,
  album: string,
  dispatch: ResolveDispatch,
): string | undefined {
  const hit = lookupArtwork(artworkMap, normalizedIndex, artist, album)
  if (hit) return hit
  requestArtworkResolution(artist, album, dispatch)
  return undefined
}
