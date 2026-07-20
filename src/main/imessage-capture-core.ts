/**
 * iMessage capture — pure core (no electron imports, unit-tested).
 * Link extraction / classification / page-title parsing / sender naming
 * for the chat.db watcher in imessage-capture.ts.
 */

const URL_RE = /https?:\/\/[^\s"'<>\\\x00-\x1f\x7f-￿]+/g
const MUSIC_HOST_RE = /^https?:\/\/(open\.spotify\.com|spotify\.link|(?:[a-z]+\.)?music\.apple\.com|itunes\.apple\.com)\//i

/** Every Spotify / Apple Music URL in a blob of text, cleaned of trailing punctuation. */
export function extractMusicLinks(text: string): string[] {
  const out: string[] = []
  for (const raw of text.match(URL_RE) || []) {
    const url = raw.replace(/[).,;:!?…’”]+$/, '')
    if (MUSIC_HOST_RE.test(url) && !out.includes(url)) out.push(url)
  }
  return out
}

/** chat.db attributedBody is a typedstream blob; URLs sit in it as plain
 *  ASCII. hex → latin1 is enough to regex them out. */
export function decodeAttributedBodyHex(hex: string): string {
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) return ''
  return Buffer.from(hex, 'hex').toString('latin1')
}

export type MusicLinkKind =
  | { service: 'apple'; kind: 'track'; id: string }
  | { service: 'apple'; kind: 'album'; id: string }
  | { service: 'spotify'; kind: 'track' | 'album' | 'short' }
  | { service: 'unknown' }

export function classifyMusicLink(url: string): MusicLinkKind {
  let u: URL
  try { u = new URL(url) } catch { return { service: 'unknown' } }
  const host = u.hostname.toLowerCase()
  if (host === 'open.spotify.com') {
    if (/^\/(?:intl-[a-z]+\/)?track\//i.test(u.pathname)) return { service: 'spotify', kind: 'track' }
    if (/^\/(?:intl-[a-z]+\/)?album\//i.test(u.pathname)) return { service: 'spotify', kind: 'album' }
    return { service: 'unknown' }
  }
  if (host === 'spotify.link') return { service: 'spotify', kind: 'short' }
  if (host.endsWith('music.apple.com') || host === 'itunes.apple.com') {
    const trackId = u.searchParams.get('i')
    if (trackId && /^\d+$/.test(trackId)) return { service: 'apple', kind: 'track', id: trackId }
    const song = u.pathname.match(/\/song\/[^/]*\/(?:id)?(\d+)/i)
    if (song) return { service: 'apple', kind: 'track', id: song[1] }
    const album = u.pathname.match(/\/album\/[^/]*\/(?:id)?(\d+)/i)
    if (album) return { service: 'apple', kind: 'album', id: album[1] }
    return { service: 'unknown' }
  }
  return { service: 'unknown' }
}

export interface ResolvedLink { song?: string; artist?: string; album?: string }

/** HTML page titles arrive entity-escaped ("weren&#x27;t for the wind",
 *  "Me &amp; You") — decode before anything lands on the list.
 *  ⚠️ TWIN consumers: parseSpotifyTitle below AND index.ts
 *  capture-resolve-link (omnibox) — every raw <title>/og:title read must
 *  pass through here. */
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (mm, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? mm)
}

/** Spotify page <title> → what it names. Track pages say "song (and
 *  lyrics) by", album pages "Album/Single/EP by". */
export function parseSpotifyTitle(rawTitle: string): ResolvedLink | null {
  const title = decodeHtmlEntities(rawTitle)
  const m = title.match(/^(.*?)\s*[-–]\s*(?:song(?: and lyrics)? by|album by|single by|ep by)\s*(.*?)\s*\|\s*Spotify/i)
  if (!m) return null
  const isAlbum = /[-–]\s*(?:album|single|ep) by/i.test(title)
  return isAlbum ? { album: m[1].trim(), artist: m[2].trim() } : { song: m[1].trim(), artist: m[2].trim() }
}

/** iTunes lookup response → song/album + artist. */
export function parseAppleLookup(json: unknown): ResolvedLink | null {
  const results = (json as { results?: Array<Record<string, unknown>> })?.results
  if (!Array.isArray(results)) return null
  const track = results.find((r) => r.wrapperType === 'track' && typeof r.trackName === 'string')
  if (track) return { song: String(track.trackName), artist: typeof track.artistName === 'string' ? track.artistName : undefined }
  const coll = results.find((r) => r.wrapperType === 'collection' && typeof r.collectionName === 'string')
  if (coll) return { album: String(coll.collectionName), artist: typeof coll.artistName === 'string' ? coll.artistName : undefined }
  return null
}

/** "+15165551234" → "516-555-1234"; emails pass through. */
export function prettyHandle(handle: string): string {
  const digits = handle.replace(/[^\d]/g, '')
  if (handle.includes('@') || digits.length < 10) return handle
  const d = digits.slice(-10)
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
}

/** Dedupe key: same song forwarded with different tracking params is one link. */
export function normalizeMusicUrl(url: string): string {
  try {
    const u = new URL(url)
    const i = u.searchParams.get('i')
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '')}${i ? `?i=${i}` : ''}`
  } catch { return url }
}

/** Contacts index: normalized phone (last 10 digits) / lowercased email → name. */
export function buildContactsIndex(names: string[], phones: string[][], emails: string[][]): Map<string, string> {
  const map = new Map<string, string>()
  names.forEach((name, i) => {
    if (!name || typeof name !== 'string') return
    for (const p of phones[i] || []) {
      const digits = String(p || '').replace(/[^\d]/g, '')
      if (digits.length >= 10) map.set(digits.slice(-10), name)
    }
    for (const e of emails[i] || []) {
      const em = String(e || '').trim().toLowerCase()
      if (em) map.set(em, name)
    }
  })
  return map
}

export function senderName(handle: string | null, contacts: Map<string, string>): string | undefined {
  if (!handle) return undefined
  const key = handle.includes('@') ? handle.trim().toLowerCase() : handle.replace(/[^\d]/g, '').slice(-10)
  return contacts.get(key) || prettyHandle(handle)
}

/** chat.db message.date: ns since 2001-01-01 on modern macOS (seconds on ancient). */
export function appleDateToMs(date: number): number {
  const APPLE_EPOCH_MS = 978307200000
  if (!Number.isFinite(date) || date <= 0) return 0
  return date > 1e12 ? APPLE_EPOCH_MS + date / 1e6 : APPLE_EPOCH_MS + date * 1000
}
