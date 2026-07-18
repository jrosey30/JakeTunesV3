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
// Weather by place (or Brooklyn default). Used for Home greeting, radio
// texture, and activity-aware iPod sync. 10-min cache.
export type WeatherSnapshot = { tempF: number; condition: string; description: string; placeLabel?: string } | null
const weatherCache = makeCache<WeatherSnapshot>(10 * 60 * 1000)

async function fetchWeatherAt(lat: number, lon: number, placeLabel: string, cacheKey: string): Promise<WeatherSnapshot> {
  const cached = weatherCache.get(cacheKey)
  if (cached) return cached
  const key = process.env.OPENWEATHER_API_KEY
  if (!key) return null
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${key}&units=imperial`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) { weatherCache.set(cacheKey, null); return null }
    const data = await res.json() as {
      main?: { temp?: number },
      weather?: { main?: string; description?: string }[],
      name?: string,
    }
    const tempF = Math.round(data.main?.temp ?? 0)
    const condition = data.weather?.[0]?.main || ''
    const description = data.weather?.[0]?.description || ''
    const snap = { tempF, condition, description, placeLabel: placeLabel || data.name || cacheKey }
    weatherCache.set(cacheKey, snap)
    return snap
  } catch {
    return null
  }
}

export async function getBrooklynWeather(): Promise<WeatherSnapshot> {
  return fetchWeatherAt(40.6782, -73.9442, 'Brooklyn', 'brooklyn')
}

/** Resolve a free-text place ("Aspen, CO") via OpenWeather geocoding, then weather. */
export async function getWeatherForPlace(place: string): Promise<WeatherSnapshot> {
  const q = (place || '').trim()
  if (!q) return getBrooklynWeather()
  const cacheKey = `place:${q.toLowerCase()}`
  const cached = weatherCache.get(cacheKey)
  if (cached) return cached
  const key = process.env.OPENWEATHER_API_KEY
  if (!key) return null
  try {
    const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(q)}&limit=1&appid=${key}`
    const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(5000) })
    if (!geoRes.ok) { weatherCache.set(cacheKey, null); return null }
    const geo = await geoRes.json() as Array<{ lat?: number; lon?: number; name?: string; state?: string; country?: string }>
    const hit = geo?.[0]
    if (!hit || hit.lat == null || hit.lon == null) {
      weatherCache.set(cacheKey, null)
      return null
    }
    const label = [hit.name, hit.state, hit.country].filter(Boolean).join(', ')
    return fetchWeatherAt(hit.lat, hit.lon, label || q, cacheKey)
  } catch {
    return null
  }
}

