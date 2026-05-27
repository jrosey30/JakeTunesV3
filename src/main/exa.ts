/**
 * 4.5: Exa.ai integration — augments searchWeb()'s artist-facts
 * lookup with semantic search over music journalism.
 *
 * WHY: Wikipedia + MusicBrainz give static, stubby facts (release
 * dates, label history, brief bio). Exa adds current journalism +
 * critical context — review quotes, scene gossip, tour news, recent
 * collaborations. The combined block goes into every Music Man /
 * Megan / Stephen / chat call, so all character voices get the same
 * upgraded factual ground.
 *
 * COST: ~$0.005 per search call. With the 5-minute fact cache that
 * already wraps searchWeb (factCache in main/index.ts) and the 7-day
 * disk cache here, real-world spend on a typical day is pennies.
 *
 * QUERY TEMPLATES: defined as exported constants below. EDIT THESE to
 * tune what Exa actually searches for — they are the API "prompts"
 * that determine the quality of the returned facts.
 *
 * REFERENCE: https://docs.exa.ai/reference/search-api-guide-for-coding-agents
 */

import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

// ── QUERY TEMPLATES — TUNE THESE TO IMPROVE RESULT QUALITY ──────────
// Each template takes ({ artist, album }) and returns the natural-
// language query string sent to Exa. Style guide:
//   - Write like asking a music journalist, not a search engine.
//   - Name outlets (Pitchfork, Stereogum, AllMusic, The Wire, etc.)
//     to bias toward primary music criticism.
//   - Be specific about what context you want (story / reviews / scene
//     / collaborations / recent activity).
//   - Don't quote song titles literally — Exa over-narrows on them.
//   - 1-3 sentences. More than that dilutes.
//
// These templates were authored by Jake using Exa's own setup-wizard
// project-description tool, then locked in here as the canonical
// queries. Edit, save, rebuild.

export const EXA_QUERY_TEMPLATES = {
  /** Per-artist (no album context). Used by mic button + chat. */
  artistFacts: ({ artist }: { artist: string }) =>
    `Find music journalism, critical writing, and biographical context about the artist "${artist}". Cover their sound and influences, the scene or era they came from, their best-known and most critically acclaimed work, how their reputation has evolved, and any notable side projects, collaborators, or recent activity. Prefer Pitchfork, Stereogum, AllMusic, The Quietus, Resident Advisor, and similar primary music-criticism sources over wiki-style summaries.`,

  /** Artist + album. Used when an album is in the prompt context. */
  artistAlbum: ({ artist, album }: { artist: string; album: string }) =>
    `Critical reception and recording context for the album "${album}" by ${artist}. Research how critics responded at release versus in retrospect, what the album represents in the artist's catalog (debut, peak, departure, comeback, contractual obligation), production and personnel and studio stories surrounding it, the cultural moment it landed in, and which tracks are considered standouts versus deep cuts. Prefer primary music criticism sources such as Pitchfork, Rolling Stone, AllMusic, NME, and The Wire.`,

  /** Recent news / tour / industry activity. Used for Radio Mode's
   *  "industry gossip" angle and HomeView news feeds. */
  recentNews: ({ artist }: { artist: string }) =>
    `Recent music news involving ${artist} from the past 12 months — tours announced or canceled, album releases or delays, new collaborations or features, label moves, lineup changes, awards, controversies, public statements, or industry incidents. Exclude evergreen biographical context; only return current, time-sensitive news that a music-news reader would consider recent.`,

  /** Similar artists / discovery. Used for recommendations. */
  similarArtists: ({ artist }: { artist: string }) =>
    `Find artists musically similar to ${artist} — peers from the same scene, era, label, geographic micro-genre, or critical lineage. Search for music journalism that explicitly groups, compares, or names ${artist} alongside other artists; also find artists frequently cited as influences on ${artist} or influenced by ${artist}. Prioritize critical writing that explains why the comparison holds, not generic recommendation-engine output.`,
}

// ── Cache + rate limit ──────────────────────────────────────────────
const EXA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const EXA_NEWS_TTL_MS = 24 * 60 * 60 * 1000    // news goes stale fast; 1 day
const EXA_RATE_LIMIT_MS = 250  // be polite — burst of 4/sec is fine
let exaLastRequestAt = 0

interface ExaCacheEntry { text: string; expiresAt: number }
const exaMemCache = new Map<string, ExaCacheEntry>()

async function exaThrottle(): Promise<void> {
  const now = Date.now()
  const since = now - exaLastRequestAt
  if (since < EXA_RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, EXA_RATE_LIMIT_MS - since))
  }
  exaLastRequestAt = Date.now()
}

function cachePathFor(query: string): string {
  // Hash-based filename so a long query → short safe filename.
  const { createHash } = require('crypto')
  const hash = createHash('sha1').update(query).digest('hex').slice(0, 24)
  return join(app.getPath('userData'), 'exa-cache', `${hash}.json`)
}

interface ExaSearchResult {
  title: string
  url: string
  highlights?: string[]
  publishedDate?: string
}

