/**
 * Photo covers (2026-11-09). Jake sent a photo of his real Original iPod mini:
 * "for top 1000 ipod. use this photo". The Top 1000 and any iPod list can wear a
 * photo instead of its drawn iPod (common/ipod-covers.ts); "Use the drawing"
 * brings the drawing back.
 *
 * homemini keeps the photos (JakeTunesMobile backend/src/util/photoCoverStore.ts,
 * routes/photoCovers.ts) and serves them to the phone; this Mac keeps a copy
 * (main/ipod-photo-covers.ts) so the cover shows with homemini away, and a pick
 * made with homemini away waits on disk and goes when it answers.
 *
 * The Top 1000's photo also ships with this app (assets/playlist-covers/
 * top-1000-photo.jpg): a Mac that has never heard homemini's list still shows it.
 *
 * Pure — node --test loads it.
 * ⚠️ CONTRACT: homemini's GET/PUT/DELETE /api/photo-covers/:key and GET /api/photo-covers.
 */
import { parseIpodListPlaylistId } from './ipod-list-doc.ts'
import { TOP_1000_PLAYLIST_ID } from './sidebar-ipods.ts'

/** homemini's key for the Top 1000's photo (the Original's). Every other key is an iPod list's id. */
export const TOP1000_PHOTO_KEY = 'top1000'
/** homemini's cap (MAX_PHOTO_BYTES). A bigger file is refused here, before anything is kept. */
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export const isPhotoKey = (key: unknown): key is string => typeof key === 'string' && SAFE_KEY.test(key)

/** The photo key of an iPODS playlist: Top 1000 → 'top1000', an iPod list → its id; anything else null. */
export function photoKeyForPlaylist(playlistId: string | null | undefined): string | null {
  if (playlistId === TOP_1000_PLAYLIST_ID) return TOP1000_PHOTO_KEY
  const dev = parseIpodListPlaylistId(playlistId)
  return dev && isPhotoKey(dev) ? dev : null
}

export type PhotoKind = 'jpeg' | 'png'

/** A picked file's own kind, by its first bytes (never its name). */
export function photoKind(bytes: Uint8Array): PhotoKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'png'
  return null
}

/** Why a picked file can't be a cover, in Jake's words, or null when it can. */
export function photoProblem(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return 'That file is empty.'
  if (bytes.length > MAX_PHOTO_BYTES) return 'That photo is bigger than 25 MB.'
  if (!photoKind(bytes)) return 'Pick a JPEG or PNG photo.'
  return null
}

export interface PhotoIndexEntry { key: string; version: string }

/** homemini's GET /api/photo-covers body → its entries; null = not an index (keep what this Mac knows). */
export function parsePhotoIndex(raw: unknown): PhotoIndexEntry[] | null {
  const covers = (raw as { covers?: unknown } | null)?.covers
  if (!Array.isArray(covers)) return null
  const out: PhotoIndexEntry[] = []
  for (const c of covers) {
    const r = c as { key?: unknown; version?: unknown } | null
    if (isPhotoKey(r?.key) && typeof r?.version === 'string' && r.version) out.push({ key: r.key, version: r.version })
  }
  return out
}

/** What a cover shows: this Mac's copy of the photo, the photo bundled with the app, or the drawing. */
export type PhotoShown = 'kept' | 'bundled' | 'drawing'

/**
 * The rule. A pick waiting for homemini wins ("Use a photo…" shows the photo,
 * "Use the drawing" the drawing). Otherwise this Mac's copy (which follows
 * homemini's list whenever it answers). The Top 1000 shows the bundled photo
 * until this Mac has ever read homemini's list, so a new Mac or one that has
 * never reached homemini still wears it.
 */
export function photoShown(input: {
  key: string
  pending: 'set' | 'remove' | null
  kept: boolean
  indexSeen: boolean
}): PhotoShown {
  if (input.pending === 'remove') return 'drawing'
  if (input.kept) return 'kept'
  if (input.pending === 'set') return 'drawing'
  if (input.key === TOP1000_PHOTO_KEY && !input.indexSeen) return 'bundled'
  return 'drawing'
}
