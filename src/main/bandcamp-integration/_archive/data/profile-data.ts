// ════════════════════════════════════════════════════════════════════════
//  Authenticated Bandcamp profile scrape (Brief 036 v2.2, Layer 3 — G2)
//
//  Reads Jake's collection / wishlist / following via the fancollection
//  JSON API, run in-page on the bandcamp origin so cookies attach. Exact
//  response keys + token format are pinned by the Phase-1 on-device check
//  (spike confirmed fan_id=9255806 + cookie persistence); this module
//  parses defensively so a Bandcamp field rename degrades instead of
//  throwing.
// ════════════════════════════════════════════════════════════════════════

import { BcItem, BcFollow, BandcampProfile } from '../types'
import { loadAndWait, pageGetJSON, pagePostJSON, readPagedata, sleep } from './scraper'

const API = 'https://bandcamp.com/api'
const PAGE_COUNT = 20
const MAX_PAGES = 200 // safety cap (~4000 items per list)

interface CollectionSummary {
  fan_id?: number
  collection_summary?: { fan_id?: number; username?: string; url?: string }
}

/** Confirms auth + returns Jake's fan_id. null = not logged in / blocked. */
export async function getFanId(): Promise<{ fanId: number; username?: string } | null> {
  // Engine must be on the bandcamp origin for credentialed same-origin fetch.
  await loadAndWait('https://bandcamp.com')
  const summary = await pageGetJSON<CollectionSummary>(`${API}/fan/2/collection_summary`)
  const fanId = summary?.fan_id ?? summary?.collection_summary?.fan_id
  if (!fanId) return null
  return { fanId, username: summary?.collection_summary?.username }
}

/** Future-dated token returns the newest items first. */
function freshToken(): string {
  return `${Math.floor(Date.now() / 1000) + 3600}::`
}

/** Find the items array in a fancollection response regardless of key name. */
function pickItemsArray(res: Record<string, unknown> | null): unknown[] {
  if (!res) return []
  for (const key of ['items', 'followeers', 'results', 'entries']) {
    const v = res[key]
    if (Array.isArray(v)) return v
  }
  return []
}

function pickNextToken(res: Record<string, unknown> | null): string | null {
  if (!res) return null
  const more = res['more_available']
  const token = (res['last_token'] ?? res['older_than_token']) as string | undefined
  if (more === false) return null
  return token || null
}

/** Generic paginated POST loop against a fancollection endpoint. */
async function pageAll(
  endpoint: string,
  fanId: number,
  map: (raw: Record<string, unknown>) => BcItem | BcFollow | null,
): Promise<Array<BcItem | BcFollow>> {
  const out: Array<BcItem | BcFollow> = []
  let token = freshToken()
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await pagePostJSON<Record<string, unknown>>(endpoint, {
      fan_id: fanId,
      older_than_token: token,
      count: PAGE_COUNT,
    })
    if (!res || res.__httpError || res.__fetchError) break
    const rows = pickItemsArray(res)
    if (rows.length === 0) break
    for (const r of rows) {
      const m = map(r as Record<string, unknown>)
      if (m) out.push(m)
    }
    const next = pickNextToken(res)
    if (!next || next === token) break
    token = next
    await sleep(250) // polite pacing
  }
  return out
}

function str(v: unknown): string { return v == null ? '' : String(v) }
function num(v: unknown): number | undefined { const n = Number(v); return Number.isFinite(n) ? n : undefined }

function mapCollectionItem(r: Record<string, unknown>): BcItem | null {
  const artist = str(r.band_name || r.artist)
  const title = str(r.item_title || r.album_title || r.title)
  if (!artist && !title) return null
  return {
    id: num(r.tralbum_id ?? r.album_id ?? r.item_id),
    artist,
    title,
    url: str(r.item_url || r.url) || undefined,
    // Tags/label/geo aren't in the list payload — enriched per-album in
    // Phase 2. Library genre is the dominant tag signal for Tier 1.
    tags: Array.isArray(r.genre) ? (r.genre as string[]) : [],
    label: str(r.label) || undefined,
    releaseDate: str(r.release_date) || undefined,
  }
}

function mapFollow(r: Record<string, unknown>): BcFollow | null {
  const name = str(r.band_name || r.name)
  if (!name) return null
  return {
    name,
    url: str(r.url_hints ? '' : (r.url || '')) || undefined,
    kind: r.is_label ? 'label' : 'band',
  }
}

/** Full profile scrape. `prev` enables incremental refresh (stops early
 *  once it reaches items already seen). */
export async function fetchProfile(): Promise<BandcampProfile | null> {
  const who = await getFanId()
  if (!who) return null
  const { fanId, username } = who

  // username/profile url backfill from homepage pagedata when summary lacks it
  let user = username
  if (!user) {
    const home = await readPagedata<{ identities?: { fan?: { username?: string } } }>()
    user = home?.identities?.fan?.username
  }

  const collection = (await pageAll(`${API}/fancollection/1/collection_items`, fanId, mapCollectionItem)) as BcItem[]
  const wishlist = (await pageAll(`${API}/fancollection/1/wishlist_items`, fanId, mapCollectionItem)) as BcItem[]
  const following = (await pageAll(`${API}/fancollection/1/following_bands`, fanId, mapFollow)) as BcFollow[]

  return {
    fanId,
    username: user,
    fetchedAt: Date.now(),
    collection,
    wishlist,
    following,
  }
}