interface ExaSearchOpts {
  numResults?: number
  /** When set, adds `category: "news"` to the request — biases toward
   *  news outlets. Used by the recentNews template. */
  category?: 'news'
  /** When set, controls cache-freshness on Exa's side. 0 = always
   *  livecrawl, 24 = use cache if under a day old, omit = default
   *  (cache when available). News queries should pass 0 for freshness. */
  maxAgeHours?: number
  /** Override the default TTL for our own disk cache. News uses 1 day,
   *  evergreen artist facts use 7 days. */
  diskCacheTtlMs?: number
}

/**
 * Run an Exa search and return a formatted markdown-ish block suitable
 * for stuffing into a Claude system prompt. Empty string on error or if
 * the API key isn't configured — caller treats absence as "no Exa
 * context", same as it'd treat a Wikipedia miss.
 *
 * IMPORTANT API DETAILS (per Exa's coding-agents reference):
 *   - `useAutoprompt` is DEPRECATED — do NOT include it
 *   - `type: 'auto'` is the recommended default
 *   - `contents.highlights: true` returns query-relevant excerpts —
 *     better for LLM prompts than full text (predictable token usage)
 *   - News searches get `category: 'news'` to bias toward news indexes
 *   - `maxAgeHours: 0` forces livecrawl when freshness matters
 */
export async function exaSearch(query: string, opts?: ExaSearchOpts): Promise<string> {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return ''
  if (!query || query.trim().length === 0) return ''

  const numResults = opts?.numResults ?? 3
  const category = opts?.category
  const maxAgeHours = opts?.maxAgeHours
  const diskTtl = opts?.diskCacheTtlMs ?? EXA_CACHE_TTL_MS
  const cacheKey = `${query}|n=${numResults}|c=${category || ''}|m=${maxAgeHours ?? ''}`

  // Memory cache (per-session, fast)
  const mem = exaMemCache.get(cacheKey)
  if (mem && mem.expiresAt > Date.now()) return mem.text

  // Disk cache (survives restarts)
  const cachePath = cachePathFor(cacheKey)
  try {
    const raw = await readFile(cachePath, 'utf-8')
    const cached = JSON.parse(raw) as ExaCacheEntry
    if (cached.expiresAt > Date.now()) {
      exaMemCache.set(cacheKey, cached)
      return cached.text
    }
  } catch { /* miss */ }

  try {
    await exaThrottle()
    const body: Record<string, unknown> = {
      query,
      type: 'auto',
      numResults,
      contents: {
        highlights: true,
        ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
      },
    }
    if (category) body.category = category

    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.warn(`[exa] ${res.status} for "${query.slice(0, 60)}…": ${errBody.slice(0, 200)}`)
      return ''
    }
    const data = await res.json() as { results?: ExaSearchResult[] }
    const results = data.results || []
    if (results.length === 0) return ''

    // Format as one block per result. Title + source + date + joined
    // highlights. The source URL gives Claude a way to attribute
    // without hallucinating one.
    const formatted = results
      .map(r => {
        const title = r.title?.trim() || 'Untitled'
        const url = r.url || ''
        const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : ''
        const hl = (r.highlights || []).map(h => h.trim()).filter(Boolean)
        const excerpt = hl.length ? hl.join(' … ') : ''
        return `• ${title}${date}\n  ${url}\n  ${excerpt}`
      })
      .join('\n\n')

    const block = `[Exa music journalism]\n${formatted}`
    const entry: ExaCacheEntry = { text: block, expiresAt: Date.now() + diskTtl }
    exaMemCache.set(cacheKey, entry)
    try {
      await mkdir(join(app.getPath('userData'), 'exa-cache'), { recursive: true })
      await writeFile(cachePath, JSON.stringify(entry), 'utf-8')
    } catch { /* non-fatal */ }
    return block
  } catch (err) {
    console.warn('[exa] fetch failed:', err)
    return ''
  }
}

// Convenience wrappers around the templates. Most call sites should
// use these instead of building queries inline — keeps template edits
// centralized.

export function exaArtistFacts(artist: string): Promise<string> {
  return exaSearch(EXA_QUERY_TEMPLATES.artistFacts({ artist }))
}

export function exaArtistAlbum(artist: string, album: string): Promise<string> {
  return exaSearch(EXA_QUERY_TEMPLATES.artistAlbum({ artist, album }))
}

/** News-category search with daily disk cache + always-livecrawl on
 *  Exa's side (maxAgeHours: 0) so "recent" actually means recent. */
export function exaRecentNews(artist: string): Promise<string> {
  return exaSearch(EXA_QUERY_TEMPLATES.recentNews({ artist }), {
    category: 'news',
    maxAgeHours: 0,
    diskCacheTtlMs: EXA_NEWS_TTL_MS,
  })
}

export function exaSimilarArtists(artist: string): Promise<string> {
  return exaSearch(EXA_QUERY_TEMPLATES.similarArtists({ artist }))
}
