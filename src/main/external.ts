// 4.3.0: external API integrations that enrich the WJLR show + Picks
// without bloating index.ts. Six sources, all with TTL caching so we
// don't hammer free-tier limits. Every function is fail-soft — a
// missing API key, a rate-limit, or a network blip returns an empty
// string / null and the caller continues without it. Nothing in this
// module is allowed to throw to the caller.
//
// API key environment variables (set in userData/.env or process env):
//   OPENWEATHER_API_KEY  — free tier, OpenWeatherMap
//   LASTFM_API_KEY       — free, Last.fm
//   DISCOGS_API_TOKEN    — free personal token (already used elsewhere)
// No keys needed: Pitchfork RSS, Stereogum RSS, The Quietus RSS,
// Wikidata SPARQL, Cover Art Archive.

interface CacheEntry<T> { value: T; ts: number }
function makeCache<T>(ttlMs: number) {
  const store = new Map<string, CacheEntry<T>>()
  return {
    get(key: string): T | null {
      const hit = store.get(key)
      if (!hit) return null
      if (Date.now() - hit.ts > ttlMs) {
        store.delete(key)
        return null
      }
      return hit.value
    },
    set(key: string, value: T) { store.set(key, { value, ts: Date.now() }) },
  }
}

// ───────────────────────────── OpenWeatherMap ─────────────────────────────
// Brooklyn, NY weather. Used to inject "live from a 36° drizzle" /
// "82 and gross" context into the radio prompt. 10-min cache because
// weather doesn't change second-to-second and we don't want to fire
// per-transition.
type WeatherSnapshot = { tempF: number; condition: string; description: string } | null
const weatherCache = makeCache<WeatherSnapshot>(10 * 60 * 1000)
export async function getBrooklynWeather(): Promise<WeatherSnapshot> {
  const cached = weatherCache.get('brooklyn')
  if (cached) return cached
  const key = process.env.OPENWEATHER_API_KEY
  if (!key) return null
  try {
    // Brooklyn lat/lon (Williamsburg-ish — close enough for "Brooklyn weather")
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=40.6782&lon=-73.9442&appid=${key}&units=imperial`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) { weatherCache.set('brooklyn', null); return null }
    const data = await res.json() as {
      main?: { temp?: number },
      weather?: { main?: string; description?: string }[],
    }
    const tempF = Math.round(data.main?.temp ?? 0)
    const condition = data.weather?.[0]?.main || ''
    const description = data.weather?.[0]?.description || ''
    const snap = { tempF, condition, description }
    weatherCache.set('brooklyn', snap)
    return snap
  } catch {
    return null
  }
}

// Format the weather snapshot for prompt injection. One short line.
export function formatWeatherForPrompt(w: WeatherSnapshot): string {
  if (!w) return ''
  const desc = w.description ? w.description.replace(/\b\w/g, c => c.toUpperCase()) : w.condition
  return `Brooklyn weather right now: ${w.tempF}°F, ${desc.toLowerCase()}.`
}

// ────────────────────────────── Last.fm ──────────────────────────────
// Charts (top tracks for NY) + similar artists. The charts feed gives
// the radio show real "trending now" context without us having to
// fabricate it. Similar artists feeds picks generation with broader
// surrounding-context so MM/Megan/DJ Hands can refer to "everyone
// also listened to X this week."
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/'
const lastfmChartsCache = makeCache<string[]>(60 * 60 * 1000)  // 1 hour
const lastfmSimilarCache = makeCache<string[]>(24 * 60 * 60 * 1000)  // 24 hours

/** Top scrobbled tracks in NY this week. Returns up to 8 "Artist – Track" strings. */
export async function getLastFmNyChart(): Promise<string[]> {
  const cached = lastfmChartsCache.get('ny')
  if (cached) return cached
  const key = process.env.LASTFM_API_KEY
  if (!key) return []
  try {
    // geo.getTopTracks for "United States" then we trim — Last.fm doesn't
    // have NYC granularity, but US-top is close enough for "what people
    // are scrobbling this week" context.
    const url = `${LASTFM_BASE}?method=geo.gettoptracks&country=United%20States&api_key=${key}&format=json&limit=8`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) { lastfmChartsCache.set('ny', []); return [] }
    type LastFmTracksRes = { tracks?: { track?: { name?: string; artist?: { name?: string } }[] } }
    const data = await res.json() as LastFmTracksRes
    const tracks = data.tracks?.track || []
    const out: string[] = []
    for (const t of tracks.slice(0, 8)) {
      if (t.name && t.artist?.name) out.push(`${t.artist.name} – ${t.name}`)
    }
    lastfmChartsCache.set('ny', out)
    return out
  } catch {
    return []
  }
}

/** Similar artists for an input artist. Returns up to 6 names. */
export async function getLastFmSimilarArtists(artist: string): Promise<string[]> {
  if (!artist) return []
  const cacheKey = artist.toLowerCase().trim()
  const cached = lastfmSimilarCache.get(cacheKey)
  if (cached) return cached
  const key = process.env.LASTFM_API_KEY
  if (!key) return []
  try {
    const url = `${LASTFM_BASE}?method=artist.getsimilar&artist=${encodeURIComponent(artist)}&api_key=${key}&format=json&limit=6`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) { lastfmSimilarCache.set(cacheKey, []); return [] }
    type SimilarRes = { similarartists?: { artist?: { name?: string }[] } }
    const data = await res.json() as SimilarRes
    const list = (data.similarartists?.artist || []).map(a => a.name || '').filter(Boolean)
    lastfmSimilarCache.set(cacheKey, list)
    return list
  } catch {
    return []
  }
}

export function formatLastFmChartForPrompt(items: string[]): string {
  if (!items.length) return ''
  return `What's getting scrobbled in the US this week (Last.fm): ${items.slice(0, 6).join(', ')}.`
}

// ───────────────────── RSS feeds (Pitchfork / Stereogum / Quietus) ──────────────────────
// Fetch and trim the latest reviews / posts. Plain XML parsing — we
// only pull <title> and a snippet, no fancy enclosure handling.
const rssCache = makeCache<string[]>(60 * 60 * 1000)  // 1 hour
const RSS_FEEDS: { name: string; url: string }[] = [
  { name: 'Pitchfork',   url: 'https://pitchfork.com/rss/reviews/best/albums/' },
  { name: 'Stereogum',   url: 'https://www.stereogum.com/category/news/feed/' },
  { name: 'The Quietus', url: 'https://thequietus.com/feed/' },
]

async function fetchOneFeed(url: string): Promise<string[]> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'JakeTunes/4.3' },
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) return []
    const xml = await res.text()
    // Lightweight regex-based extraction — works on both RSS 2.0 and Atom-ish.
    const items: string[] = []
    const itemRegex = /<item[\s\S]*?<\/item>/gi
    const matches = xml.match(itemRegex) || []
    for (const item of matches.slice(0, 5)) {
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)
      const title = titleMatch?.[1]?.trim() || ''
      if (title) items.push(title.replace(/\s+/g, ' ').slice(0, 160))
    }
    return items
  } catch {
    return []
  }
}

