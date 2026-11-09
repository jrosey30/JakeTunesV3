/**
 * Photo covers (2026-11-09). Jake, with a photo of his real Original iPod mini:
 * "for top 1000 ipod. use this photo".
 *
 *   • which cover shows: a pick waiting for homemini wins; then this Mac's copy;
 *     the Top 1000 wears the bundled photo until homemini's list was ever read;
 *     otherwise the drawing (photo > drawing, "Use the drawing" brings it back)
 *   • "Use a photo…": checked (JPEG/PNG by its bytes, 25 MB), kept and waiting on
 *     disk before homemini is asked; homemini's square replaces the picked file
 *   • homemini away: the pick shows at once and goes on the next sync
 *   • homemini refuses: the pick is dropped, never sent again, and Jake hears why
 *   • ⚠️ CONTRACT: JakeTunesMobile backend/src/routes/photoCovers.ts
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_PHOTO_BYTES, parsePhotoIndex, photoKeyForPlaylist, photoKind, photoProblem, photoShown, TOP1000_PHOTO_KEY,
} from '../../common/ipod-photo-covers.ts'
import { createPhotoCoverClient, createPhotoCovers, PHOTO_DIR, type PhotoCoverClient, type PutAnswer } from '../ipod-photo-covers.ts'

const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'ipod-photo-covers-')); dirs.push(d); return d }

const LIST = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9])
const MADE = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 7, 7, 7]) // homemini's square

/** homemini in memory: up or away, and what it refuses. */
function fakeHomemini() {
  const photos = new Map<string, { bytes: Buffer; version: string }>()
  let n = 0
  const h = {
    up: true,
    refuse: null as null | { status: number; error: string },
    puts: [] as string[],
    deletes: [] as string[],
    photos,
    client: {
      async index() { return h.up ? [...photos].map(([key, p]) => ({ key, version: p.version })) : null },
      async get(key: string) { const p = h.up ? photos.get(key) : undefined; return p ? { bytes: p.bytes, version: p.version } : null },
      async put(key: string, _bytes: Buffer): Promise<PutAnswer> {
        if (!h.up) return { kind: 'later' }
        h.puts.push(key)
        if (h.refuse) return { kind: 'refused', ...h.refuse }
        const version = `v${++n}`
        photos.set(key, { bytes: MADE, version })
        return { kind: 'ok', version }
      },
      async remove(key: string) { if (!h.up) return false; h.deletes.push(key); photos.delete(key); return true },
    } satisfies PhotoCoverClient,
  }
  return h
}

const dataOf = (url: string | null) => (url ? Buffer.from(url.split(',')[1]!, 'base64') : null)

describe('the rules', () => {
  it('the Top 1000 and each iPod list have a key; nothing else does', () => {
    assert.equal(photoKeyForPlaylist('top-1000'), TOP1000_PHOTO_KEY)
    assert.equal(photoKeyForPlaylist(`ipod-list-${LIST}`), LIST)
    assert.equal(photoKeyForPlaylist('listen-more-weekly'), null)
    assert.equal(photoKeyForPlaylist(null), null)
  })

  it('a photo is a JPEG or PNG by its own bytes, never empty, never over 25 MB', () => {
    assert.equal(photoKind(JPEG), 'jpeg')
    assert.equal(photoKind(PNG), 'png')
    assert.equal(photoProblem(JPEG), null)
    assert.match(photoProblem(Buffer.from('GIF89a....'))!, /JPEG or PNG/)
    assert.match(photoProblem(Buffer.alloc(0))!, /empty/)
    const big = Buffer.alloc(MAX_PHOTO_BYTES + 1); JPEG.copy(big)
    assert.match(photoProblem(big)!, /25 MB/)
  })

  it('homemini\'s list: good entries kept, junk dropped, a non-list is null', () => {
    assert.deepEqual(parsePhotoIndex({ covers: [{ key: 'top1000', version: 'a-b', at: 'x' }, { key: '../x', version: '1' }, { key: LIST }] }), [{ key: 'top1000', version: 'a-b' }])
    assert.equal(parsePhotoIndex({ nope: true }), null)
    assert.equal(parsePhotoIndex(null), null)
  })

  it('photo > drawing; a waiting pick wins; the Top 1000 wears the bundled photo until homemini was read', () => {
    const at = (o: Partial<Parameters<typeof photoShown>[0]>) => photoShown({ key: LIST, pending: null, kept: false, indexSeen: true, ...o })
    assert.equal(at({ kept: true }), 'kept')
    assert.equal(at({}), 'drawing')
    assert.equal(at({ kept: true, pending: 'remove' }), 'drawing', '"Use the drawing" shows at once')
    assert.equal(at({ key: TOP1000_PHOTO_KEY, indexSeen: false }), 'bundled')
    assert.equal(at({ key: TOP1000_PHOTO_KEY, indexSeen: true }), 'drawing', 'homemini says no photo: the drawing')
    assert.equal(at({ key: TOP1000_PHOTO_KEY, indexSeen: false, pending: 'remove' }), 'drawing')
    assert.equal(at({ key: LIST, indexSeen: false }), 'drawing', 'only the Top 1000 ships a photo')
  })
})

