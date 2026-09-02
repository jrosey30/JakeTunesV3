/** The lossless play cache — first unit coverage of the coalescing,
 *  eviction and cap logic that used to live inside the protocol handler's
 *  closure (6.0 caches seam, 2026-09-02). */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readdir, stat, utimes } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createPlayCache } from '../play-cache.ts'
import { playCacheName, pathHashFor, isEntryFor } from '../play-cache-name.ts'

let root = ''
before(async () => { root = await mkdtemp(join(tmpdir(), 'jt-play-cache-')) })
after(async () => { await rm(root, { recursive: true, force: true }) })

function harness(codec: string, opts: { failTranscode?: boolean; capBytes?: number } = {}) {
  let probes = 0
  let transcodes = 0
  const pc = createPlayCache({
    dir: join(root, 'cache'),
    capBytes: opts.capBytes,
    probeCodec: async () => { probes++; return codec },
    transcode: async (_src, tmp) => {
      transcodes++
      await new Promise((r) => setTimeout(r, 15))
      if (opts.failTranscode) throw new Error('ffmpeg died')
      await writeFile(tmp, Buffer.alloc(1000, 1))
    },
    log: () => {},
  })
  return { pc, counts: () => ({ probes, transcodes }) }
}

describe('play cache', () => {
  test('non-ALAC sources play raw: null, no transcode, codec probed once per mtime', async () => {
    const { pc, counts } = harness('aac')
    await pc.ensureDir()
    assert.equal(await pc.cachePathFor('/x/a.m4a', 100, 10), null)
    assert.equal(await pc.cachePathFor('/x/a.m4a', 100, 10), null)
    assert.deepEqual(counts(), { probes: 1, transcodes: 0 })
    // changed mtime = re-probe
    await pc.cachePathFor('/x/a.m4a', 101, 10)
    assert.equal(counts().probes, 2)
  })

  test('ALAC: transcodes once into the content-tagged name, concurrent misses coalesce', async () => {
    const { pc, counts } = harness('alac')
    await pc.ensureDir()
    const src = '/x/b.m4a'
    const [p1, p2, p3] = await Promise.all([
      pc.cachePathFor(src, 500, 42), pc.cachePathFor(src, 500, 42), pc.cachePathFor(src, 500, 42),
    ])
    assert.equal(p1, p2); assert.equal(p2, p3)
    assert.equal(p1, join(pc.dir, playCacheName(src, 42, 500)))
    assert.equal(counts().transcodes, 1, 'three concurrent requests must share ONE transcode')
    assert.equal(pc.inflightCount(), 0)
    assert.equal((await stat(p1!)).size, 1000)
    // second call after landing: cache hit, no new transcode
    await pc.cachePathFor(src, 500, 42)
    assert.equal(counts().transcodes, 1)
  })

  test('a replaced source (new size/mtime) gets a NEW entry and the old one is evicted', async () => {
    const { pc } = harness('alac')
    await pc.ensureDir()
    const src = '/x/c.m4a'
    const first = await pc.cachePathFor(src, 1, 10)
    const second = await pc.cachePathFor(src, 2, 11)
    assert.notEqual(first, second)
    const names = (await readdir(pc.dir)).filter((n) => isEntryFor(n, pathHashFor(src)))
    assert.deepEqual(names, [playCacheName(src, 11, 2)])
  })

  test('a failed transcode leaves no partial file and rethrows', async () => {
    const { pc } = harness('alac', { failTranscode: true })
    await pc.ensureDir()
    await assert.rejects(pc.cachePathFor('/x/d.m4a', 1, 1), /ffmpeg died/)
    const partials = (await readdir(pc.dir)).filter((n) => n.includes('.partial'))
    assert.deepEqual(partials, [])
    assert.equal(pc.inflightCount(), 0)
  })

  test('registerKnownCodec skips the probe entirely', async () => {
    const { pc, counts } = harness('alac')
    await pc.ensureDir()
    pc.registerKnownCodec('/x/e.m4a', 7, 'aac')
    assert.equal(await pc.cachePathFor('/x/e.m4a', 7, 1), null)
    assert.equal(counts().probes, 0)
  })

  test('cap: oldest entries fall off, never the one just written', async () => {
    const { pc } = harness('alac', { capBytes: 2500 })   // three 1000-byte entries overflow
    await pc.ensureDir()
    const a = await pc.cachePathFor('/x/f1.m4a', 1, 1)
    await utimes(a!, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const b = await pc.cachePathFor('/x/f2.m4a', 1, 1)
    await utimes(b!, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000))
    const c = await pc.cachePathFor('/x/f3.m4a', 1, 1)
    await new Promise((r) => setTimeout(r, 50))   // enforceCacheCap runs detached
    const left = (await readdir(pc.dir)).filter((n) => n.endsWith('.flac'))
    assert.ok(left.includes(c!.split('/').pop()!), 'just-written entry must survive')
    assert.ok(!left.includes(a!.split('/').pop()!), 'oldest entry must be evicted')
    assert.ok(left.length <= 2)
  })
})
