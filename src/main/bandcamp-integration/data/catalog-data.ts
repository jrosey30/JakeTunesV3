// ════════════════════════════════════════════════════════════════════════
//  Public Bandcamp catalog reads (Brief 036 v2.2, Layer 3 — G4)
//
//  Album detail comes from the embedded `data-tralbum` JSON blob plus a
//  little DOM scraping for tags + artist location (those live outside the
//  tralbum payload). Search uses Bandcamp's JSON autocomplete endpoint
//  (the /search HTML page has no clean machine-readable form).
// ════════════════════════════════════════════════════════════════════════

import { StoreAlbum, StoreTrack } from '../types'
import { exec, loadAndWait } from './scraper'

/** Bandcamp cover-art URL. format 16 ≈ 700px (detail), 9 ≈ 210px (tiles). */
export function coverArtUrl(artId: number | undefined, format = 16): string | null {
  if (!artId) return null
  return `https://f4.bcbits.com/img/a${artId}_${format}.jpg`
}

interface AlbumPayload {
  t: Record<string, unknown> | null
  tags: string[]
  location?: string
}

function origin(url: string): string {
  try { return new URL(url).origin } catch { return 'https://bandcamp.com' }
}

function toTrack(raw: Record<string, unknown>, albumUrl: string): StoreTrack {
  const file = raw.file as Record<string, string> | undefined
  const previewUrl = file ? (file['mp3-128'] || Object.values(file)[0]) : undefined
  const link = typeof raw.title_link === 'string' ? raw.title_link : undefined
  return {
    num: Number(raw.track_num) || 0,
    title: String(raw.title || ''),
    durationSec: Math.round(Number(raw.duration) || 0),
    previewUrl: previewUrl || undefined,
    trackUrl: link ? origin(albumUrl) + link : undefined,
  }
}

function buildAlbum(url: string, payload: AlbumPayload): StoreAlbum | null {
  const t = payload.t
  if (!t) return null
  const current = (t.current as Record<string, unknown>) || {}
  const albumUrl = String(t.url || url)
  const trackinfo = Array.isArray(t.trackinfo) ? (t.trackinfo as Record<string, unknown>[]) : []
  const price = typeof current.price === 'number' ? (current.price as number) : undefined
  return {
    id: Number(t.id) || 0,
    url: albumUrl,
    title: String(current.title || t.album_title || ''),
    artist: String(t.artist || ''),
    artistUrl: origin(albumUrl),
    tags: payload.tags || [],
    label: undefined, // resolved per-page in Phase 2
    geo: payload.location || undefined,
    releaseDate: typeof current.release_date === 'string' ? (current.release_date as string) : undefined,
    coverArtId: Number(t.art_id) || undefined,
    tracks: trackinfo.map((ti) => toTrack(ti, albumUrl)),
    price,
    currency: typeof current.currency === 'string' ? (current.currency as string) : undefined,
    isPurchasable: current.is_purchasable !== false,
    owned: false,
  }
}

/** Fetch + parse a public album page. Owned-marking happens upstream. */
export async function getAlbum(url: string): Promise<StoreAlbum | null> {
  const ok = await loadAndWait(url)
  if (!ok) return null
  const payload = await exec<AlbumPayload>(
    `(()=>{` +
    `let t=null;const el=document.querySelector('[data-tralbum]');` +
    `try{t=el?JSON.parse(el.getAttribute('data-tralbum')):null}catch(e){}` +
    `const tags=Array.from(document.querySelectorAll('a.tag')).map(a=>a.textContent.trim()).filter(Boolean);` +
    `const loc=document.querySelector('.location');` +
    `return {t,tags,location:loc?loc.textContent.trim():undefined}})()`,
  )
  if (!payload) return null
  return buildAlbum(url, payload)
}

/**
 * Lightweight discography read for a followed artist (feeds the Tier-1
 * surfaces). Parses the `#music-grid` tiles. Per-release dates aren't on
 * the grid, so recency-ranking of these candidates is approximate until
 * Phase 2 enriches each release via getAlbum — flagged limitation.
 */
export async function getArtistReleases(artistUrl: string): Promise<StoreAlbum[]> {
  const base = origin(artistUrl)
  const ok = await loadAndWait(`${base}/music`)
  if (!ok) return []
  const items = await exec<Array<{ id: number; href: string; title: string; artId?: number }>>(
    `(()=>{const out=[];` +
    `document.querySelectorAll('#music-grid li').forEach(li=>{` +
    `const a=li.querySelector('a');if(!a)return;` +
    `const t=li.querySelector('.title');` +
    `const img=li.querySelector('img');` +
    `let artId;const m=img&&img.src&&img.src.match(/\\/a(\\d+)_/);if(m)artId=Number(m[1]);` +
    `out.push({id:Number((li.getAttribute('data-item-id')||'').replace(/[^0-9]/g,''))||0,` +
    `href:a.getAttribute('href')||'',title:t?t.textContent.trim():'',artId});});` +
    `return out})()`,
  )
  const bandName = await exec<string>(
    `(()=>{const b=document.querySelector('[data-band]');try{return b?JSON.parse(b.getAttribute('data-band')).name:''}catch(e){return ''}})()`,
  )
  return (items || [])
    .filter((i) => i.href && i.title)
    .map((i) => ({
      id: i.id || 0,
      url: i.href.startsWith('http') ? i.href : base + i.href,
      title: i.title,
      artist: bandName || '',
      artistUrl: base,
      tags: [],
      tracks: [],
      coverArtId: i.artId,
      isPurchasable: true,
      owned: false,
    }))
}

interface AutocompleteResult {
  type?: string
  id?: number
  name?: string
  band_name?: string
  item_url_path?: string
  url?: string
  img_id?: number
  art_id?: number
}

/**
 * Catalog search via the JSON autocomplete endpoint. Returns lightweight
 * album results (full track listing comes from getAlbum on click).
 */
export async function search(query: string): Promise<StoreAlbum[]> {
  if (!query.trim()) return []
  await loadAndWait('https://bandcamp.com')
  const body = JSON.stringify({ search_text: query, search_filter: 'a', full_page: false })
  const res = await exec<{ auto?: { results?: AutocompleteResult[] } }>(
    `fetch('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic',` +
    `{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},` +
    `body:${JSON.stringify(body)}}).then(r=>r.ok?r.json():null).catch(()=>null)`,
  )
  const results = res?.auto?.results || []
  return results
    .filter((r) => r.type === 'a' || !!r.name)
    .map((r) => ({
      id: Number(r.id) || 0,
      url: r.url || (r.item_url_path ? `https://bandcamp.com${r.item_url_path}` : ''),
      title: String(r.name || ''),
      artist: String(r.band_name || ''),
      tags: [],
      tracks: [],
      coverArtId: Number(r.img_id ?? r.art_id) || undefined,
      isPurchasable: true,
      owned: false,
    }))
    .filter((a) => a.url)
}
