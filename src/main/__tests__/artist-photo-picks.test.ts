// 2026-11-03 — photos Jake picked on homemini beat Deezer's on this Mac too, and Deezer never
// refreshes over them (Jake, on the Now Digging card: "this picture of Cameron winter is trash").
// src/main/artist-photo-picks.ts + the skip in artist-photo.ts.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArtistPhotoPicks, parsePhotoPicks, photoFileOf, PICKS_READY_CAP_MS, type PicksFetchLike } from '../artist-photo-picks.ts'
import { createArtistPhotos, PHOTO_MAX_AGE_MS } from '../artist-photo.ts'

const commons = Buffer.from('the Commons photo of Cameron Winter Jake kept on the Geese page')
const selfie = Buffer.from("Deezer's red-lit selfie")
const FILE = photoFileOf(commons)
const list = { v: 1, picks: [{ artist: 'Cameron Winter', slug: 'cameron-winter', file: FILE }] }

/** homemini: the picks list (ETag "e1") and the photo store. Records every URL asked. */
function hub(opts: { list?: unknown; status?: number; photo?: Buffer; offline?: boolean } = {}) {
  const seen: Array<{ url: string; inm?: string }> = []
  const fetchImpl: PicksFetchLike = async (url, init) => {
    const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match']
    seen.push({ url, inm })
    if (opts.offline) throw new Error('offline')
    if (url.endsWith('/api/artist-photo-picks')) {
      const status = opts.status ?? (inm === '"e1"' ? 304 : 200)
      return { ok: status === 200, status, headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? '"e1"' : null) }, json: async () => opts.list ?? list, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const bytes = opts.photo ?? commons
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => null, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
  }
  return { fetchImpl, seen }
}

function tmp(): { dir: string; stateFile: string; done(): void } {
  const root = mkdtempSync(join(tmpdir(), 'jt-photo-picks-'))
  return { dir: join(root, 'artist-images'), stateFile: join(root, 'artist-photo-picks.json'), done: () => rmSync(root, { recursive: true, force: true }) }
}
const quiet = { log: () => {}, warn: () => {} }

