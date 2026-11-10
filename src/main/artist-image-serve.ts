/**
 * artist-image:// — artist photos and artist-profile photos (members, the
 * credited header photo), moved out of index.ts (2026-11-10) so node --test
 * runs the real handler, and given the thumb tier album-art:// has.
 *
 *   artist-image://<slug>.jpg          the file as saved (the page header)
 *   artist-image://<slug>.jpg?s=NNN    downscaled to NNN px wide, cached on
 *                                      disk in artist-image-thumbs/<slug>_<NNN>.jpg
 *
 * Why the tier: a member's face is drawn in a tile at most about 260 px wide,
 * and the file behind it can be 2160x2700 (1.3 MB; 17-19 ms to decode, per
 * tile, on the page's first frames). The thumbs live in their OWN folder, not
 * under artist-images/, which other code lists and sweeps by file name.
 *
 * A thumb is served only when it was written after its photo landed on this
 * disk (thumb-freshness.ts): a photo refreshed or re-picked under the same
 * slug never keeps an old face in a tile. A photo the downscaler can't decode,
 * or one already narrower than the size asked for, is served as it is.
 *
 * Electron-free: the downscaler (nativeImage in production) is injected.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readFreshThumb } from './thumb-freshness.ts'

/** Downscale to `width` px JPEG; null = serve the original (undecodable, or not wider than `width`). */
export type MakeArtistThumb = (full: Buffer, width: number) => Buffer | null

export interface ArtistImageRequest { slug: string; size: number }

/** Parse an artist-image:// URL. The slug is reduced to [a-z0-9-], so it can never name a path. */
export function parseArtistImageUrl(url: string): ArtistImageRequest | null {
  const rest = url.replace('artist-image://', '')
  const [pathPart, queryPart] = rest.split('?')
  let raw: string
  try { raw = decodeURIComponent((pathPart || '').replace('.jpg', '')) } catch { return null }
  const slug = raw.replace(/[^a-z0-9-]/g, '')
  if (!slug) return null
  const sMatch = /(?:^|&)s=(\d+)/.exec(queryPart || '')
  const size = sMatch ? Math.min(1024, Math.max(64, parseInt(sMatch[1]!, 10))) : 0
  return { slug, size }
}

export interface ArtistImageServerDeps {
  /** userData/artist-images */
  dir: () => string
  /** userData/artist-image-thumbs */
  thumbDir: () => string
  makeThumb: MakeArtistThumb
  log?: (msg: string) => void
}

const HEADERS = {
  'Content-Type': 'image/jpeg',
  // Long cache — slug is unique per artist; disk-side TTL handles refresh
  'Cache-Control': 'public, max-age=604800',
}

const body = (data: Buffer): ArrayBuffer => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer

export function createArtistImageServer(deps: ArtistImageServerDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? ((m: string) => console.warn(m))
  return async (request: Request): Promise<Response> => {
    const req = parseArtistImageUrl(request.url)
    if (!req) return new Response('Bad slug', { status: 400 })
    const fullPath = join(deps.dir(), `${req.slug}.jpg`)
    try {
      if (!req.size) return new Response(body(await readFile(fullPath)), { headers: { ...HEADERS, 'X-Art-Source': 'full' } })
      const thumbPath = join(deps.thumbDir(), `${req.slug}_${req.size}.jpg`)
      try {
        return new Response(body(await readFreshThumb(thumbPath, fullPath)), { headers: { ...HEADERS, 'X-Art-Source': 'thumb' } })
      } catch { /* missing, or older than its photo: build it */ }
      const full = await readFile(fullPath)
      const thumb = deps.makeThumb(full, req.size)
      if (!thumb) return new Response(body(full), { headers: { ...HEADERS, 'X-Art-Source': 'full-fallback' } })
      void (async () => {
        // tmp + rename: a reader racing the write never gets half a JPEG.
        const tmp = `${thumbPath}.${process.pid}.${Date.now()}.tmp`
        try {
          await mkdir(deps.thumbDir(), { recursive: true })
          await writeFile(tmp, thumb)
          await rename(tmp, thumbPath)
        } catch (err) {
          await unlink(tmp).catch(() => {})
          log(`[artist-image] thumb write failed ${req.slug}_${req.size}: ${(err as Error)?.message ?? err}`)
        }
      })()
      return new Response(body(thumb), { headers: { ...HEADERS, 'X-Art-Source': 'thumb-built' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }
}
