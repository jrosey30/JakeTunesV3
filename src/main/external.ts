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

// ─────── 4.4.28: structured RSS for the Home view (News + Releases) ───────
// The above getRecentReviews() returns "[Source] Title" strings for Music
// Man's prompt context. The Home view needs more — clickable links, dates,
// and (where available) hero images for the Notable Releases cards. So we
// parse the same feeds again with a richer extractor and cache the parsed
// objects for one hour. The two surfaces share the underlying network
// fetches via a single combined parser; only the OUTPUT shape differs.

export interface MusicNewsItem {
  title: string
  link: string
  source: string         // 'Pitchfork' | 'Stereogum' | 'The Quietus'
  pubDate: string        // ISO; '' if unparseable
  imageUrl?: string      // best-effort cover/feature image
  /** True for the Pitchfork Best New Albums feed — these items are
   *  surfaced on Home's "Notable Releases" row; everything else
   *  shows under "Music News". */
  isReleaseReview: boolean
}

const newsCache = makeCache<MusicNewsItem[]>(60 * 60 * 1000)  // 1 hour

// 4.4.29: RSS feeds embed HTML entities in <title> CDATA. The previous
// parser passed `&#8220;`, `&#8217;`, `&amp;` etc through verbatim,
// which rendered as literal "&#8220;" in the UI. This decoder handles
// the common cases: named entities, decimal numeric, hex numeric.
function decodeEntities(str: string): string {
  if (!str) return ''
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

// Extract a best-guess image URL from an RSS item body. Tries (in order):
//   <media:content url="…" />
//   <media:thumbnail url="…" />
//   <enclosure url="…" type="image/…" />
//   <img src="…" /> inside <content:encoded> or <description>
function extractImageUrl(itemXml: string): string | undefined {
  const mediaContent = itemXml.match(/<media:content[^>]*url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i)
  if (mediaContent) return mediaContent[1]
  const mediaThumb = itemXml.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i)
  if (mediaThumb) return mediaThumb[1]
  const enclosure = itemXml.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image/i)
  if (enclosure) return enclosure[1]
  // Look inside <content:encoded> or <description> for first <img>.
  const bodyMatch = itemXml.match(/<(?:content:encoded|description)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:content:encoded|description)>/i)
  if (bodyMatch) {
    const imgMatch = bodyMatch[1].match(/<img[^>]*src=["']([^"']+)["']/i)
    if (imgMatch) return imgMatch[1]
  }
  return undefined
}

function parsePubDate(itemXml: string): string {
  const m = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)
    || itemXml.match(/<updated>([\s\S]*?)<\/updated>/i)
    || itemXml.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)
  if (!m) return ''
  const parsed = new Date(m[1].trim())
  if (isNaN(parsed.getTime())) return ''
  return parsed.toISOString()
}

// 4.4.32: gossip filter for news headlines. Even Pitchfork News and
// Stereogum's music category publish a lot of "X reacts to Y" / "X
// responds to Z" / "Watch X react" content that reads as celebrity
// drama, not music news. Drop items whose titles match any pattern.
// The patterns are intentionally narrow — they target specific
// drama-coverage phrasing, not real music news that incidentally
// mentions any of these words. False negatives (gossip slipping
// through) are OK; false positives (real music news being filtered)
// are not.
const GOSSIP_PATTERNS: RegExp[] = [
  /\breact(?:s|ed|ing)?\s+to\b/i,           // "Artist Reacts To X"
  /\bresponds?\s+to\b/i,                     // "Artist Responds To X"
  /\baddresses?\s+(?:the\s+)?(?:rumors?|controversy|backlash|criticism)\b/i,
  /\bfires?\s+back\b/i,
  /\bclap[\s-]?back\b/i,
  /\bcalls?\s+out\b/i,                       // "X Calls Out Y"
  /\bslam(?:s|med|ming)?\b/i,                // "X Slams Y" (clickbait phrasing)
  /\bdrag(?:s|ged|ging)?\s+(?:on|over|for)\b/i,
  /\broast(?:s|ed|ing)?\b/i,                 // "X Roasts Y"
  /\bbeef\s+with\b/i,                        // "Beef With"
  /\bfeud(?:s|ing)?\b/i,
  /\bjokes?\s+(?:about|that)\b.*\b(?:Disney|Trump|GOP|politics|political)\b/i,
  /\bdating\s+rumors?\b/i,
  /\bsplit(?:s|ting)?\s+with\b/i,            // celebrity-split clickbait
  /\bweighs?\s+in\s+on\b/i,                  // "X Weighs In On Y" (commentary, not news)
]