describe('"Use a photo…" and "Use the drawing"', () => {
  it('homemini up: sent at once, and homemini\'s square replaces the picked file', async () => {
    const h = fakeHomemini()
    const covers = createPhotoCovers({ stateDir: tmp(), client: h.client, log: () => {} })
    assert.deepEqual(await covers.choose(TOP1000_PHOTO_KEY, PNG), { ok: true, homemini: 'saved' })
    assert.deepEqual(h.puts, ['top1000'])
    const v = await covers.view(TOP1000_PHOTO_KEY)
    assert.equal(v.shown, 'kept')
    assert.deepEqual(dataOf(v.url), MADE)
    assert.match(v.url!, /^data:image\/jpeg;base64,/)
  })

  it('homemini away: the photo shows now, waits on disk, and goes on the next sync', async () => {
    const h = fakeHomemini()
    h.up = false
    const stateDir = tmp()
    const covers = createPhotoCovers({ stateDir, client: h.client, log: () => {} })
    assert.deepEqual(await covers.choose(LIST, JPEG), { ok: true, homemini: 'later' })
    const v = await covers.view(LIST)
    assert.equal(v.shown, 'kept')
    assert.deepEqual(dataOf(v.url), JPEG, 'the picked file until homemini makes the square')
    const state = JSON.parse(readFileSync(join(stateDir, PHOTO_DIR, 'state.json'), 'utf-8'))
    assert.deepEqual(state.pending, { [LIST]: 'set' })
    // A new process (a relaunch) finds it waiting and sends it.
    h.up = true
    await createPhotoCovers({ stateDir, client: h.client, log: () => {} }).sync()
    assert.deepEqual(h.puts, [LIST])
    assert.deepEqual(dataOf((await covers.view(LIST)).url), MADE)
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, PHOTO_DIR, 'state.json'), 'utf-8')).pending, {})
  })

  it('a file that is not a photo is refused before anything is kept or sent', async () => {
    const h = fakeHomemini()
    const stateDir = tmp()
    const covers = createPhotoCovers({ stateDir, client: h.client, log: () => {} })
    const r = await covers.choose(LIST, Buffer.from('GIF89a....'))
    assert.equal(r.ok, false)
    assert.deepEqual(h.puts, [])
    assert.equal(existsSync(join(stateDir, PHOTO_DIR, `${LIST}.jpg`)), false)
    assert.equal((await covers.choose('../etc', JPEG)).ok, false)
  })

  it('homemini refuses: Jake hears why, the cover goes back, it is never sent again', async () => {
    const h = fakeHomemini()
    h.refuse = { status: 422, error: 'too small: 120x90 (a cover needs 300px on the short side)' }
    const covers = createPhotoCovers({ stateDir: tmp(), client: h.client, log: () => {} })
    const r = await covers.choose(TOP1000_PHOTO_KEY, JPEG)
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, /too small/)
    assert.equal((await covers.view(TOP1000_PHOTO_KEY)).shown, 'bundled', 'never read homemini: the bundled photo')
    await covers.sync()
    assert.equal(h.puts.length, 1)
  })

  it('"Use the drawing": the drawing at once, homemini told now or later, and its list never brings the photo back meanwhile', async () => {
    const h = fakeHomemini()
    const stateDir = tmp()
    const covers = createPhotoCovers({ stateDir, client: h.client, log: () => {} })
    await covers.choose(LIST, JPEG)
    h.up = false
    assert.deepEqual(await covers.useDrawing(LIST), { ok: true, homemini: 'later' })
    assert.deepEqual(await covers.view(LIST), { shown: 'drawing', url: null })
    h.up = true
    // The flush runs before the list is followed, so homemini's old photo can't come back.
    await covers.sync()
    assert.deepEqual(h.deletes, [LIST])
    assert.equal(h.photos.has(LIST), false)
    assert.deepEqual(await covers.view(LIST), { shown: 'drawing', url: null })
  })

  it('homemini\'s list: a photo set elsewhere arrives, one removed elsewhere goes, a new version is fetched', async () => {
    const h = fakeHomemini()
    const covers = createPhotoCovers({ stateDir: tmp(), client: h.client, log: () => {} })
    h.photos.set(TOP1000_PHOTO_KEY, { bytes: MADE, version: 'v-a' })
    await covers.sync()
    assert.deepEqual(dataOf((await covers.view(TOP1000_PHOTO_KEY)).url), MADE)
    const newer = Buffer.from([0xff, 0xd8, 0xff, 0xee, 5])
    h.photos.set(TOP1000_PHOTO_KEY, { bytes: newer, version: 'v-b' })
    await covers.sync()
    assert.deepEqual(dataOf((await covers.view(TOP1000_PHOTO_KEY)).url), newer)
    h.photos.delete(TOP1000_PHOTO_KEY)
    await covers.sync()
    assert.deepEqual(await covers.view(TOP1000_PHOTO_KEY), { shown: 'drawing', url: null }, 'homemini read, no photo: the drawing, not the bundled one')
    // homemini away keeps what this Mac knows.
    h.photos.set(LIST, { bytes: MADE, version: 'v-c' })
    await covers.sync()
    h.up = false
    await covers.sync()
    assert.equal((await covers.view(LIST)).shown, 'kept')
  })
})

