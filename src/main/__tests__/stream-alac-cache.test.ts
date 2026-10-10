/** Streamed ALAC: laptop decode cache (cap + LRU) and the migration plan
 *  that feeds the same stream-convert queue as AAC/MP3. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, utimes, stat, writeFile, readFile, mkdir, symlink, lstat, rename, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createStreamAlacCache, localFileNeedsStreamAlacDecode, ffmpegAlacToFlac } from '../stream-alac-cache.ts'
import { execFileSync } from 'child_process'
import { backfillAlacFingerprints, planLocalAlacMigration } from '../alac-stream-migrate.ts'
import { classifyActivitySyncTracks } from '../activity-boardable.ts'
import { stageTrackForSync } from '../ipod-sync-materialize.ts'

async function freshDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), name))
}

describe('streamed ALAC decode cache', () => {
  test('a range waits for the decode, then plays that slice of the FLAC', async () => {
    const dir = await freshDir('jt-salac-')
    let fetches = 0
    let transcodes = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const cache = createStreamAlacCache({
      dir,
      fetchRaw: async (_id, dest) => {
        fetches++
        await writeFile(dest, Buffer.from('raw-alac-master'))
      },
      transcode: async (_src, tmp) => {
        transcodes++
        await gate
        await writeFile(tmp, Buffer.from('0123456789abcdef'))
      },
      log: () => {},
    })
    const pending = cache.serve(42, 'bytes=4-7')
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(settled, false, 'a seek during decode must not be answered from a partial file')
    assert.equal(transcodes, 1)
    release()
    const res = await pending
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-type'), 'audio/flac')
    assert.equal(res.headers.get('x-jt-audio-source'), 'stream-alac-cache')
    assert.equal(res.headers.get('content-range'), 'bytes 4-7/16')
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '4567')
    assert.equal(fetches, 1)
    assert.equal(cache.inflightCount(), 0)
    const again = await cache.serve(42, 'bytes=0-3')
    assert.equal(Buffer.from(await again.arrayBuffer()).toString(), '0123')
    assert.equal(transcodes, 1, 'a landed FLAC is not decoded again')
    await rm(dir, { recursive: true, force: true })
  })

  test('concurrent plays of one track share one download and one decode', async () => {
    const dir = await freshDir('jt-salac-')
    let fetches = 0
    const cache = createStreamAlacCache({
      dir,
      fetchRaw: async (_id, dest) => {
        fetches++
        await new Promise((r) => setTimeout(r, 20))
        await writeFile(dest, Buffer.from('alac'))
      },
      transcode: async (_src, tmp) => { await writeFile(tmp, Buffer.from('FLAC-BYTES!!')) },
      log: () => {},
    })
    const [a, b] = await Promise.all([
      cache.serve('7', null),
      cache.serve('7', 'bytes=0-3'),
    ])
    assert.equal(fetches, 1)
    assert.equal(a.status, 200)
    assert.equal(Buffer.from(await a.arrayBuffer()).toString(), 'FLAC-BYTES!!')
    assert.equal(Buffer.from(await b.arrayBuffer()).toString(), 'FLAC')
    await rm(dir, { recursive: true, force: true })
  })

  test('cap evicts the least-recently-touched FLAC and keeps the one just written', async () => {
    const dir = await freshDir('jt-salac-')
    const cache = createStreamAlacCache({
      dir,
      capBytes: 2500,
      fetchRaw: async (_id, dest) => { await writeFile(dest, Buffer.from('x')) },
      transcode: async (_src, tmp) => { await writeFile(tmp, Buffer.alloc(1000, 1)) },
      log: () => {},
    })
    await cache.ensure('a')
    await cache.ensure('b')
    const names = async () => (await readdir(dir)).filter((n) => n.endsWith('.flac')).sort()
    const before = await names()
    assert.deepEqual(before, ['a.flac', 'b.flac'])
    await utimes(join(dir, 'a.flac'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    await utimes(join(dir, 'b.flac'), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000))
    await cache.ensure('c')
    const left = await names()
    assert.ok(left.includes('c.flac'), 'just-written entry must survive')
    assert.ok(!left.includes('a.flac'), 'oldest entry must be evicted')
    assert.ok(left.length <= 2)
    const bytes = await Promise.all(left.map(async (n) => (await stat(join(dir, n))).size))
    assert.ok(bytes.reduce((s, n) => s + n, 0) <= 2500)
    await rm(dir, { recursive: true, force: true })
  })

  test('a failed decode leaves no partial and can be retried', async () => {
    const dir = await freshDir('jt-salac-')
    let fail = true
    const cache = createStreamAlacCache({
      dir,
      fetchRaw: async (_id, dest) => { await writeFile(dest, Buffer.from('alac')) },
      transcode: async (_src, tmp) => {
        if (fail) throw new Error('ffmpeg died')
        await writeFile(tmp, Buffer.from('ok'))
      },
      log: () => {},
    })
    await assert.rejects(cache.serve(1, null), /ffmpeg died/)
    const junk = (await readdir(dir)).filter((n) => n.includes('partial') || n.endsWith('.flac'))
    assert.deepEqual(junk, [])
    assert.equal(cache.inflightCount(), 0)
    fail = false
    const res = await cache.serve(1, null)
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'ok')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('what needs the laptop decode', () => {
  test('a symlink or a missing file does; a real file does not', async () => {
    const dir = await freshDir('jt-salac-need-')
    const real = join(dir, 'real.m4a')
    const link = join(dir, 'link.m4a')
    await writeFile(real, 'bytes')
    await symlink(real, link)
    assert.equal(await localFileNeedsStreamAlacDecode(real, lstat), false)
    assert.equal(await localFileNeedsStreamAlacDecode(link, lstat), true)
    assert.equal(await localFileNeedsStreamAlacDecode(join(dir, 'gone.m4a'), lstat), true)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('ALAC already on the laptop', () => {
  test('queues a fingerprinted ALAC file and lists a real file that still needs a sha1', async () => {
    const dir = await freshDir('jt-salac-mig-')
    const music = join(dir, 'iPod_Control', 'Music', 'F01')
    await mkdir(music, { recursive: true })
    const real = join(music, 'imported_1.m4a')
    await writeFile(real, 'alac-bytes')
    const bare = join(music, 'imported_4.m4a')
    await writeFile(bare, 'no-fingerprint-yet')
    const link = join(music, 'imported_2.m4a')
    await symlink(join(dir, '.jt-streamed'), link)
    const colon = (name: string) => `:iPod_Control:Music:F01:${name}`
    const plan = await planLocalAlacMigration([
      { path: colon('imported_1.m4a'), codec: 'alac', audioFingerprint: 'sha1:aaaa|180000' },
      { path: colon('imported_2.m4a'), codec: 'alac', audioFingerprint: 'sha1:bbbb|180000' },
      { path: colon('imported_3.m4a'), codec: 'alac', audioFingerprint: 'sha1:cccc|180000' },
      { path: colon('imported_4.m4a'), codec: 'alac', duration: 180000 },
      { path: colon('imported_5.mp3'), codec: 'mp3', audioFingerprint: 'sha1:dddd|180000' },
    ], lstat, (c) => join(dir, c.replace(/:/g, '/').replace(/^\//, '')), 123)
    assert.deepEqual(plan.ready, [{
      ipodPath: colon('imported_1.m4a'),
      fingerprint: 'sha1:aaaa|180000',
      enqueuedAt: 123,
    }])
    assert.deepEqual(plan.needsFingerprint, [{
      ipodPath: colon('imported_4.m4a'),
      abs: bare,
      durationMs: 180000,
    }])
    const sleeps: number[] = []
    const queued: string[] = []
    const n = await backfillAlacFingerprints(
      plan.needsFingerprint,
      async (abs, dur) => `sha1:deadbeef|${dur}`,
      async (item) => { queued.push(`${item.ipodPath}|${item.fingerprint}`) },
      () => 50,
      async (ms) => { sleeps.push(ms) },
      250,
    )
    assert.equal(n, 1)
    assert.deepEqual(sleeps, [250])
    assert.deepEqual(queued, [`${colon('imported_4.m4a')}|sha1:deadbeef|180000`])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('iPod Mini mirror still gets the ALAC bytes', () => {
  test('a streamed ALAC symlink is staged from raw homemini bytes and the library link stays', async () => {
    const root = await freshDir('jt-salac-ipod-')
    const music = join(root, 'iPod_Control', 'Music', 'F03')
    const stage = join(root, 'stage')
    await mkdir(music, { recursive: true })
    const abs = join(music, 'imported_9.m4a')
    await symlink(join(root, '.jt-streamed'), abs)
    const colon = ':iPod_Control:Music:F03:imported_9.m4a'
    const classified = await classifyActivitySyncTracks(
      [{ id: 9, title: 'Hi Res', artist: 'Probe', path: colon, codec: 'alac' }],
      { localMount: root, pathSep: '/', lstat },
    )
    assert.equal(classified.toPull.length, 1)
    assert.equal(classified.toPull[0].path, colon)
    let url = ''
    const staged = await stageTrackForSync({
      colonPath: colon,
      trackId: 9,
      localMount: root,
      pathSep: '/',
      homeminiAudioBase: 'http://homemini:3000/audio',
      stageDir: stage,
      lstat, mkdir, writeFile, rename, unlink,
      fetchAudio: async (u) => {
        url = u
        return { ok: true, status: 200, buffer: Buffer.from('alac-master-bytes') }
      },
    })
    assert.equal(url, 'http://homemini:3000/audio/9')
    assert.equal(url.includes('fmt='), false)
    assert.equal(staged.ok, true)
    if (!staged.ok) return
    assert.equal(staged.staged, true)
    assert.equal(await readFile(staged.abs, 'utf-8'), 'alac-master-bytes')
    const st = await lstat(abs)
    assert.equal(st.isSymbolicLink(), true)
    await staged.cleanup()
    assert.equal(existsSync(staged.abs), false)
    assert.equal((await lstat(abs)).isSymbolicLink(), true)
    await rm(root, { recursive: true, force: true })
  })
})

// 2026-10-09: the cache decodes to `<id>.flac.partial`. ffmpeg picks the
// container from the last extension, ".partial" is none, so the real decode
// refused every streamed ALAC and the song sat on loading. The tests above
// stub the transcode, so only a real ffmpeg run catches this.
describe('the real ALAC → FLAC decode', () => {
  const haveFfmpeg = (() => {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
  })()

  test('writes FLAC to the cache\'s own .partial temp name', async (t) => {
    if (!haveFfmpeg) { t.skip('ffmpeg is not on PATH'); return }
    const dir = await freshDir('jt-salac-real-')
    try {
      // A 24-bit/48k ALAC like the one that failed ("makeup sex", 12440).
      const src = join(dir, '12440.alac.partial')
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
        '-ac', '2', '-c:a', 'alac', '-sample_fmt', 's32p', '-f', 'ipod', src])
      const tmp = join(dir, '12440.flac.partial')
      await ffmpegAlacToFlac(src, tmp)
      const head = (await readFile(tmp)).subarray(0, 4).toString('latin1')
      assert.equal(head, 'fLaC', 'the temp file is a FLAC stream')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