function isGossip(title: string): boolean {
  return GOSSIP_PATTERNS.some(p => p.test(title))
}

async function fetchStructuredFeed(url: string, source: string, isReleaseReview: boolean): Promise<MusicNewsItem[]> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'JakeTunes/4.4' },
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) return []
    const xml = await res.text()
    const items: MusicNewsItem[] = []
    const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || []
    for (const item of matches.slice(0, 12)) {
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)
      const linkMatch = item.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)
      // 4.4.29: decode HTML entities in the title (RSS feeds embed
      // curly quotes, apostrophes, ampersands as &#8220; etc.).
      const rawTitle = titleMatch?.[1]?.trim() || ''
      const title = decodeEntities(rawTitle).replace(/\s+/g, ' ').slice(0, 240)
      const link = linkMatch?.[1]?.trim() || ''
      if (!title || !link) continue
      // 4.4.32: drop gossip headlines. Skip release reviews from the
      // filter (Pitchfork BNA shouldn't get filtered — those are real
      // album release announcements regardless of phrasing).
      if (!isReleaseReview && isGossip(title)) continue
      items.push({
        title,
        link,
        source,
        pubDate: parsePubDate(item),
        imageUrl: extractImageUrl(item),
        isReleaseReview,
      })
    }
    return items
  } catch {
    return []
  }
}

/** Combined structured fetch across all the RSS feeds. One-hour cache.
 *
 * 4.4.30: News-feed-focused source list. The 4.4.29 swap traded
 * Stereogum-news clickbait for higher-quality sources, but the
 * replacements (NPR Music, Aquarium Drunkard, Pitchfork Features,
 * The Quietus) are mostly long-form criticism / curated reissue
 * blog posts / Tiny Desk announcements — high-signal, but not what
 * a normal person would call "music news." Swap to dedicated news
 * RSS feeds that publish actual artist/release/tour announcements:
 *
 *   - Pitchfork News        — separate from Pitchfork Features
 *   - Stereogum New Music   — release/single announcements, not the
 *                             main feed that has the clickbait
 *   - Brooklyn Vegan        — tour + release news, indie/rock heavy
 *   - Consequence           — broad music news
 *
 * Pitchfork "Best New Albums" still drives the cover-led "New This
 * Week" releases row — that section's content is correct, only the
 * news row needed the fix. */
async function getStructuredFeeds(): Promise<MusicNewsItem[]> {
  const cached = newsCache.get('all')
  if (cached) return cached
  const sources: { name: string; url: string; isReleaseReview: boolean }[] = [
    // Notable Releases (cover-led card row on Home — already correct)
    { name: 'Pitchfork',       url: 'https://pitchfork.com/rss/reviews/best/albums/',         isReleaseReview: true },
    // Music News (text-led card row on Home — 4.4.30 swap)
    { name: 'Pitchfork',       url: 'https://pitchfork.com/rss/news/',                        isReleaseReview: false },
    { name: 'Stereogum',       url: 'https://www.stereogum.com/category/new-music/feed/',     isReleaseReview: false },
    { name: 'Brooklyn Vegan',  url: 'https://www.brooklynvegan.com/feed/',                    isReleaseReview: false },
    // 4.4.31: swapped from main /feed/ which includes TV/celebrity
    // (Pete Davidson roast, Kimmel political jokes) to the
    // music-only category.
    { name: 'Consequence',     url: 'https://consequence.net/category/music/feed/',           isReleaseReview: false },
  ]
  const results = await Promise.all(
    sources.map(s => fetchStructuredFeed(s.url, s.name, s.isReleaseReview))
  )
  const flat = results.flat().sort((a, b) => b.pubDate.localeCompare(a.pubDate))
  newsCache.set('all', flat)
  return flat
}

/** Music news items for the Home view — Stereogum + Quietus, newest first. */
export async function getMusicNews(): Promise<MusicNewsItem[]> {
  const all = await getStructuredFeeds()
  return all.filter(i => !i.isReleaseReview).slice(0, 12)
}

/** Notable releases for the Home view — Pitchfork "Best New Albums",
 *  newest first. Each item is a recent album that Pitchfork flagged as
 *  noteworthy; the link goes to the review. Suitable as cover-led cards. */
