/**
 * album-art:// — the album cover protocol and its 320px thumb pregeneration,
 * moved out of index.ts (2026-10-19) so node --test and the Concerts-page
 * harness run the real handler. Electron-free: the byte cache and the image
 * downscaler (nativeImage in production) are injected.
 *
 * Tiers: `album-art://<hash>[_<epoch>].jpg` is the full cover (heroes, the
 * now-playing panel, Get Info); `?s=NNN` is a downscaled thumb cached on disk
 * in artwork/thumbs/<bare>_<NNN>.jpg (grids, the Live Concerts rows). `r=N`
 * (renderer/artRevision.ts) is a cache-buster only: the renderer bumps it when
 * a hash's bytes change under the same versioned name, because Chromium keeps
 * an `immutable` image in memory for the life of the renderer.
 *
 * 2026-10-19, the workmini Concerts page (Nirvana x2, Rush, Talking Heads, Led
 * Zeppelin "don't look right" while the now-playing art for the same show was
 * right): same hash, different TIER. The rows draw ?s=320 thumbs, and
 * workmini's were generated Jul 10 from the covers the posters replaced on
 * Sep 2; the handler served any thumb that EXISTED. Thumbs are now served only
 * when newer than their art (thumb-freshness.ts) and written atomically.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readFreshThumb, thumbsToBuild } from './thumb-freshness.ts'
import { isSafeCacheKey } from './path-safety.ts'

/** Downscale to `width` px JPEG; null when the bytes can't be decoded. */
export type MakeThumb = (full: Buffer, width: number) => Buffer | null

export interface AlbumArtRequest {
  /** Bare hash (version suffix stripped) — the file name on disk. */
  hash: string
  /** Thumb width, 0 = full size. */
  size: number
  /** Byte-cache key: `<bare>` or `<bare>@<size>`. */
  cacheKey: string
}

/** Parse an album-art:// URL; null when the key is not one of ours (a path, `..`). */
export function parseAlbumArtUrl(url: string): AlbumArtRequest | null {
  const rest = url.replace('album-art://', '')
  const [pathPart, queryPart] = rest.split('?')
  let rawHash: string
  try { rawHash = decodeURIComponent((pathPart || '').replace('.jpg', '')) } catch { return null }
  // Strip cache-bust suffix (e.g. "abc123_1713100000000" → "abc123")
  const hash = rawHash.replace(/_\d+$/, '')
  // The hash is joined onto the artwork dir, so it must be one of OUR keys and
  // not a path: unvalidated, album-art://..%2F..%2Fsecret.jpg walks out.
  if (!isSafeCacheKey(hash)) return null
  const sMatch = /(?:^|&)s=(\d+)/.exec(queryPart || '')
  const size = sMatch ? Math.min(1024, Math.max(64, parseInt(sMatch[1]!, 10))) : 0
  return { hash, size, cacheKey: size ? `${hash}@${size}` : hash }
}

export interface AlbumArtServerDeps {
  artworkDir: () => string
  getCached: (key: string) => ArrayBuffer | undefined
  putCached: (key: string, body: ArrayBuffer) => void
  makeThumb: MakeThumb
  log?: (msg: string) => void
}

/** tmp + rename: a reader racing the write never gets half a JPEG (which the
 *  byte cache would then keep serving). */
async function writeAtomic(path: string, data: Buffer, log: (m: string) => void): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch((e: NodeJS.ErrnoException) => { if (e?.code !== 'ENOENT') log(`[album-art] left ${tmp}: ${e?.message}`) })
    throw err
  }
}

const ART_HEADERS = {
  'Content-Type': 'image/jpeg',
  // Versioned hash in the URL busts browser cache on art change;
  // long max-age makes scroll-back instant within a session.
  'Cache-Control': 'public, max-age=31536000, immutable',
}