// Format the weather snapshot for prompt injection. One short line.
export function formatWeatherForPrompt(w: WeatherSnapshot): string {
  if (!w) return ''
  const desc = w.description ? w.description.replace(/\b\w/g, c => c.toUpperCase()) : w.condition
  const where = w.placeLabel || 'Brooklyn'
  return `${where} weather right now: ${w.tempF}°F, ${desc.toLowerCase()}.`
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
  /** Release reviews only — pulled from the review page itself (the feed
   *  carries just the album name). Absent when enrichment fails. */
  artist?: string
  genre?: string
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
 * Pitchfork drives the cover-led "New This Week" releases row.
 *
 * 4.5.0: Pitchfork retired the legacy /rss/* paths. The old
 * `/rss/reviews/best/albums/` (Best New Albums) now 404s, and
 * `/rss/news/` 301-redirects to `/feed/feed-news/rss` (the news row
 * kept working only because fetch follows redirects). There is no
 * longer a Best-New-Albums-only feed — the granular feeds were
 * collapsed into a single `/feed/feed-album-reviews/rss` that carries
 * every album Pitchfork reviews, with no machine-readable "best new"
 * marker to filter on. We use that whole feed for the releases row:
 * everything Pitchfork chooses to review is a reasonable "notable
 * release," and the card is cover-led so the lost BNA curation isn't
 * visible. News URLs are pinned to their post-redirect targets to
 * avoid the extra round-trip. */
// The album-reviews feed gives ONLY the album name (<dc:creator> is the
// review author, <category> is "Reviews / Albums"). The artist and genre
// live on the review page: og:title is "Artist: Album" and the embedded
// page JSON carries "genre":"...". One bounded fetch per release item —
// they're capped at ~12 and the whole batch sits behind the 1-hour news
// cache, so this adds at most a dozen page fetches per hour. Best-effort:
// a failed enrichment just leaves the card as it was.
async function enrichReleaseReview(item: MusicNewsItem): Promise<void> {
  try {
    const res = await fetch(item.link, {
      headers: { 'User-Agent': 'JakeTunes/4.4' },
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) return
    const html = await res.text()
    const og = decodeEntities(html.match(/<meta property="og:title" content="([^"]*)"/i)?.[1] || '')
    const suffix = `: ${item.title}`
    if (og.toLowerCase().endsWith(suffix.toLowerCase())) {
      item.artist = og.slice(0, og.length - suffix.length).trim()
    } else {
      // Title drifted from og:title (deluxe markers etc.) — split on the
      // LAST ": " so artists with colons in their name stay intact.
      const idx = og.lastIndexOf(': ')
      if (idx > 0) item.artist = og.slice(0, idx).trim()
    }
    const g = html.match(/"genre":"([^"]{2,40})"/)?.[1]
    if (g) item.genre = decodeEntities(g)
  } catch { /* leave un-enriched */ }
}

async function getStructuredFeeds(): Promise<MusicNewsItem[]> {
  const cached = newsCache.get('all')
  if (cached) return cached
  const sources: { name: string; url: string; isReleaseReview: boolean }[] = [
    // Notable Releases (cover-led card row on Home). 4.5.0: all album
    // reviews — the Best-New-Albums-only feed no longer exists.
    { name: 'Pitchfork',       url: 'https://pitchfork.com/feed/feed-album-reviews/rss',      isReleaseReview: true },
    // Music News (text-led card row on Home — 4.4.30 swap; 4.5.0 URL
    // pinned to the post-301 target).
    { name: 'Pitchfork',       url: 'https://pitchfork.com/feed/feed-news/rss',               isReleaseReview: false },
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
  // Enrich the release-review cards with artist + genre off their review
  // pages (parallel, bounded — see enrichReleaseReview).
  await Promise.all(flat.filter((i) => i.isReleaseReview).map((i) => enrichReleaseReview(i)))
  newsCache.set('all', flat)
  return flat
}

// ─── 4.5.0: collapse duplicate stories in the Music News row ───
// Four outlets cover the same beat, so one big story (a festival
// announcement, say) showed up 3-4 times back-to-back, crowding out
// everything else — exactly the recycled-headlines complaint. We group
// items that are clearly the SAME story and keep one per group (the
// newest), so the row shows distinct stories.
//
// Heuristic, deterministic, no AI: reduce each headline to its
// "significant" words — drop articles/prepositions and music-news
// boilerplate ("announces / shares / tour / album") that appears in
// almost every headline and so carries no which-story signal — then
// treat two headlines as the same story when they share ≥3 of those
// words. Three shared meaningful words is a strong same-subject signal
// while staying clear of false merges: two unrelated stories about the
// same artist share only the 1-2 words of the artist's name, not three.
// Grouping is by connected components, so A–B and B–C collapse A/B/C
// together even when A and B aren't directly over threshold.
const NEWS_STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'to', 'in', 'on', 'at',
  'by', 'from', 'his', 'her', 'their', 'its', 'out', 'new', 'as', 'is', 'are',
  'be', 'it', 'that', 'this', 'w', 'via', 'feat', 'ft', 'featuring',
  // music-news boilerplate verbs/nouns
  'announce', 'announces', 'announced', 'announcement', 'share', 'shares',
  'shared', 'release', 'releases', 'released', 'drop', 'drops', 'dropped',
  'reveal', 'reveals', 'revealed', 'unveil', 'unveils', 'unveiled', 'debut',
  'debuts', 'premiere', 'premieres', 'launch', 'launches', 'launched', 'tour',
  'tours', 'touring', 'dates', 'album', 'albums', 'song', 'songs', 'single',
  'singles', 'track', 'tracks', 'video', 'watch', 'listen', 'hear', 'stream',
  'streaming', 'cover', 'covers', 'live', 'show', 'shows', 'fest', 'festival',
  'music', 'set', 'sets', 'plays', 'played', 'returns', 'return', 'teases',
  'teased', 'tease', 'reissue', 'inspired',
])
function significantWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !NEWS_STOPWORDS.has(w)),
  )
}
function sharedWordCount(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n
}
/** Collapse same-story duplicates, keeping the newest item per story.
 *  Input is assumed newest-first; output preserves that order. */
function dedupeNewsByStory(items: MusicNewsItem[]): MusicNewsItem[] {
  const n = items.length
  if (n < 2) return items
  const sig = items.map((i) => significantWords(i.title))
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]!
    while (parent[x] !== r) { const nx = parent[x]!; parent[x] = r; x = nx }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)  // root = lowest index = newest
  }
  for (let i = 0; i < n; i++) {
    const si = sig[i]!
    for (let j = i + 1; j < n; j++) {
      if (sharedWordCount(si, sig[j]!) >= 3) union(i, j)
    }
  }
  const seenRoot = new Set<number>()
  const out: MusicNewsItem[] = []
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (seenRoot.has(r)) continue
    seenRoot.add(r)
    out.push(items[i]!)
  }
  return out
}

