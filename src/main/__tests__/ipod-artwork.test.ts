/**
 * Album covers on colour iPods (2026-11-18): the Mac-side halves in
 * ipod-artwork.ts, and core/tests/test_ipod_artwork.py (the ArtworkDB itself,
 * the iPod Video formats, and a mini getting nothing) run from here so it
 * gates `npm test`.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARTWORK_CACHE_DIR, artworkFamilies, artworkOutcome, artworkPathsFor, installArtworkOnIpod, prepareArtworkArgs, rememberArtworkFamily, rememberedArtworkFamily } from '../ipod-artwork.ts'

describe('artworkPathsFor / prepareArtworkArgs', () => {
  test('album artist first, then the song artist; rows are not changed', async () => {
    const asked: string[] = []
    const covers: Record<string, string> = { 'Various|Comp': '/art/comp.jpg', 'Band|Solo': '/art/solo.jpg' }
    const resolve = async (artist: string, album: string): Promise<string | null> => {
      asked.push(`${artist}|${album}`)
      return covers[`${artist}|${album}`] ?? null
    }
    const rows = [
      { id: 1, artist: 'A', albumArtist: 'Various', album: 'Comp' },
      { id: 2, artist: 'B', albumArtist: 'Various', album: 'Comp' },
      { id: 3, artist: 'Band', albumArtist: 'Someone', album: 'Solo' },
      { id: 4, artist: 'Nobody', album: 'Nothing' },
      { id: 5, artist: 'X', album: '' },
    ]
    const before = JSON.stringify(rows)
    const out = await artworkPathsFor(rows, resolve)
    assert.deepEqual(out.paths, { 1: '/art/comp.jpg', 2: '/art/comp.jpg', 3: '/art/solo.jpg' })
    assert.equal(out.withArt, 3)
    assert.equal(JSON.stringify(rows), before, 'the caller\'s rows are untouched')
    assert.equal(asked.filter((a) => a === 'Various|Comp').length, 1, 'one look per album')
    assert.ok(!asked.some((a) => a.endsWith('|')), 'no look without an album')
  })

  test('a resolver that throws costs only that album', async () => {
    const out = await artworkPathsFor([{ id: 1, artist: 'A', album: 'B' }, { id: 2, artist: 'C', album: 'D' }],
      async (a) => { if (a === 'A') throw new Error('boom'); return '/art/d.jpg' })
    assert.deepEqual(out.paths, { 2: '/art/d.jpg' })
  })

  test('prepareArtworkArgs writes the map db_reader reads and names both flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jt-art-'))
    const local = join(root, 'art')
    const args = await prepareArtworkArgs([{ id: 7, artist: 'A', album: 'B' }], async () => '/art/b.jpg', local, () => {})
    assert.deepEqual(args, ['--artwork-out', local, '--artwork-map', local + '.map.json'])
    assert.deepEqual(JSON.parse(await readFile(local + '.map.json', 'utf8')), { 7: '/art/b.jpg' })
  })
})

describe('installArtworkOnIpod', () => {
  test('nothing built (a mini): the card is not touched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jt-art-'))
    const mount = join(root, 'ipod')
    await mkdir(mount)
    const empty = join(root, 'empty')
    await mkdir(empty)
    for (const dir of [empty, join(root, 'missing')]) {
      const r = await installArtworkOnIpod(dir, mount)
      assert.equal(r.installed, false)
    }
    assert.equal(existsSync(join(mount, 'iPod_Control')), false, 'no Artwork folder created')
  })

  test('a set lands whole, with no temporary files left', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jt-art-'))
    const local = join(root, 'local')
    const mount = join(root, 'ipod')
    await mkdir(local)
    await mkdir(join(mount, 'iPod_Control', 'Artwork'), { recursive: true })
    await writeFile(join(mount, 'iPod_Control', 'Artwork', 'ArtworkDB'), 'old')
    await writeFile(join(local, 'F1028_1.ithmb'), Buffer.alloc(20000, 1))
    await writeFile(join(local, 'F1029_1.ithmb'), Buffer.alloc(80000, 2))
    await writeFile(join(local, 'ArtworkDB'), 'new')
    await writeFile(join(local, 'stray.txt'), 'not ours')
    const r = await installArtworkOnIpod(local, mount)
    assert.equal(r.installed, true, r.summary)
    assert.deepEqual(r.files, ['F1028_1.ithmb', 'F1029_1.ithmb', 'ArtworkDB'], 'thumbnails first, ArtworkDB last')
    const names = (await readdir(join(mount, 'iPod_Control', 'Artwork'))).sort()
    assert.deepEqual(names, ['ArtworkDB', 'F1028_1.ithmb', 'F1029_1.ithmb'])
    assert.equal(await readFile(join(mount, 'iPod_Control', 'Artwork', 'ArtworkDB'), 'utf8'), 'new')
    assert.equal((await readFile(join(mount, 'iPod_Control', 'Artwork', 'F1029_1.ithmb'))).length, 80000)
  })

  test('thumbnails without an ArtworkDB are never installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jt-art-'))
    const local = join(root, 'local')
    const mount = join(root, 'ipod')
    await mkdir(local)
    await mkdir(mount)
    await writeFile(join(local, 'F1028_1.ithmb'), Buffer.alloc(10))
    const r = await installArtworkOnIpod(local, mount)
    assert.equal(r.installed, false)
    assert.equal(existsSync(join(mount, 'iPod_Control')), false)
  })
})

describe('core/tests/test_ipod_artwork.py', () => {
  test('ArtworkDB round trip, iPod Video formats, a mini writes nothing', () => {
    const script = join(import.meta.dirname, '..', '..', '..', 'core', 'tests', 'test_ipod_artwork.py')
    const r = spawnSync('python3', [script], { encoding: 'utf8', timeout: 120_000 })
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return // no python3 on this runner
    assert.equal(r.status, 0, `${r.stdout.slice(-3000)}\n${r.stderr.slice(-2000)}`)
    assert.match(r.stdout, /all ok/)
  })
})

describe('artwork table: remembered model, outcome, cache folder (2026-11-19)', () => {
  test('prepareArtworkArgs adds the iPod\'s cache folder and its remembered model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jt-art-'))
    const local = join(root, 'art')
    const ipod = join(root, 'ipod-pools', 'x')
    const plain = await prepareArtworkArgs([{ id: 7, artist: 'A', album: 'B' }], async () => '/art/b.jpg', local, () => {}, { ipodStateDir: ipod })
    assert.deepEqual(plain, ['--artwork-out', local, '--artwork-map', local + '.map.json', '--artwork-cache', join(ipod, ARTWORK_CACHE_DIR)])
    assert.equal(await rememberArtworkFamily(ipod, 'nano-2g', ['video', 'nano-2g']), true)
    assert.equal(await rememberedArtworkFamily(ipod), 'nano-2g')
    const withModel = await prepareArtworkArgs([{ id: 7, artist: 'A', album: 'B' }], async () => '/art/b.jpg', local, () => {}, { ipodStateDir: ipod })
    assert.deepEqual(withModel.slice(-2), ['--artwork-family', 'nano-2g'])
  })

  test('only a family the table knows, or "none", is remembered', async () => {
    const ipod = await mkdtemp(join(tmpdir(), 'jt-art-'))
    assert.equal(await rememberArtworkFamily(ipod, 'zune', ['video']), false)
    assert.equal(await rememberedArtworkFamily(ipod), null)
    assert.equal(await rememberArtworkFamily(ipod, 'none', ['video']), true)
    assert.equal(await rememberedArtworkFamily(ipod), 'none')
  })

  test('artworkOutcome reads db_reader\'s answer in plain words', () => {
    assert.deepEqual(artworkOutcome(JSON.stringify({ ok: true, artwork: { images: 12, familyName: 'iPod Video (5G / 5.5G)', ask: false } })),
      { images: 12, model: 'iPod Video (5G / 5.5G)', ask: false, skipped: null })
    assert.equal(artworkOutcome(JSON.stringify({ ok: true, artwork: { ask: true } }))?.ask, true)
    assert.match(artworkOutcome(JSON.stringify({ ok: true, artwork: { ask: true } }))?.skipped ?? '', /which iPod/)
    assert.match(artworkOutcome(JSON.stringify({ ok: true, artwork: { error: 'UnsupportedFormat: x' } }))?.skipped ?? '', /couldn’t be made/)
    assert.equal(artworkOutcome(JSON.stringify({ ok: true, artwork: { model: null, why: 'iPod mini has no colour screen' } }))?.skipped, null)
    assert.equal(artworkOutcome('not json'), null)
  })

  test('artworkFamilies lists the colour iPods in the shipped table', async () => {
    const file = join(import.meta.dirname, '..', '..', '..', 'core', 'ipod_artwork_models.json')
    const fams = (await artworkFamilies(file)).map((f) => f.family)
    assert.deepEqual(fams, ['video', 'nano-1g', 'nano-2g', 'photo'])
  })
})

describe('core/tests/test_ipod_artwork_table.py', () => {
  test('the table, every format\'s byte size, model detection, the cache', () => {
    const script = join(import.meta.dirname, '..', '..', '..', 'core', 'tests', 'test_ipod_artwork_table.py')
    const r = spawnSync('python3', [script], { encoding: 'utf8', timeout: 120_000 })
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return // no python3 on this runner
    assert.equal(r.status, 0, `${r.stdout.slice(-3000)}\n${r.stderr.slice(-2000)}`)
    assert.match(r.stdout, /all ok/)
  })
})