/** Headlines + review titles from the music press. Up to ~12 lines, mixed sources. */
export async function getRecentReviews(): Promise<string[]> {
  const cached = rssCache.get('all')
  if (cached) return cached
  try {
    const results = await Promise.all(RSS_FEEDS.map(async f => {
      const items = await fetchOneFeed(f.url)
      return items.slice(0, 4).map(t => `[${f.name}] ${t}`)
    }))
    const flat = results.flat().slice(0, 12)
    rssCache.set('all', flat)
    return flat
  } catch {
    return []
  }
}

export function formatReviewsForPrompt(items: string[]): string {
  if (!items.length) return ''
  return `Recent music press headlines (use ONE of these as a reaction hook if it fits, otherwise ignore):\n${items.map(i => '  - ' + i).join('\n')}`
}

// ───────────────────────────── Discogs ─────────────────────────────
// Lookup release / master detail for a given artist + album. Used to
// drop pressing detail into MM's lane without us having to fabricate
// it. Free unauth, but we have a token — adds rate-limit headroom.
type DiscogsHit = {
  pressing?: string
  format?: string
  year?: number
  country?: string
  label?: string
  notes?: string
} | null
const discogsCache = makeCache<DiscogsHit>(24 * 60 * 60 * 1000)

export async function getDiscogsReleaseInfo(artist: string, album: string): Promise<DiscogsHit> {
  if (!artist || !album) return null
  const cacheKey = `${artist.toLowerCase().trim()}|${album.toLowerCase().trim()}`
  const cached = discogsCache.get(cacheKey)
  if (cached !== null) return cached
  const token = process.env.DISCOGS_API_TOKEN
  if (!token) return null
  try {
    const searchUrl = `https://api.discogs.com/database/search?artist=${encodeURIComponent(artist)}&release_title=${encodeURIComponent(album)}&type=master&per_page=1`
    const res = await fetch(searchUrl, {
      headers: { 'Authorization': `Discogs token=${token}`, 'User-Agent': 'JakeTunes/4.3' },
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) { discogsCache.set(cacheKey, null); return null }
    type SearchRes = { results?: { id?: number; year?: number; country?: string; label?: string[]; format?: string[] }[] }
    const data = await res.json() as SearchRes
    const top = data.results?.[0]
    if (!top) { discogsCache.set(cacheKey, null); return null }
    const hit: DiscogsHit = {
      year: top.year,
      country: top.country,
      label: top.label?.[0],
      format: (top.format || []).slice(0, 3).join(', '),
    }
    discogsCache.set(cacheKey, hit)
    return hit
  } catch {
    return null
  }
}

export function formatDiscogsForPrompt(d: DiscogsHit): string {
  if (!d) return ''
  const parts: string[] = []
  if (d.year) parts.push(`${d.year}`)
  if (d.label) parts.push(d.label)
  if (d.country) parts.push(d.country)
  if (d.format) parts.push(d.format)
  return parts.length ? `Discogs pressing detail: ${parts.join(' / ')}.` : ''
}

// ───────────────────────────── Wikidata ─────────────────────────────
// SPARQL for structured artist data: members, formed year, dissolved
// year, label, genre, instrument. Cleaner than parsing Wikipedia text.
type WikidataArtist = {
  formed?: string
  dissolved?: string
  members?: string[]
  labels?: string[]
  genres?: string[]
  hometown?: string
} | null
const wikidataCache = makeCache<WikidataArtist>(24 * 60 * 60 * 1000)

export async function getWikidataArtist(artist: string): Promise<WikidataArtist> {
  if (!artist) return null
  const cacheKey = artist.toLowerCase().trim()
  const cached = wikidataCache.get(cacheKey)
  if (cached !== null) return cached
  // SPARQL for first matching musician/band by name. Pulls a small set
  // of properties. Wikidata is free + no auth.
  const sparql = `
    SELECT ?item ?inception ?dissolved ?memberLabel ?recordLabel ?genreLabel ?hometownLabel WHERE {
      ?item rdfs:label "${artist.replace(/"/g, '\\"')}"@en.
      VALUES ?type { wd:Q5741069 wd:Q215380 wd:Q177220 wd:Q639669 }
      ?item wdt:P31 ?type.
      OPTIONAL { ?item wdt:P571 ?inception. }
      OPTIONAL { ?item wdt:P576 ?dissolved. }
      OPTIONAL { ?item wdt:P527 ?member. }
      OPTIONAL { ?item wdt:P264 ?recordLabel. }
      OPTIONAL { ?item wdt:P136 ?genre. }
      OPTIONAL { ?item wdt:P740 ?hometown. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 30
  `
  try {
    const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'JakeTunes/4.3', 'Accept': 'application/sparql-results+json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) { wikidataCache.set(cacheKey, null); return null }
    type SparqlRes = {
      results?: { bindings?: Array<Record<string, { value?: string }>> },
    }
    const data = await res.json() as SparqlRes
    const bindings = data.results?.bindings || []
    if (bindings.length === 0) { wikidataCache.set(cacheKey, null); return null }
    const formed = bindings[0]?.inception?.value?.slice(0, 4)
    const dissolved = bindings[0]?.dissolved?.value?.slice(0, 4)
    const members = Array.from(new Set(bindings.map(b => b.memberLabel?.value).filter(Boolean) as string[])).slice(0, 6)
    const labels = Array.from(new Set(bindings.map(b => b.recordLabel?.value).filter(Boolean) as string[])).slice(0, 3)
    const genres = Array.from(new Set(bindings.map(b => b.genreLabel?.value).filter(Boolean) as string[])).slice(0, 4)
    const hometown = bindings[0]?.hometownLabel?.value
    const out: WikidataArtist = { formed, dissolved, members, labels, genres, hometown }
    wikidataCache.set(cacheKey, out)
    return out
  } catch {
    return null
  }
}

export function formatWikidataForPrompt(w: WikidataArtist): string {
  if (!w) return ''
  const bits: string[] = []
  if (w.formed) bits.push(`formed ${w.formed}${w.dissolved ? `, dissolved ${w.dissolved}` : ''}`)
  if (w.hometown) bits.push(`from ${w.hometown}`)
  if (w.labels?.length) bits.push(`labels: ${w.labels.join(', ')}`)
  if (w.genres?.length) bits.push(`tagged: ${w.genres.join(', ')}`)
  if (w.members?.length) bits.push(`members: ${w.members.join(', ')}`)
  return bits.length ? `Wikidata: ${bits.join('; ')}.` : ''
}

// ─────────────────────── Cover Art Archive ───────────────────────
// The MusicBrainz-linked image archive. Higher-quality artwork than
// embedded ID3 frames; useful when the user has an audio file with a
// stripped or low-res cover. Returns a binary URL the renderer can
// load directly. The existing fetch-album-art path uses this; here we
// expose a direct MBID → image URL helper for callers that already
// have an MBID (e.g. after a MusicBrainz release search).
export function getCoverArtUrlByMbid(mbid: string, size: 'front' | '500' | '1200' = 'front'): string {
  const encoded = encodeURIComponent(mbid)
  return size === 'front'
    ? `https://coverartarchive.org/release/${encoded}/front`
    : `https://coverartarchive.org/release/${encoded}/front-${size}`
}

// MusicBrainz release lookup by artist + album → first MBID. Cached.
const mbidCache = makeCache<string | null>(7 * 24 * 60 * 60 * 1000)  // 7 days
export async function getMusicBrainzReleaseMbid(artist: string, album: string): Promise<string | null> {
  if (!artist || !album) return null
  const cacheKey = `${artist.toLowerCase().trim()}|${album.toLowerCase().trim()}`
  const cached = mbidCache.get(cacheKey)
  if (cached !== null) return cached
  try {
    const q = `artist:"${artist.replace(/"/g, '\\"')}" AND release:"${album.replace(/"/g, '\\"')}"`
    const url = `https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(q)}&fmt=json&limit=1`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'JakeTunes/4.3' },
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) { mbidCache.set(cacheKey, null); return null }
    type MbRes = { releases?: { id?: string }[] }
    const data = await res.json() as MbRes
    const id = data.releases?.[0]?.id || null
    mbidCache.set(cacheKey, id)
    return id
  } catch {
    return null
  }
}
