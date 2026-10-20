/**
 * Artist bio from Wikipedia for the artist page — and the Music Man's
 * Wikipedia grounding (2026-10-20, moved out of index.ts).
 *
 * The rules (which page IS the artist) are src/common/wiki-artist-bio.ts,
 * ⚠️ TWIN of JakeTunesMobile backend/src/util/wikipedia.ts. Before this, the
 * desktop took MusicBrainz's link or the bare name and trusted any page that
 * wasn't a disambiguation list: Geese got the article about the bird, Nirvana
 * the Buddhist concept.
 *
 * Cache: userData/wiki-cache-v2/<md5(name)>.json — a hit lives 24 h, a miss
 * 1 h (transient failures self-heal). v2 because every v1 entry was produced
 * by the unvalidated lookup and some are the wrong entity; they are simply
 * never read again.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assessSummary, bioTitleCandidates, searchTitleEligible, type ArtistBio, type WikiSummaryLike } from '../common/wiki-artist-bio.ts'

export interface ArtistWikiDeps {
  /** userData */
  dir: string
  userAgent: string
  /** MusicBrainz's view of the artist (Wikipedia link, type, tags) — null when unknown. */
  canon: (artist: string) => Promise<{ wikiTitle?: string | null; type?: string; tags?: string[] } | null>
  fetchImpl?: typeof fetch
}

export interface WikiSummary { extract: string | null; pageUrl: string | null }

const HIT_TTL_MS = 24 * 60 * 60 * 1000
const MISS_TTL_MS = 60 * 60 * 1000

export function createArtistWiki(deps: ArtistWikiDeps): { fetchWikiSummary: (artist: string) => Promise<WikiSummary> } {
  const fetchImpl = deps.fetchImpl ?? fetch
  const cacheDir = join(deps.dir, 'wiki-cache-v2')
  const headers = { 'User-Agent': deps.userAgent }

  async function summary(title: string, artist: string): Promise<ArtistBio | null> {
    const res = await fetchImpl(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`, { headers })
    if (!res.ok) return null
    return assessSummary(artist, title, (await res.json()) as WikiSummaryLike)
  }

  async function searchFallback(artist: string): Promise<ArtistBio | null> {
    for (const q of [`${artist} band`, `${artist} musician band`]) {
      const res = await fetchImpl(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=10&srsearch=${encodeURIComponent(q)}`, { headers })
      if (!res.ok) continue
      const data = (await res.json()) as { query?: { search?: Array<{ title?: unknown }> } }
      for (const hit of data.query?.search ?? []) {
        if (typeof hit.title !== 'string' || !searchTitleEligible(hit.title, artist)) continue
        const bio = await summary(hit.title, artist)
        if (bio) return bio
      }
    }
    return null
  }

  async function lookup(artist: string): Promise<ArtistBio | null> {
    const name = artist.trim()
    let canon: Awaited<ReturnType<ArtistWikiDeps['canon']>> = null
    try { canon = await deps.canon(name) } catch (err) { console.warn('[wiki] resolver failed for', name, err) }
    for (const title of bioTitleCandidates(name, canon)) {
      try {
        const bio = await summary(title, name)
        if (bio) return bio
      } catch { /* next title */ }
    }
    try { return await searchFallback(name) } catch { return null }
  }

  async function fetchWikiSummary(artist: string): Promise<WikiSummary> {
    await mkdir(cacheDir, { recursive: true }).catch(() => {})
    const cachePath = join(cacheDir, `${createHash('md5').update(artist.toLowerCase().trim()).digest('hex')}.json`)
    try {
      const st = await stat(cachePath)
      const cached = JSON.parse(await readFile(cachePath, 'utf-8')) as WikiSummary
      if (Date.now() - st.mtimeMs < (cached.extract ? HIT_TTL_MS : MISS_TTL_MS)) return cached
    } catch { /* not cached */ }
    const bio = await lookup(artist)
    const out: WikiSummary = { extract: bio?.extract ?? null, pageUrl: bio?.url ?? null }
    await writeFile(cachePath, JSON.stringify(out)).catch((err: NodeJS.ErrnoException) => console.warn('[wiki] summary cache write failed:', err?.message ?? err))
    return out
  }

  return { fetchWikiSummary }
}