export async function getNotableReleases(): Promise<MusicNewsItem[]> {
  const all = await getStructuredFeeds()
  return all.filter(i => i.isReleaseReview).slice(0, 10)
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

// ───────────────────────────── 4.4.32: Bandsintown ─────────────────────────────
// Tour dates per artist. No API key required — the Discovery API
// accepts a free-form `app_id` string for attribution. Reasonable
// non-commercial use is allowed per their TOS. Per-artist 24h cache;
// aggregate cache keyed by the artist-set hash (so a stable top-N
// list returns instantly until library or top order changes).
//
// Why Bandsintown and not Songkick: Bandsintown's free tier is more
// permissive and the data quality is good for indie/alt acts which
// dominate Jake's library.

export interface TourDate {
  /** Artist name as queried (matches the input list, not BIT's normalization). */
  artist: string
  /** Event datetime ISO. */
  date: string
  /** Display venue name. */
  venue: string
  /** "Brooklyn, NY" / "London, UK" — best-effort city + region. */
  city: string
  /** Bandsintown event page URL. */
  url: string
  /** Optional artist thumbnail (square, often Spotify-sourced). */
  imageUrl?: string
}

const BANDSINTOWN_APP_ID = 'jaketunes-desktop'
const bandsintownPerArtistCache = makeCache<TourDate[]>(24 * 60 * 60 * 1000)
const bandsintownAggregateCache = makeCache<TourDate[]>(24 * 60 * 60 * 1000)

interface BitEvent {
  datetime?: string
  url?: string
  venue?: { name?: string; city?: string; region?: string; country?: string }
  artist?: { thumb_url?: string; image_url?: string }
}

export async function getBandsintownEventsForArtist(artist: string): Promise<TourDate[]> {
  const cached = bandsintownPerArtistCache.get(artist)
  if (cached) return cached
  try {
    const url = `https://rest.bandsintown.com/artists/${encodeURIComponent(artist)}/events?app_id=${encodeURIComponent(BANDSINTOWN_APP_ID)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'JakeTunes/4.4', Accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) {
      // Treat 404 / 403 / 5xx as "no events", cache the empty result
      // so we don't hammer for every poll cycle.
      bandsintownPerArtistCache.set(artist, [])
      return []
    }
    const body = await res.json()
    if (!Array.isArray(body)) {
      bandsintownPerArtistCache.set(artist, [])
      return []
    }
    const data = body as BitEvent[]
    const now = Date.now()
    const events: TourDate[] = []
    for (const ev of data) {
      if (!ev.datetime || !ev.venue) continue
      const ts = new Date(ev.datetime).getTime()
      if (isNaN(ts) || ts < now) continue
      const city = [ev.venue.city, ev.venue.region || ev.venue.country].filter(Boolean).join(', ')
      events.push({
        artist,
        date: new Date(ts).toISOString(),
        venue: ev.venue.name || '',
        city,
        url: ev.url || '',
        imageUrl: ev.artist?.thumb_url || ev.artist?.image_url,
      })
    }
    bandsintownPerArtistCache.set(artist, events)
    return events
  } catch {
    bandsintownPerArtistCache.set(artist, [])
    return []
  }
}

/** Fan out across the user's top artists, throttled to 8 concurrent
 *  requests so we don't trip rate limits even on a fresh library
 *  with 100+ unique artists. Returns events sorted by datetime asc. */
export async function getTourDatesForArtists(artists: string[]): Promise<TourDate[]> {
  const slice = artists.slice(0, 60)
  const aggregateKey = slice.slice().sort().join('||')
  const cached = bandsintownAggregateCache.get(aggregateKey)
  if (cached) return cached

  const CONCURRENCY = 8
  const results: TourDate[][] = []
  for (let i = 0; i < slice.length; i += CONCURRENCY) {
    const batch = slice.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(getBandsintownEventsForArtist))
    results.push(...batchResults)
  }
  const flat = results.flat().sort((a, b) => a.date.localeCompare(b.date))
  bandsintownAggregateCache.set(aggregateKey, flat)
  return flat
}

// ───────────────────── 4.4.34: MusicBrainz upcoming releases ─────────────────────
// "Albums by artists in your library that haven't come out yet."
// MusicBrainz has a release-group catalog with `first-release-date`
// fields; we query for groups where the date is in the future, scoped
// to the artist names in the user's library.
//
// Rate limiting: MB allows ~50 requests / 10 sec per IP if the
// User-Agent is set with contact info. Per-artist queries would be
// 60 reqs for a top-60 library; instead we batch artists into
// Lucene-OR groups of 25, total ~3 queries. Fast enough that the
// IPC can run inline without a background prefetch.
//
// Cover art: Cover Art Archive serves by release-group MBID at
// `https://coverartarchive.org/release-group/{mbid}/front-250`.
// Returns 404 for unreleased items without uploaded art; the renderer
// has an onError handler that swaps to a placeholder.
//
// Data quality caveat: MusicBrainz coverage for upcoming releases is
// uneven. Major labels register early; smaller indies often add the
// release only after it drops. We surface whatever we get and let the
// section gracefully hide if zero results.

export interface UpcomingRelease {
  /** Album / release group title. */
  title: string
  /** Display artist name (from MB's primary artist-credit). */
  artist: string
  /** ISO-ish date. May be partial (`2026`, `2026-09`, `2026-09-15`). */
  releaseDate: string
  /** MusicBrainz release-group MBID. */
  mbid: string
  /** Cover Art Archive URL, fallback handled by renderer onError. */
  coverUrl: string
}

const upcomingAggregateCache = makeCache<UpcomingRelease[]>(24 * 60 * 60 * 1000)  // 24h

// Lucene reserves: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
// We're already quoting the value, so we only need to escape `\` and `"`.
function escapeLuceneValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function fetchUpcomingForBatch(artists: string[]): Promise<UpcomingRelease[]> {
  if (artists.length === 0) return []
  const today = new Date().toISOString().split('T')[0]
  const clauses = artists.map(a => `artist:"${escapeLuceneValue(a)}"`).join(' OR ')
  const q = `(${clauses}) AND firstreleasedate:[${today} TO 2099-12-31]`
  const url = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=50`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'JakeTunes/4.4 ( jakerosenbaum30@gmail.com )',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const data = await res.json() as {
      'release-groups'?: Array<{
        id?: string
        title?: string
        'first-release-date'?: string
        'primary-type'?: string
        'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>
      }>
    }
    const groups = data['release-groups'] || []
    const now = new Date()
    const items: UpcomingRelease[] = []
    for (const g of groups) {
      if (!g['first-release-date']) continue
      // Skip non-album types (singles, EPs, compilations are noisy)
      // — actually allow them: a single from a favorite artist is
      // still newsworthy. Filter only Other / Audiobook / Spokenword.
      const ptype = (g['primary-type'] || '').toLowerCase()
      if (ptype === 'other' || ptype === 'audiobook' || ptype === 'spokenword') continue
      // Parse partial dates conservatively: floor to start of period.
      const dateStr = g['first-release-date']
      const parsed = new Date(
        dateStr.length === 4 ? `${dateStr}-12-31` :
        dateStr.length === 7 ? `${dateStr}-28`     :
                               dateStr
      )
      if (isNaN(parsed.getTime()) || parsed < now) continue
      const credit = g['artist-credit']?.[0]
      const artist = credit?.name || credit?.artist?.name || ''
      const mbid = g.id || ''
      if (!mbid || !artist || !g.title) continue
      items.push({
        title: g.title,
        artist,
        releaseDate: dateStr,
        mbid,
        coverUrl: `https://coverartarchive.org/release-group/${mbid}/front-250`,
      })
    }
    return items
  } catch {
    return []
  }
}

