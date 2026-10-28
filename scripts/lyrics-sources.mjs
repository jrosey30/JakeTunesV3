/**
 * lyrics-sources.mjs — the network + decision half of scripts/lyrics-fetch.mjs,
 * split out so it can be unit-tested with an injected fetch (no network).
 *
 * Sources, in order:
 *   1. LRCLIB /api/get (strict ±2s duration window, server-side), then
 *      LRCLIB /api/search re-ranked by duration ±2s + artist match.
 *   2. lyrics.ovh (2026-10-27) — ONLY after both LRCLIB paths miss. Free, no
 *      key, plain text only, and NO duration check: measured on 40 random
 *      LRCLIB misses it hit 4 (10%) and one of those was the ORIGINAL song's
 *      words handed back for a dub edit. So it is gated hard: any remix / mix /
 *      edit / dub / version / instrumental / live / intro / interlude / skit
 *      title (or album) never asks it, and text under 80 characters (after
 *      stripping its "Paroles de la chanson …" header) is not lyrics.
 *      Max 1 request/second, 8 s timeout, no retries; a network error from it
 *      leaves an ordinary LRCLIB miss and never fails the batch.
 *
 * Stored shapes (lyrics.json, keyed String(track.id)):
 *   LRCLIB hit     { plain?, synced?, source:'lrclib', lrclibId, fetchedAt }
 *   LRCLIB instr.  { instrumental:true, source:'lrclib', lrclibId, fetchedAt }
 *   ovh hit        { plain, source:'lyrics.ovh', fetchedAt }       (no synced, no lrclibId)
 *   double miss    { miss:true, source:'lrclib+ovh', fetchedAt }   (30-day retry)
 *   likely instr.  { miss:true, likelyInstrumental:true, source:'lrclib+ovh', fetchedAt }
 *                  (180-day retry; still a MISS — Get Info must not say "Instrumental"
 *                  on a guess. Only LRCLIB's own instrumental flag claims that.)
 *   ovh errored    { miss:true, source:'lrclib', fetchedAt }       (30-day retry)
 */

export const LRCLIB_BASE = 'https://lrclib.net'
export const OVH_BASE = 'https://api.lyrics.ovh/v1'
// Etiquette: LRCLIB asks for a descriptive User-Agent so the maintainer can
// identify heavy clients (mirrors the reference client lrcget's shape). The
// same UA goes to lyrics.ovh.
export const UA = 'JakeTunes/1.0 (personal music library; +https://github.com/jaketunes)'
export const LRCLIB_TIMEOUT_MS = 20000   // LRCLIB latency is variable; be patient before aborting
export const OVH_TIMEOUT_MS = 8000
export const OVH_MIN_GAP_MS = 1000       // at most 1 lyrics.ovh request per second
export const OVH_MIN_CHARS = 80
export const MISS_TTL_MS = 30 * 24 * 3600 * 1000                    // re-check a known miss after 30 days
export const LIKELY_INSTRUMENTAL_MISS_TTL_MS = 180 * 24 * 3600 * 1000   // …or 180 for a likely instrumental

