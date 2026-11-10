// artist-image:// and its thumb tier (2026-11-10). A member's face was loaded
// at full size (up to 2160x2700, 1.3 MB) into a tile about 260 px wide. The
// handler now serves ?s=NNN downscaled and cached, fresh against its photo.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, utimes } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArtistImageServer, parseArtistImageUrl } from '../artist-image-serve.ts'
import { waitFor } from './wait-for.ts'

describe('artist-image:// addresses', () => {
  it('a slug, and a size when one is asked for (clamped like album-art://)', () => {
    assert.deepEqual(parseArtistImageUrl('artist-image://geese.jpg'), { slug: 'geese', size: 0 })
    assert.deepEqual(parseArtistImageUrl('artist-image://ap-cam-1a2b.jpg?s=480'), { slug: 'ap-cam-1a2b', size: 480 })
    assert.equal(parseArtistImageUrl('artist-image://x.jpg?s=9000')!.size, 1024)
    assert.equal(parseArtistImageUrl('artist-image://x.jpg?s=8')!.size, 64)
  })
  it('a slug can never name a path', () => {
    assert.deepEqual(parseArtistImageUrl('artist-image://..%2F..%2Fsecret.jpg'), { slug: 'secret', size: 0 })
    assert.equal(parseArtistImageUrl('artist-image://%2F%2E%2E.jpg'), null)
    assert.equal(parseArtistImageUrl('artist-image://%E0%A4%A.jpg'), null, 'a broken escape is refused, not thrown')
  })
})

describe('the artist-image:// handler', () => {
  let root: string, dir: string, thumbs: string
  let made: Array<{ bytes: number; width: number }>
  const FULL = Buffer.from('F'.repeat(5000))
  const serve = (makeThumb = (full: Buffer, width: number): Buffer | null => { made.push({ bytes: full.length, width }); return Buffer.from(`thumb@${width}`) }) =>
    createArtistImageServer({ dir: () => dir, thumbDir: () => thumbs, makeThumb, log: () => {} })
  const get = async (h: (r: Request) => Promise<Response>, url: string): Promise<{ status: number; body: string; source: string | null }> => {
    const res = await h({ url } as Request)
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()).toString(), source: res.headers.get('X-Art-Source') }
  }
  /** The thumb is written behind the response: wait for the file itself, not for a guess at how long that takes. */
  const landed = (name: string): Promise<boolean> => waitFor(() => existsSync(join(thumbs, name)), `${name} on disk`)

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'jt-artist-image-'))
    dir = join(root, 'artist-images'); thumbs = join(root, 'artist-image-thumbs')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ap-cam-1.jpg'), FULL)
    made = []
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5 }) })

  it('no size: the file as saved (the page header), and nothing is downscaled', async () => {
    const r = await get(serve(), 'artist-image://ap-cam-1.jpg')
    assert.equal(r.status, 200)
    assert.equal(r.body.length, 5000)
    assert.equal(made.length, 0)
  })

  it('a tile asks for 480: downscaled once, then served from disk — never the full file again', async () => {
    const h = serve()
    const first = await get(h, 'artist-image://ap-cam-1.jpg?s=480')
    assert.equal(first.body, 'thumb@480')
    assert.equal(first.source, 'thumb-built')
    await landed('ap-cam-1_480.jpg')
    assert.deepEqual(await readdir(thumbs), ['ap-cam-1_480.jpg'], 'kept in its own folder, not among the photos')
    assert.deepEqual((await readdir(dir)).sort(), ['ap-cam-1.jpg'], 'the photo folder holds only photos')
    const again = await get(h, 'artist-image://ap-cam-1.jpg?s=480')
    assert.equal(again.body, 'thumb@480')
    assert.equal(again.source, 'thumb')
    assert.equal(made.length, 1, 'built once')
  })

  it('a photo replaced under the same slug (a refresh, a new pick) never keeps the old face in a tile', async () => {
    const h = serve()
    await get(h, 'artist-image://ap-cam-1.jpg?s=480')
    await landed('ap-cam-1_480.jpg')
    const old = new Date(Date.now() - 3600_000)
    await utimes(join(thumbs, 'ap-cam-1_480.jpg'), old, old)          // the thumb predates…
    await writeFile(join(dir, 'ap-cam-1.jpg'), Buffer.from('N'.repeat(7000)))   // …the photo that just landed
    const r = await get(h, 'artist-image://ap-cam-1.jpg?s=480')
    assert.equal(r.source, 'thumb-built')
    assert.deepEqual(made.map((m) => m.bytes), [5000, 7000], 'rebuilt from the new photo')
  })

  it('a photo the downscaler cannot decode, or one already small enough, is served as it is', async () => {
    const r = await get(serve(() => null), 'artist-image://ap-cam-1.jpg?s=480')
    assert.equal(r.status, 200)
    assert.equal(r.body.length, 5000)
    assert.equal(r.source, 'full-fallback')
    await new Promise((res) => setTimeout(res, 30))                   // a fixed pause is fine before checking that nothing happened
    assert.deepEqual(await readdir(thumbs).catch(() => []), [], 'and nothing false is cached')
  })

  it('no such photo: 404, sized or not', async () => {
    const h = serve()
    assert.equal((await get(h, 'artist-image://nobody.jpg')).status, 404)
    assert.equal((await get(h, 'artist-image://nobody.jpg?s=480')).status, 404)
    assert.equal((await h({ url: 'artist-image://.jpg' } as Request)).status, 400)
  })

  it('the thumb on disk is whole (written by rename)', async () => {
    await get(serve(), 'artist-image://ap-cam-1.jpg?s=320')
    await landed('ap-cam-1_320.jpg')
    assert.equal((await readFile(join(thumbs, 'ap-cam-1_320.jpg'))).toString(), 'thumb@320')
    assert.deepEqual((await readdir(thumbs)).filter((f) => f.endsWith('.tmp')), [])
  })
})

describe('WIRING: index.ts serves artist-image:// through it, and never blows a small photo up', () => {
  const read = (p: string): string => readFileSync(join(import.meta.dirname, '..', p), 'utf-8')
  it('registered with its own thumb folder and the down-only scaler', () => {
    const index = read('index.ts')
    assert.match(index, /protocol\.handle\('artist-image', createArtistImageServer\(\{\s+dir: getArtistImageDir,\s+thumbDir: \(\) => join\(app\.getPath\('userData'\), 'artist-image-thumbs'\),\s+makeThumb: nativeThumbJpegDownOnly,/)
    assert.match(read('artwork-engine.ts'), /if \(img\.isEmpty\(\) \|\| img\.getSize\(\)\.width <= width\) return null/)
  })
})