export function createAlbumArtServer(deps: AlbumArtServerDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? ((m: string) => console.warn(m))
  return async (request: Request): Promise<Response> => {
    const req = parseAlbumArtUrl(request.url)
    if (!req) {
      log(`[album-art] refused key: ${request.url.slice(0, 80)}`)
      return new Response('Forbidden', { status: 403 })
    }
    const { hash, size, cacheKey } = req
    const cached = deps.getCached(cacheKey)
    if (cached) return new Response(cached, { headers: { ...ART_HEADERS, 'X-Art-Source': 'memory' } })
    const fullPath = join(deps.artworkDir(), `${hash}.jpg`)
    try {
      let data: Buffer
      let source = 'full'
      if (size) {
        const thumbDir = join(deps.artworkDir(), 'thumbs')
        const thumbPath = join(thumbDir, `${hash}_${size}.jpg`)
        try {
          // Fresh = written after its art landed on this disk. A thumb that
          // merely EXISTS can predate a replaced cover (workmini, Jul 10 vs Sep 2).
          data = await readFreshThumb(thumbPath, fullPath)
          source = 'thumb'
        } catch {
          // Generate once: decode full art, downscale, persist. Some covers
          // defeat nativeImage (CMYK JPEGs, an HTML 404 page saved as .jpg):
          // serve the ORIGINAL bytes, which Chromium decodes fine — a thumb
          // miss must never 404 art that used to display.
          const full = await readFile(fullPath)
          const thumb = deps.makeThumb(full, size)
          if (thumb) {
            data = thumb
            source = 'thumb-built'
            await mkdir(thumbDir, { recursive: true }).catch(() => {})
            void writeAtomic(thumbPath, thumb, log).catch((err: unknown) => log(`[album-art] thumb write failed ${hash}_${size}: ${(err as Error)?.message ?? err}`))
          } else {
            data = full
            source = 'full-fallback'
          }
        }
      } else {
        data = await readFile(fullPath)
      }
      // A fresh ArrayBuffer of exactly the bytes (BodyInit's ArrayBuffer
      // constraint under the latest @types/node).
      const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      deps.putCached(cacheKey, body)
      return new Response(body, { headers: { ...ART_HEADERS, 'X-Art-Source': source } })
    } catch {
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }
  }
}

export interface PregenerateDeps {
  artworkDir: () => string
  makeThumb: MakeThumb
  /** Only these bares (freshly mirrored art); default: the whole store. */
  only?: readonly string[]
  /** Spacing between thumbs so grids and playback never feel it. */
  gapMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

export interface PregenerateResult { todo: number; made: number; undecodable: string[] }

/**
 * Build the 320px tier for every cover whose thumb is missing OR older than
 * its art, in the background. Logs at warn so the outcome reaches main.log:
 * on 2026-10-19 this pass ran on both Macs, found only 4 covers nativeImage
 * cannot decode (two CMYK JPEGs, two HTML 404 pages saved as .jpg), built
 * 0/4, and said so only through console.log, which main.log never records.
 */
export async function pregenerateThumbs(deps: PregenerateDeps): Promise<PregenerateResult> {
  const log = deps.log ?? ((m: string) => console.warn(m))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const gapMs = deps.gapMs ?? 40
  const result: PregenerateResult = { todo: 0, made: 0, undecodable: [] }
  try {
    const artDir = deps.artworkDir()
    const thumbDir = join(artDir, 'thumbs')
    await mkdir(thumbDir, { recursive: true })
    const names = deps.only ? deps.only.map((b) => `${b}.jpg`) : await readdir(artDir)
    const todo = await thumbsToBuild(artDir, thumbDir, names)
    result.todo = todo.length
    if (todo.length === 0) return result
    for (const f of todo) {
      try {
        const thumb = deps.makeThumb(await readFile(join(artDir, f)), 320)
        if (thumb) {
          await writeAtomic(join(thumbDir, f.replace(/\.jpg$/, '_320.jpg')), thumb, log)
          result.made++
        } else {
          result.undecodable.push(f.replace(/\.jpg$/, ''))
        }
      } catch { result.undecodable.push(f.replace(/\.jpg$/, '')) }
      await sleep(gapMs)
    }
    const bad = result.undecodable
    log(`[art-thumbs] built ${result.made}/${result.todo} 320px thumb(s) (missing or older than their art)` +
      (bad.length ? `; ${bad.length} cover(s) nativeImage can't decode, served full-size instead: ${bad.slice(0, 6).join(', ')}${bad.length > 6 ? ', …' : ''}` : ''))
  } catch (err) {
    log(`[art-thumbs] pregeneration failed: ${err instanceof Error ? err.message : err}`)
  }
  return result
}