// ── Query normalization (boosts the precise-lookup hit rate; storage always
// keys by track id and never depends on this, so over-cleaning only costs a
// match, never data integrity). Strips feat credits + remaster/version tags. ──
export function cleanTitle(s) {
  return String(s || '')
    .replace(/\s*[([](feat\.?|ft\.?|featuring|with)\b[^)\]]*[)\]]/ig, '')
    .replace(/\s*[([][^)\]]*\b(remaster(ed)?|mono|stereo|deluxe|anniversary|bonus|reissue)\b[^)\]]*[)\]]/ig, '')
    .replace(/\s*-\s*(\d{4}\s+)?remaster(ed)?\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
export function cleanArtist(s) {
  // Strip a trailing "feat./ft./featuring X" credit. The leading \s+ is
  // LOAD-BEARING: with \s* (zero-width ok), "ft" matches INSIDE words like
  // "Daft Punk" ("Da" + "ft Punk") → mangles the artist to "Da". Requiring
  // real whitespace before the token makes it only match a standalone word.
  return String(s || '').replace(/\s+(?:feat|ft|featuring)\.?\s+.*$/i, '').trim()
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Likely-instrumental rule (one pure function, unit-tested) ──
// Genres derived from the library's real genre values (2026-10-27, 12,036
// tracks) where the music is instrumental-by-default AND the stored
// miss+instrumental rate was high (House 74%, Deep House 83%, Techno 90%,
// Instrumental Hip-Hop 93%, French Electro 76% of which 65% LRCLIB-flagged
// instrumental). DELIBERATELY EXCLUDED even though they miss a lot, because
// vocals are the norm and the miss is language/obscurity, not silence:
// Israeli Hip-Hop, Dub-Hop, Children's, Comedy, Bossa Nova, Afrobeat,
// Brazilian Boogie, MPB, UK Garage, Disco, Nu Disco, Chillwave, Latin.
export const LIKELY_INSTRUMENTAL_GENRES = Object.freeze([
  'House', 'Deep House', 'Tech House', 'Acid House', 'Chicago House', 'Latin House', 'Ambient House',
  'Techno', 'Trance', 'Breakbeat', 'Ambient',
  'Instrumental Hip-Hop', 'French Electro',
  'Soundtrack', 'Video Game Music',
  'Jazz Fusion', 'Nu Jazz',
])
const GENRE_SET = new Set(LIKELY_INSTRUMENTAL_GENRES.map((g) => g.toLowerCase()))
const INSTRUMENTAL_TITLE_RE = /\b(instrumental|dub)\b/i

/** True when a track's genre or title says it is probably wordless. A guess —
 *  only ever used to stretch the retry TTL on a MISS, never to claim
 *  "instrumental". */
export function isLikelyInstrumental({ genre, title } = {}) {
  if (GENRE_SET.has(String(genre || '').trim().toLowerCase())) return true
  return INSTRUMENTAL_TITLE_RE.test(String(title || ''))
}

/** Retry TTL for a stored miss record. */
export function missTtlMs(rec) {
  return rec && rec.likelyInstrumental ? LIKELY_INSTRUMENTAL_MISS_TTL_MS : MISS_TTL_MS
}

// lyrics.ovh has no duration check, so any title/album naming a different cut
// than the song's words could be the wrong lyrics. Word-boundary, case-insensitive.
const OVH_BLOCK_RE = /\b(remix(?:e[sd])?|mix(?:e[sd])?|edit|dub|version|instrumental|live|intro|interlude|skit)\b/i
export function ovhTitleBlocked(title, album) {
  return OVH_BLOCK_RE.test(String(title || '')) || OVH_BLOCK_RE.test(String(album || ''))
}

/** lyrics.ovh text → clean lyrics, or null if it is a placeholder / too short. */
export function cleanOvhText(text) {
  if (typeof text !== 'string') return null
  const out = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*paroles de la chanson\b/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return out.length >= OVH_MIN_CHARS ? out : null
}

// Turn an LRCLIB object into a grounded store record (or null if it has no
// usable lyrics). Instrumental hits are a definitive "no lyrics".
export function recordFrom(obj, now = Date.now()) {
  if (obj && obj.instrumental) return { instrumental: true, source: 'lrclib', lrclibId: obj.id, fetchedAt: now }
  const plain = typeof obj?.plainLyrics === 'string' && obj.plainLyrics.trim() ? obj.plainLyrics : undefined
  const synced = typeof obj?.syncedLyrics === 'string' && obj.syncedLyrics.trim() ? obj.syncedLyrics : undefined
  if (!plain && !synced) return null
  return { plain, synced, source: 'lrclib', lrclibId: obj.id, fetchedAt: now }
}

// Pick the search candidate whose duration is within ±2s AND whose artist
// matches — never trust result[0] blindly (LRCLIB has junk/mislabeled rows).
export function pickCandidate(arr, durSec, artist) {
  const na = norm(artist)
  let best = null, bestScore = Infinity
  for (const c of arr) {
    const cd = Number(c.duration) || 0
    if (durSec && Math.abs(cd - durSec) > 2) continue
    const naC = norm(c.artistName)
    if (!(na && naC && (naC.includes(na) || na.includes(naC)))) continue
    const score = durSec ? Math.abs(cd - durSec) : 0
    if (score < bestScore) { bestScore = score; best = c }
  }
  return best
}

/**
 * A fetcher bound to injectable deps. `fetch` defaults to the global, `sleep`
 * to a real timer, `now` to Date.now. Returns { lookup(track) } where lookup
 * resolves to { rec, via } (via: 'lrclib' | 'lyrics.ovh' | 'miss') and throws
 * only on a transient LRCLIB failure (caller stores nothing → retried next run).
 */
export function createLyricsFetcher({ fetch: fetchImpl = globalThis.fetch, sleep = realSleep, now = Date.now, log = () => {} } = {}) {
  async function timedFetch(url, timeoutMs, accept) {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      return await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: ctrl.signal })
    } finally { clearTimeout(to) }
  }

  // GET with a timeout + transient-retry. LRCLIB latency is variable and it can
  // briefly 5xx/stall under load; retry aborts/network-errors/5xx up to 3 attempts
  // with backoff so a slow window doesn't turn a real track into a missed fetch.
  async function httpGet(url, attempt = 1) {
    try {
      const r = await timedFetch(url, LRCLIB_TIMEOUT_MS, 'application/json')
      if (r.status >= 500 && attempt < 3) { await sleep(1000 * attempt); return httpGet(url, attempt + 1) }
      return r
    } catch (e) {
      if (attempt < 3) { await sleep(1500 * attempt); return httpGet(url, attempt + 1) }
      throw e
    }
  }

  // Precise lookup: single object on 200, { notFound } on 404, throw on transient.
  // LRCLIB can return a COLD-CACHE 404 on a track's first-ever lookup and then
  // serve it 200 on the next call — so a bare 404 is not trustworthy. Retry once
  // after a beat before believing "not found". Only genuine misses pay this cost.
  async function lrclibGet(title, artist, durSec) {
    const p = new URLSearchParams({ track_name: title, artist_name: artist })
    if (durSec >= 1 && durSec <= 3600) p.set('duration', String(durSec))
    const url = `${LRCLIB_BASE}/api/get?${p.toString()}`
    let r = await httpGet(url)
    if (r.status === 200) return { hit: await r.json() }
    if (r.status === 404) {
      await sleep(1200)
      r = await httpGet(url)
      if (r.status === 200) return { hit: await r.json() }
      if (r.status === 404) return { notFound: true }
    }
    throw new Error(`get ${r.status}`)
  }

  // Fallback: array (may be []); /api/search has NO duration filter so we re-rank.
  async function lrclibSearch(title, artist) {
    const p = new URLSearchParams({ track_name: title, artist_name: artist })
    const r = await httpGet(`${LRCLIB_BASE}/api/search?${p.toString()}`)
    if (r.status !== 200) return []
    const arr = await r.json()
    return Array.isArray(arr) ? arr : []
  }

  // lyrics.ovh: one attempt, no retries (a 404 is its normal "don't know").
  // Returns cleaned text or null; throws only on a network error / timeout.
  let lastOvhAt = -Infinity
  async function ovhGet(artist, title) {
    const wait = lastOvhAt + OVH_MIN_GAP_MS - now()
    if (wait > 0) await sleep(wait)
    lastOvhAt = now()
    const r = await timedFetch(`${OVH_BASE}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, OVH_TIMEOUT_MS, 'application/json')
    if (r.status !== 200) return null
    let body
    try { body = await r.json() } catch { return null }
    return cleanOvhText(body?.lyrics)
  }

  async function lookup(t) {
    const title = cleanTitle(t.title), artist = cleanArtist(t.artist)
    const durSec = Math.round((Number(t.duration) || 0) / 1000)
    let rec = null
    const g = await lrclibGet(title, artist, durSec)   // throws on transient → caller retries next run
    if (g.hit) {
      rec = recordFrom(g.hit, now())
    } else if (g.notFound) {
      const cand = pickCandidate(await lrclibSearch(title, artist), durSec, artist)
      if (cand) rec = recordFrom(cand, now())
    }
    if (rec) return { rec, via: 'lrclib' }

    // LRCLIB missed on both paths → lyrics.ovh, gated.
    if (!ovhTitleBlocked(t.title, t.album)) {
      try {
        const plain = await ovhGet(artist, title)
        if (plain) return { rec: { plain, source: 'lyrics.ovh', fetchedAt: now() }, via: 'lyrics.ovh' }
      } catch (e) {
        // Never lose the LRCLIB verdict or crash the batch over the fallback:
        // an ordinary LRCLIB miss, 30-day retry, no instrumental guess.
        log(`ovh err "${t.artist} — ${t.title}": ${e?.message || e}`)
        return { rec: { miss: true, source: 'lrclib', fetchedAt: now() }, via: 'miss', ovhError: true }
      }
    }
    const miss = { miss: true, source: 'lrclib+ovh', fetchedAt: now() }
    if (isLikelyInstrumental(t)) miss.likelyInstrumental = true
    return { rec: miss, via: 'miss' }
  }

  return { lookup }
}