/** Music news items for the Home view — newest first, one card per story. */
export async function getMusicNews(): Promise<MusicNewsItem[]> {
  const all = await getStructuredFeeds()
  const news = all.filter(i => !i.isReleaseReview)
  return dedupeNewsByStory(news).slice(0, 12)
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
    const url = `https://musicbrainz.org/ws/2/release?query=${encodeURIComponent(q)}&fmt=json&limit=5`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'JakeTunes/4.3' },
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) { mbidCache.set(cacheKey, null); return null }
    type MbRelease = { id?: string; title?: string; 'artist-credit'?: { name?: string }[] }
    const data = await res.json() as { releases?: MbRelease[] }
    // 4.4.57 — STRICT verification. MusicBrainz search is fuzzy; taking
    // releases[0] blindly returns a wrong release for common album
    // titles. Confirm a result's title AND artist-credit actually match
    // what we asked for before trusting its MBID. No confident match →
    // null (the caller falls through to the strict Deezer search, then
    // to no-art).
    const norm = (s: string) => s.toLowerCase()
      .replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\[.*?\]\s*/g, ' ')
      .replace(/^the\s+/, '').replace(/\s+/g, ' ').trim()
    const wantArtist = norm(artist)
    const wantAlbum = norm(album)
    for (const rel of data.releases || []) {
      if (!rel.id) continue
      const relAlbum = norm(rel.title || '')
      const relArtist = norm((rel['artist-credit'] || []).map(c => c.name || '').join(' '))
      const albumOk = relAlbum === wantAlbum
        || (wantAlbum.length >= 3 && (relAlbum.startsWith(wantAlbum) || wantAlbum.startsWith(relAlbum)))
      if (relArtist === wantArtist && albumOk) {
        mbidCache.set(cacheKey, rel.id)
        return rel.id
      }
    }
    mbidCache.set(cacheKey, null)
    return null
  } catch {
    return null
  }
}

// ───────────────────────────── 4.4.32: Bandsintown ─────────────────────────────
// Tour dates per artist. Per-artist 24h cache; aggregate cache keyed
// by the artist-set hash (so a stable top-N list returns instantly
// until library or top order changes).
//
// Why Bandsintown and not Songkick: Bandsintown's free tier is more
// permissive and the data quality is good for indie/alt acts which
// dominate Jake's library.
//
// 4.5.0: the API no longer accepts arbitrary free-form app_id strings.
// Unregistered IDs (including our old 'jaketunes-desktop', plus 'test',
// 'jaketunes', '1', '123', …) now get an "explicit deny" auth error and
// return zero events — which is why every artist silently showed no
// tour dates. Registered numeric IDs still work. The durable fix is to
// register an app_id at https://artists.bandsintown.com/ and set it via
// the BANDSINTOWN_APP_ID env var; we default to '999' (Bandsintown's
// long-standing public/demo ID, verified returning live data) so the
// feature works out of the box.

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
  /** Crow-flies miles from Brooklyn — set at parse time, used to sort
   *  "the city" shows first. Internal; the renderer ignores it. */
  miles?: number
}

const BANDSINTOWN_APP_ID = process.env.BANDSINTOWN_APP_ID || '999'
const bandsintownPerArtistCache = makeCache<TourDate[]>(24 * 60 * 60 * 1000)
const bandsintownAggregateCache = makeCache<TourDate[]>(24 * 60 * 60 * 1000)

// "Near You" = a quick trip from BROOKLYN — not Norway, not Philly, and not
// the Jersey Shore (Asbury Park, Holmdel are close as the crow flies but a
// 90-min trip). Same home point the weather widget uses.
//
// Radius is a rough proxy for TRAIN TIME, so reach is region-aware:
//   NY & CT → 40 mi  full LIRR / Metro-North zone — Nassau, lower Westchester,
//                     Greenwich + Stamford CT (Jake explicitly wanted CT).
//   NJ      → 18 mi  PATH / north-Jersey ONLY (Newark, Jersey City, Hoboken,
//                     Montclair). Cuts the shore/central spots that are near
//                     in miles but transit-far.
//   else    → excluded.
// Within reach, the row sorts "the city" (≤12 mi — five boroughs + immediate,
// the just-hop-the-subway shows) first, then small venues before arenas.
const HOME_LAT = 40.6782
const HOME_LON = -73.9442
const REACH_BY_REGION: Record<string, number> = {
  NY: 40, 'NEW YORK': 40,
  CT: 40, CONNECTICUT: 40,
  NJ: 18, 'NEW JERSEY': 18,
}
const IN_THE_CITY_MILES = 12
// Unmistakable big-room keywords — used only to SORT arenas below clubs,
// never to hide them. Deliberately tight (no "center"/"hall"/"garden").
const MEGA_VENUE_RE = /\b(stadium|arena|amphitheat(?:er|re)|coliseum|ballpark|fairgrounds|speedway)\b/i

