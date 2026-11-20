/**
 * The lossless dot on a Record Shop result (Brief 256): whether Qobuz has
 * this record or song in lossless, known before the click.
 *
 * Asked in one batch per page, never per row: the search's own words go to
 * Qobuz's catalogue search once (main/streamrip-store `shop-qobuz-lossless`,
 * one HTTP call with the token streamrip already holds, kept in main), and
 * every row on the page is matched against that one answer here. A row the
 * answer doesn't name shows nothing: Qobuz's search returns a page, not the
 * whole catalogue, so "not in the answer" is "don't know", never "no". Only a
 * streamable Qobuz item counts.
 *
 * Pure: node --test covers the parse, the matching and the cache rules.
 */
import { nameKey } from './fold-text.ts'
import { displayAlbumTitle } from './shop-search.ts'

export interface QobuzHit {
  kind: 'album' | 'track'
  artist: string
  title: string
  /** Qobuz's separate version field ("Remastered", "Live"), when it has one. */
  version?: string
  hires?: boolean
}

export type Lossless = 'hires' | 'lossless'

/** Tolerant parse of a Qobuz `catalog/search` (albums + tracks) or `album/search` answer. Streamable items only. */
export function qobuzHitsOf(body: unknown): QobuzHit[] {
  const out: QobuzHit[] = []
  if (!body || typeof body !== 'object') return out
  const b = body as {
    albums?: { items?: Array<Record<string, unknown>> }
    tracks?: { items?: Array<Record<string, unknown>> }
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const nameOf = (v: unknown): string => (v && typeof v === 'object' ? str((v as { name?: unknown }).name) : '')
  const hiresOf = (r: Record<string, unknown>): boolean => r.hires_streamable === true || (r.hires === true && r.hires_streamable !== false) || (typeof r.maximum_bit_depth === 'number' && r.maximum_bit_depth > 16 && r.hires_streamable !== false)
  for (const r of b.albums?.items || []) {
    if (!r || r.streamable !== true) continue
    const title = str(r.title), artist = nameOf(r.artist)
    if (!title || !artist) continue
    out.push({ kind: 'album', artist, title, version: str(r.version) || undefined, hires: hiresOf(r) })
  }
  for (const r of b.tracks?.items || []) {
    if (!r || r.streamable !== true) continue
    const title = str(r.title)
    const artist = nameOf(r.performer) || nameOf((r.album as Record<string, unknown> | undefined)?.artist)
    if (!title || !artist) continue
    out.push({ kind: 'track', artist, title, version: str(r.version) || undefined, hires: hiresOf(r) })
  }
  return out
}

export interface LosslessIndex {
  albums: Map<string, Lossless>
  tracks: Map<string, Lossless>
}

const k = (s: string): string => nameKey(s, '')
const artistKeys = (a: string): string[] => {
  const full = k(a)
  const noThe = k(a.replace(/^the\s+/i, ''))
  return [...new Set([full, noThe].filter(Boolean))]
}

/**
 * Every streamable Qobuz item, by artist + title, under both its bare title
 * and its title with the version ("Animals" and "Animals (2018 Remix)"), so
 * Apple's name finds it either way. Hi-res anywhere under a key wins it.
 */
export function losslessIndex(hits: readonly QobuzHit[]): LosslessIndex {
  const idx: LosslessIndex = { albums: new Map(), tracks: new Map() }
  for (const h of hits) {
    const m = h.kind === 'album' ? idx.albums : idx.tracks
    const titles = [h.title, h.version ? `${h.title} (${h.version})` : '']
      .filter(Boolean)
      .map((t) => k(t))
      .filter(Boolean)
    const v: Lossless = h.hires ? 'hires' : 'lossless'
    for (const a of artistKeys(h.artist)) {
      for (const t of titles) {
        const key = `${t}|${a}`
        if (m.get(key) !== 'hires') m.set(key, v)
      }
    }
  }
  return idx
}

/**
 * The dot for one row, or null (show nothing). The title must match exactly
 * as written (Apple's " - Single" / " - EP" stamp aside) and the artist must
 * be the same: a near title is a different edition as often as not, and a
 * dot must never say "lossless" about a record Qobuz doesn't have.
 */
export function losslessOf(idx: LosslessIndex | null | undefined, kind: 'album' | 'song', artist: string, title: string): Lossless | null {
  if (!idx) return null
  const m = kind === 'album' ? idx.albums : idx.tracks
  const t = k(kind === 'album' ? displayAlbumTitle(title) : title)
  if (!t) return null
  for (const a of artistKeys(artist)) {
    const v = m.get(`${t}|${a}`)
    if (v) return v
  }
  return null
}

/** The words under the dot. */
export const losslessTitle = (v: Lossless): string => v === 'hires' ? 'On Qobuz in hi-res' : 'On Qobuz in lossless'

/** The cache key for a page's question: the words folded, so "Pink Floyd" and "pink floyd " are asked once. */
export const losslessScope = (words: string): string => nameKey(words)

/** How long an answer is kept, and how long a failed question is left alone. */
export const LOSSLESS_TTL_MS = 30 * 60_000
export const LOSSLESS_FAIL_QUIET_MS = 60_000
export const LOSSLESS_MAX_SCOPES = 100
/** Qobuz questions in flight at once (main side). */
export const LOSSLESS_CONCURRENCY = 2