export async function getUpcomingReleasesForArtists(artists: string[]): Promise<UpcomingRelease[]> {
  const slice = artists.slice(0, 60)
  const aggregateKey = slice.slice().sort().join('||')
  const cached = upcomingAggregateCache.get(aggregateKey)
  if (cached) return cached

  // Batch into groups of 25 to stay under MB's URL-length sweet spot
  // (≈400-600 chars per query at avg 20-char artist names).
  const BATCH = 25
  const batches: string[][] = []
  for (let i = 0; i < slice.length; i += BATCH) {
    batches.push(slice.slice(i, i + BATCH))
  }
  // Run batches in parallel — MB allows multiple concurrent requests
  // from a single IP as long as we stay within ~50 / 10 sec total.
  // Three batches in parallel is well under the limit.
  const results = await Promise.all(batches.map(fetchUpcomingForBatch))
  // Dedupe by MBID (same release-group can match multiple artist
  // OR clauses if an artist is in the artist-credit chain).
  const byMbid = new Map<string, UpcomingRelease>()
  for (const r of results.flat()) {
    if (!byMbid.has(r.mbid)) byMbid.set(r.mbid, r)
  }
  const flat = Array.from(byMbid.values())
    .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate))
  upcomingAggregateCache.set(aggregateKey, flat)
  return flat
}