function milesFromHome(lat: number, lon: number): number {
  const R = 3959 // earth radius, miles
  const p = Math.PI / 180
  const a = Math.sin(((lat - HOME_LAT) * p) / 2) ** 2 +
    Math.cos(HOME_LAT * p) * Math.cos(lat * p) * Math.sin(((lon - HOME_LON) * p) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

interface BitEvent {
  datetime?: string
  url?: string
  venue?: { name?: string; city?: string; region?: string; country?: string; latitude?: string; longitude?: string }
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
      // NY/NJ/CT only, within the region-aware reach. Coords are present on
      // essentially every BIT event; if we can't verify the location is close,
      // we DROP it (better a missing maybe-near show than another Norway).
      const reach = REACH_BY_REGION[(ev.venue.region || '').trim().toUpperCase()]
      if (!reach) continue
      const lat = Number(ev.venue.latitude)
      const lon = Number(ev.venue.longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue
      const miles = milesFromHome(lat, lon)
      if (miles > reach) continue
      const city = [ev.venue.city, ev.venue.region || ev.venue.country].filter(Boolean).join(', ')
      events.push({
        artist,
        date: new Date(ts).toISOString(),
        venue: ev.venue.name || '',
        city,
        url: ev.url || '',
        imageUrl: ev.artist?.thumb_url || ev.artist?.image_url,
        miles,
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
  // Order for "things I can just go to": the-city shows (≤12 mi) first, then
  // small venues before arenas, then soonest date.
  const cityTier = (e: TourDate) => ((e.miles ?? 999) <= IN_THE_CITY_MILES ? 0 : 1)
  const megaTier = (e: TourDate) => (MEGA_VENUE_RE.test(e.venue) ? 1 : 0)
  const flat = results.flat().sort((a, b) =>
    cityTier(a) - cityTier(b) ||
    megaTier(a) - megaTier(b) ||
    a.date.localeCompare(b.date),
  )
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

// MusicBrainz's special-purpose "Various Artists" artist.
const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377'
function normArtist(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
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
        'secondary-types'?: string[]
        'artist-credit'?: Array<{ name?: string; artist?: { name?: string; id?: string } }>
      }>
    }
    const groups = data['release-groups'] || []
    const now = new Date()
    const ownedSet = new Set(artists.map(normArtist).filter(Boolean))
    const items: UpcomingRelease[] = []
    for (const g of groups) {
      // 1. Studio Albums/EPs only — drop Single / Broadcast / Other.
      const ptype = (g['primary-type'] || '').toLowerCase()
      if (ptype !== 'album' && ptype !== 'ep') continue
      // 2. No secondary types AT ALL — this is what kills the junk:
      //    Compilation / Live / Soundtrack / Remix / DJ-mix / Demo / Interview.
      if ((g['secondary-types'] || []).length > 0) continue
      // 3. Drop Various Artists outright (it leaks comps in even after #2).
      const credit = g['artist-credit']?.[0]
      const artist = (credit?.name || credit?.artist?.name || '').trim()
      if (!artist || artist.toLowerCase() === 'various artists' || credit?.artist?.id === VARIOUS_ARTISTS_MBID) continue
      // 4. The credited artist must actually be one the listener OWNS — not a
      //    fuzzy MB match to a tribute / "& Friends" / soundtrack credit.
      if (!ownedSet.has(normArtist(artist))) continue
      // 5. Real, month-level future date — a bare "2026" is a placeholder.
      const dateStr = g['first-release-date'] || ''
      if (dateStr.length < 7) continue
      const parsed = new Date(dateStr.length === 7 ? `${dateStr}-28` : dateStr)
      if (isNaN(parsed.getTime()) || parsed < now) continue
      const mbid = g.id || ''
      if (!mbid || !g.title) continue
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
  // Run batches SEQUENTIALLY with a ~1.1s gap. MusicBrainz rate-limits
  // concurrent requests from one IP (~1 req/sec); the old Promise.all fired
  // all batches at once, so some came back empty under load and "On the
  // Horizon" showed nothing. Sequential is ~3s for a 60-artist library and
  // the result is cached 24h, so it only pays that once a day.
  const results: UpcomingRelease[][] = []
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 1100))
    results.push(await fetchUpcomingForBatch(batches[i]))
  }
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