describe('the client (homemini\'s /api/photo-covers)', () => {
  type Reply = { status: number; body?: unknown; bytes?: Buffer; headers?: Record<string, string> }
  const clientFor = (reply: Reply | Error, seen: Array<{ url: string; init?: Record<string, unknown> }> = []) => createPhotoCoverClient({
    baseUrl: 'http://homemini:3000/',
    warn: () => {},
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      if (reply instanceof Error) throw reply
      return {
        status: reply.status,
        json: async () => { if (reply.body === undefined) throw new Error('not json'); return reply.body },
        arrayBuffer: async () => { const b = reply.bytes ?? Buffer.alloc(0); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer },
        headers: { get: (k: string) => reply.headers?.[k.toLowerCase()] ?? null },
      }
    },
  })

  it('PUT: 200 is saved; 400/404/413/415/422 with a reason are refused; anything else waits', async () => {
    const seen: Array<{ url: string; init?: Record<string, unknown> }> = []
    assert.deepEqual(await clientFor({ status: 200, body: { key: 'top1000', version: 'v1', at: 'x' } }, seen).put('top1000', JPEG), { kind: 'ok', version: 'v1' })
    assert.equal(seen[0]!.url, 'http://homemini:3000/api/photo-covers/top1000')
    assert.equal(seen[0]!.init?.method, 'PUT')
    for (const status of [400, 404, 413, 415, 422]) {
      assert.deepEqual(await clientFor({ status, body: { error: 'no' } }).put('top1000', JPEG), { kind: 'refused', status, error: 'no' })
    }
    assert.deepEqual(await clientFor({ status: 404 }).put('top1000', JPEG), { kind: 'later' }, 'an older homemini (HTML 404) waits for the update')
    assert.deepEqual(await clientFor({ status: 503, body: { error: 'x' } }).put('top1000', JPEG), { kind: 'later' })
    assert.deepEqual(await clientFor(new Error('ECONNREFUSED')).put('top1000', JPEG), { kind: 'later' })
  })

  it('GET the list and a photo; DELETE', async () => {
    assert.deepEqual(await clientFor({ status: 200, body: { covers: [{ key: LIST, version: 'v9' }] } }).index(), [{ key: LIST, version: 'v9' }])
    assert.equal(await clientFor({ status: 401, body: { error: 'unauthorized' } }).index(), null)
    const got = await clientFor({ status: 200, bytes: MADE, headers: { 'x-photo-cover-version': 'v9' } }).get(LIST)
    assert.deepEqual(got, { bytes: MADE, version: 'v9' })
    assert.equal(await clientFor({ status: 404, body: { error: 'no photo' } }).get(LIST), null)
    assert.equal(await clientFor({ status: 200, body: { removed: false } }).remove(LIST), true)
    assert.equal(await clientFor(new Error('down')).remove(LIST), false)
  })
})

describe('the screens', () => {
  const src = (p: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', p), 'utf-8')
  it('a photo wins over the drawn iPod wherever an iPODS cover shows', () => {
    const covers = src('renderer/utils/ipodCovers.ts')
    const fn = covers.slice(covers.indexOf('export function useIpodPlaylistCover'))
    assert.ok(fn.indexOf('if (photo) return photo') > 0 && fn.indexOf('if (photo) return photo') < fn.indexOf('return src'))
  })
  it('the sidebar row and the playlist header offer "Use a photo…" and "Use the drawing"', () => {
    for (const f of ['renderer/components/sidebar/Sidebar.tsx', 'renderer/views/SmartPlaylistView.tsx']) {
      const s = src(f)
      assert.match(s, /Use a photo…/, f)
      assert.match(s, /Use the drawing/, f)
    }
  })
  it('the Top 1000\'s photo ships with the app', () => {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'assets', 'playlist-covers', 'top-1000-photo.jpg')
    assert.ok(existsSync(p))
    assert.equal(photoKind(readFileSync(p)), 'jpeg')
  })
})