describe('artist photo picks', () => {
  it('reads the list; a row with a bad file name or a slug that is not its artist\'s is dropped', () => {
    assert.deepEqual(parsePhotoPicks(list), list.picks)
    assert.deepEqual(parsePhotoPicks({ v: 1, picks: [
      { artist: 'Cameron Winter', slug: 'cameron-winter', file: '../etc/passwd' },
      { artist: 'Cameron Winter', slug: 'geese', file: FILE },
      ...list.picks,
    ] }), list.picks)
    assert.equal(parsePhotoPicks({ v: 2, picks: [] }), null)
    assert.equal(parsePhotoPicks(null), null)
  })

  it('saves the picked photo as the act\'s artist-image, replacing Deezer\'s, and keeps the list', async () => {
    const t = tmp()
    try {
      const { fetchImpl, seen } = hub()
      const picks = createArtistPhotoPicks({ baseUrl: 'http://homemini:3000/', dir: t.dir, stateFile: t.stateFile, fetchImpl, ...quiet })
      assert.equal(picks.isPicked('cameron-winter'), false)
      await picks.pull()   // the folder does not exist yet
      assert.deepEqual(readFileSync(join(t.dir, 'cameron-winter.jpg')), commons)
      writeFileSync(join(t.dir, 'cameron-winter.jpg'), selfie)
      writeFileSync(join(t.dir, 'cameron-winter.miss'), '')
      assert.deepEqual(await picks.pull(), ['cameron-winter'])
      assert.deepEqual(readFileSync(join(t.dir, 'cameron-winter.jpg')), commons)
      assert.equal(existsSync(join(t.dir, 'cameron-winter.miss')), false)
      assert.equal(picks.isPicked('cameron-winter'), true)
      assert.equal(seen[0]!.url, 'http://homemini:3000/api/artist-photo-picks')
      assert.ok(seen.some((s) => s.url === `http://homemini:3000/api/artist-photo/${FILE}`))
      assert.deepEqual(JSON.parse(readFileSync(t.stateFile, 'utf8')).picks, list.picks)
    } finally { t.done() }
  })

  it('nothing moved: a 304 for the list and no download while the photo on disk is the pick', async () => {
    const t = tmp()
    try {
      const { fetchImpl, seen } = hub()
      const picks = createArtistPhotoPicks({ baseUrl: 'http://homemini:3000', dir: t.dir, stateFile: t.stateFile, fetchImpl, ...quiet })
      await picks.pull()
      seen.length = 0
      assert.deepEqual(await picks.pull(), [])
      assert.deepEqual(seen, [{ url: 'http://homemini:3000/api/artist-photo-picks', inm: '"e1"' }])
    } finally { t.done() }
  })

  it('a photo that comes back as other bytes is never saved', async () => {
    const t = tmp()
    try {
      const { fetchImpl } = hub({ photo: selfie })
      const picks = createArtistPhotoPicks({ baseUrl: 'http://homemini:3000', dir: t.dir, stateFile: t.stateFile, fetchImpl, ...quiet })
      assert.deepEqual(await picks.pull(), [])
      assert.equal(existsSync(join(t.dir, 'cameron-winter.jpg')), false)
    } finally { t.done() }
  })

  it('away from homemini (or a homemini without picks) the saved list still stands', async () => {
    const t = tmp()
    try {
      await createArtistPhotoPicks({ baseUrl: 'http://homemini:3000', dir: t.dir, stateFile: t.stateFile, fetchImpl: hub().fetchImpl, ...quiet }).pull()
      for (const h of [hub({ offline: true }), hub({ status: 404 })]) {
        const next = createArtistPhotoPicks({ baseUrl: 'http://homemini:3000', dir: t.dir, stateFile: t.stateFile, fetchImpl: h.fetchImpl, ...quiet })
        await next.ready()
        assert.equal(next.isPicked('cameron-winter'), true)
        await next.pull()
        assert.equal(next.isPicked('cameron-winter'), true)
      }
    } finally { t.done() }
  })

  it('ready() never holds a launch longer than the cap when homemini hangs', async () => {
    const t = tmp()
    try {
      const hang: PicksFetchLike = () => new Promise(() => {})
      const picks = createArtistPhotoPicks({ baseUrl: 'http://homemini:3000', dir: t.dir, stateFile: t.stateFile, fetchImpl: hang, ...quiet })
      const started = Date.now()
      picks.start()
      await picks.ready()
      assert.ok(Date.now() - started < PICKS_READY_CAP_MS + 500)
    } finally { t.done() }
  })

  it('the Deezer refresh leaves a picked act alone, and refreshes everyone else as before', async () => {
    const t = tmp()
    try {
      const old = new Date(Date.now() - PHOTO_MAX_AGE_MS - 86_400_000)
      const { mkdirSync } = await import('node:fs')
      mkdirSync(t.dir, { recursive: true })
      for (const slug of ['cameron-winter', 'geese']) {
        writeFileSync(join(t.dir, `${slug}.jpg`), slug === 'cameron-winter' ? commons : selfie)
        utimesSync(join(t.dir, `${slug}.jpg`), old, old)
      }
      const downloads: string[] = []
      let waited = false
      const photos = createArtistPhotos({
        dir: t.dir,
        factsFile: join(t.dir, '..', 'artist-deezer.json'),
        owned: async () => ({ albums: ['Getting Killed'], titles: [] }),
        fetchJson: async (url: string) => url.includes('/search/artist')
          ? { data: [{ id: 1, name: url.includes('Geese') ? 'Geese' : 'Cameron Winter', nb_fan: 10, picture_xl: 'https://cdn.example/new.jpg', type: 'artist' }] }
          : { data: [{ title: 'Getting Killed' }] },
        download: async (url: string) => { downloads.push(url); return Buffer.from('a fresh Deezer photo') },
        picked: (slug: string) => slug === 'cameron-winter',
        ready: async () => { waited = true },
      })
      assert.equal(await photos.get('Cameron Winter'), 'cameron-winter')
      assert.deepEqual(readFileSync(join(t.dir, 'cameron-winter.jpg')), commons)
      assert.equal(waited, true)
      assert.equal(downloads.length, 0)
      assert.equal(await photos.get('Geese'), 'geese')
      assert.equal(downloads.length, 1)
    } finally { t.done() }
  })
})
