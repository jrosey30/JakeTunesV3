/**
 * One load reads one file (2026-11-14).
 *
 * Jake edited the artist of "Stalks (Greenpoint Mix)" while it played. The tag
 * write renamed a rewritten copy over the song, and the player's next Range
 * request 50 s later was read by path from the NEW file at an offset taken
 * from the old one: "DEMUXER_ERROR … PTS is not defined", a failed reload, a
 * skip. These tests run the hold on real files, renamed the way
 * audio-write-guard.ts renames them.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { contentSignature, createLoadHold, fileVersion, holdKey, serveHeldFile, splitAudioUrl, startsLoad, versionedUrl, type LoadHold } from '../audio-load-hold.ts'
import { writeVerified } from '../audio-write-guard.ts'

const dir = mkdtempSync(join(tmpdir(), 'jt-load-hold-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** A file whose every byte says which version it is and where it sits. */
function bytes(tag: number, size: number): Buffer {
  const b = Buffer.alloc(size)
  for (let i = 0; i < size; i++) b[i] = (i * 7 + tag * 101) & 0xff
  return b
}
let n = 0
function song(content: Buffer): { path: string; url: string; source: string } {
  const path = join(dir, `iPod_Control/Music/F43/imported_${15343 + n++}.m4a`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return { path, url: 'ipod-audio://' + encodeURIComponent(path), source: ':' + path.slice(path.indexOf('iPod_Control')).replace(/\//g, ':') }
}

/** The tag write-back's swap: a rewritten copy renamed over the song. */
async function rewriteUnder(path: string, content: Buffer): Promise<void> {
  const r = await writeVerified(path, async (tmp) => { writeFileSync(tmp, content); return { ok: true } }, { check: async () => ({ ok: true }) })
  assert.equal(r.ok, true)
}
const body = async (r: Response): Promise<Buffer> => Buffer.from(await r.arrayBuffer())
const hold = (over: Partial<Parameters<typeof createLoadHold>[0]> = {}): LoadHold => createLoadHold({ open: (p) => open(p, 'r'), ...over })
/** What the handler does for one request. */
async function request(h: LoadHold, s: { path: string; url: string; source: string }, url: string, range: string | null): Promise<Response> {
  const { base, version } = splitAudioUrl(url)
  if (!startsLoad(range)) {
    const held = h.continue(holdKey(base, version), range)
    if (held) return held
  }
  return serveHeldFile(h, { url, path: s.path, source: s.source, range, contentType: 'audio/mp4', label: 'local' })
}

describe('a load reads the file it opened first', () => {
  test("Jake's story: a tag write renames a new file over the playing song, and the next piece is still the old file's", async () => {
    const A = bytes(1, 200_000), B = bytes(2, 260_000)   // mutagen grew the tags: the audio moved
    const s = song(A)
    const h = hold()
    const first = await request(h, s, s.url, 'bytes=0-')
    assert.equal(first.status, 206)
    const head = (await body(first)).subarray(0, 1000)
    assert.deepEqual(head, A.subarray(0, 1000))
    await rewriteUnder(s.path, B)                          // 19:10:19, the Get Info edit
    const later = await request(h, s, s.url, 'bytes=150000-159999')   // ~50 s later
    assert.equal(later.status, 206)
    assert.equal(later.headers.get('Content-Range'), `bytes 150000-159999/${A.length}`, 'the old file\'s length, as the player was told')
    assert.deepEqual(await body(later), A.subarray(150000, 160000), 'the old file\'s bytes, never the new file at the old offsets')
  })

  test('without the hold (the path read again) that piece is the new file: the splice the hold prevents', async () => {
    const A = bytes(3, 200_000), B = bytes(4, 260_000)
    const s = song(A)
    await rewriteUnder(s.path, B)
    const fh = await open(s.path, 'r')
    const buf = Buffer.alloc(10_000)
    await fh.read(buf, 0, 10_000, 150000)
    await fh.close()
    assert.notDeepEqual(buf, A.subarray(150000, 160000))
  })

  test('a suffix range (an MP4 index at the end) is a piece of the load, not a new one', async () => {
    assert.equal(startsLoad(null), true)
    assert.equal(startsLoad('bytes=0-'), true)
    assert.equal(startsLoad('bytes=0-1023'), true)
    assert.equal(startsLoad('bytes=-4096'), false)
    assert.equal(startsLoad('bytes=4096-'), false)
    const A = bytes(5, 50_000), B = bytes(6, 70_000)
    const s = song(A)
    const h = hold()
    await body(await request(h, s, s.url, 'bytes=0-'))
    await rewriteUnder(s.path, B)
    const tail = await request(h, s, s.url, 'bytes=-4096')
    assert.deepEqual(await body(tail), A.subarray(A.length - 4096))
  })

  test('a range the file cannot satisfy is 416, a garbage header gets the whole file', async () => {
    const A = bytes(7, 10_000)
    const s = song(A)
    const h = hold()
    await body(await request(h, s, s.url, null))
    const r416 = await request(h, s, s.url, 'bytes=20000-')
    assert.equal(r416.status, 416)
    assert.equal(r416.headers.get('Content-Range'), 'bytes */10000')
    const whole = await request(h, s, s.url, 'bytes=10-20, 30-40')   // multi-range: not a load start, served whole as before
    assert.equal(whole.status, 200)
    assert.deepEqual(await body(whole), A)
  })
})

describe('a reload after a real rewrite gets the new file whole', () => {
  test('a new load (byte 0) after the rewrite reads the new file, whole, and its pieces stay on it', async () => {
    const A = bytes(8, 120_000), B = bytes(9, 150_000)
    const s = song(A)
    const h = hold()
    assert.deepEqual(await body(await request(h, s, s.url, 'bytes=0-')), A)
    await rewriteUnder(s.path, B)
    const reload = await request(h, s, s.url, 'bytes=0-')
    assert.equal(reload.status, 206)
    assert.equal(reload.headers.get('Content-Range'), `bytes 0-${B.length - 1}/${B.length}`)
    assert.deepEqual(await body(reload), B, 'the new file, whole: no old byte in it')
    assert.deepEqual(await body(await request(h, s, s.url, 'bytes=100000-109999')), B.subarray(100000, 110000))
  })

  test('a URL marked ?v= (the renderer side of the marker) is the same file, held as its own load', async () => {
    const A = bytes(10, 30_000), B = bytes(11, 40_000)
    const s = song(A)
    const h = hold()
    assert.deepEqual(splitAudioUrl(s.url + '?v=abc-1'), { base: s.url, version: 'abc-1' })
    assert.deepEqual(splitAudioUrl(s.url), { base: s.url, version: null })
    assert.equal(splitAudioUrl(s.url + '?v=../../etc').version, null, 'only a version-shaped marker')
    await body(await request(h, s, s.url, null))           // the old load, still held
    await rewriteUnder(s.path, B)
    const marked = versionedUrl(s.url, fileVersion(statSync(s.path)))
    assert.deepEqual(await body(await request(h, s, marked, null)), B, 'the marked reload: the new file whole')
    assert.deepEqual(await body(await request(h, s, s.url, 'bytes=1000-1999')), A.subarray(1000, 2000), 'the old load, untouched by it')
    assert.deepEqual(await body(await request(h, s, marked, 'bytes=1000-1999')), B.subarray(1000, 2000))
  })

  test('a reload that asks only for the middle (Chromium remembers the header per URL) reads the file that header came from', async () => {
    const A = bytes(15, 90_000), B = bytes(16, 99_000)
    const s = song(A)
    const h = hold()
    await body(await request(h, s, s.url, 'bytes=0-'))
    await rewriteUnder(s.path, B)
    // The recovery reload: a new element on the same URL; its first request is mid-file.
    assert.deepEqual(await body(await request(h, s, s.url, 'bytes=30000-39999')), A.subarray(30000, 40000))
  })

  test('a piece of a load whose hold closed (idle) is refused, not spliced, when the file changed; served when it did not', async () => {
    let t = 0
    const A = bytes(13, 80_000), B = bytes(14, 90_000)
    const s = song(A)
    const h = hold({ now: () => t, idleMs: 1000 })
    await body(await request(h, s, s.url, 'bytes=0-'))
    t += 5000
    h.sweep()
    assert.equal(h.stats().open, 0)
    const same = await request(h, s, s.url, 'bytes=1000-1999')
    assert.deepEqual(await body(same), A.subarray(1000, 2000), 'unchanged: reopened and served')
    t += 5000
    h.sweep()
    await rewriteUnder(s.path, B)
    const changed = await request(h, s, s.url, 'bytes=2000-2999')
    assert.equal(changed.status, 409)
    assert.equal(h.stats().refused, 1)
  })
})

describe('holds are closed, never leaked, never closed under a reader', () => {
  const fds = (): number => readdirSync('/dev/fd').length

  test('2,000 loads of 60 songs: every file opened is closed, and no more than `max` stay open', async () => {
    await new Promise((r) => setTimeout(r, 100))
    const songs = Array.from({ length: 60 }, (_, i) => song(bytes(20 + i, 4096)))
    let t = 0
    const h = hold({ now: () => t, max: 8, idleMs: 60_000 })
    const before = fds()
    for (let i = 0; i < 2000; i++) {
      const s = songs[i % songs.length]
      t += 10
      const r = await request(h, s, s.url, i % 3 === 0 ? null : 'bytes=0-')
      await body(r)
      if (i % 2) await body(await request(h, s, s.url, 'bytes=100-199'))
    }
    await new Promise((r) => setImmediate(r))
    const st = h.stats()
    assert.ok(st.open <= 8, `${st.open} holds open`)
    assert.equal(st.opened - st.closed, st.open)
    t += 120_000
    h.sweep()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(h.stats().open, 0)
    assert.ok(fds() <= before, `${fds()} descriptors open, ${before} before: one left behind`)
  })

  test('a reader that is cancelled mid-piece (the player moved on) releases its file', async () => {
    let t = 0
    const s = song(bytes(90, 2_000_000))
    const h = hold({ now: () => t, idleMs: 1000 })
    const before = fds()
    const r = await request(h, s, s.url, 'bytes=0-')
    const reader = r.body!.getReader()
    await reader.read()
    await reader.cancel()
    await new Promise((res) => setTimeout(res, 50))
    assert.equal(h.stats().reading, 0)
    t += 5000
    h.sweep()
    await new Promise((res) => setTimeout(res, 50))
    assert.ok(fds() <= before, `${fds()} descriptors open, ${before} before`)
  })

  test('a new load of the same song never closes the file under a piece still being sent', async () => {
    const A = bytes(91, 1_000_000)
    const s = song(A)
    const h = hold()
    const slow = await request(h, s, s.url, 'bytes=0-')   // not read yet
    await body(await request(h, s, s.url, 'bytes=0-'))     // the next load replaces the hold
    assert.deepEqual(await body(slow), A, 'the first piece still reads, whole')
    await new Promise((res) => setTimeout(res, 50))
    assert.equal(h.stats().open, 1, 'and its file closed once it was sent')
  })

  test('holdsSource: a song whose file a load holds is in use until the hold closes', async () => {
    let t = 0
    const s = song(bytes(92, 5000))
    const h = hold({ now: () => t, idleMs: 1000 })
    assert.equal(h.holdsSource(s.source), false)
    await body(await request(h, s, s.url, null))
    assert.equal(h.holdsSource(s.source), true)
    t += 5000
    assert.equal(h.holdsSource(s.source), false)
  })
})

describe('review of #425: a dropped piece can\'t hold a song open forever', () => {
  const fds = (): number => readdirSync('/dev/fd').length

  test('200 pieces Electron dropped without cancelling: not counted as being read after 2 min, and the hold closes after its idle window', async () => {
    let t = 0
    const s = song(bytes(40, 400_000))
    const h = hold({ now: () => t, idleMs: 15 * 60_000, pieceStaleMs: 2 * 60_000 })
    await new Promise((r) => setTimeout(r, 50))
    const before = fds()
    const dropped: Response[] = []
    dropped.push(await request(h, s, s.url, 'bytes=0-'))
    for (let i = 1; i < 200; i++) { t += 100; dropped.push(await request(h, s, s.url, `bytes=${i * 1000}-`)) }   // never read, never cancelled
    assert.equal(h.stats().reading, 200)
    assert.equal(h.holdsSource(s.source), true, 'the song is in use while they are fresh')
    t += 2 * 60_000
    h.sweep()
    assert.equal(h.stats().reading, 0, 'none still counts as being read')
    assert.equal(h.stats().stale, 200)
    assert.equal(h.holdsSource(s.source), true, 'the hold itself stays for its idle window: a paused song is still in use')
    const next = await request(h, s, s.url, 'bytes=0-')      // a new load replaces the hold with its 200 dropped pieces
    t += 15 * 60_000
    assert.equal(h.holdsSource(s.source), false, 'and then the song is free: its tag edit can land')
    assert.equal(h.stats().abandoned, 201, 'the replaced hold closes on its idle window too')
    assert.equal(h.stats().open, 0)
    void next
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(fds() <= before, `${fds()} descriptors open, ${before} before`)
    // A dropped piece read after its file closed fails; it never reads anything else.
    await assert.rejects(dropped[5].arrayBuffer())
  })

  test('a replaced hold whose piece the player just stopped pulling (repeat one) is not closed under it before its idle window', async () => {
    let t = 0
    const A = bytes(48, 2_000_000)
    const s = song(A)
    const h = hold({ now: () => t, idleMs: 15 * 60_000, pieceStaleMs: 2 * 60_000 })
    const playing = await request(h, s, s.url, 'bytes=0-')
    const reader = playing.body!.getReader()
    const got: Uint8Array[] = [(await reader.read()).value!]
    await body(await request(h, s, s.url, 'bytes=0-'))      // the same song loaded again: its hold is replaced
    t += 5 * 60_000                                          // the playing song has enough buffered: no pull for 5 minutes
    h.sweep()
    for (;;) { const { done, value } = await reader.read(); if (done) break; got.push(value) }
    assert.deepEqual(Buffer.concat(got), A, 'it reads on, whole')
    assert.equal(h.stats().abandoned, 0)
  })

  test('a hold with a piece "in flight" but nobody reading closes after its idle window', async () => {
    let t = 0
    const s = song(bytes(41, 100_000))
    const h = hold({ now: () => t, idleMs: 1000 })
    await request(h, s, s.url, 'bytes=0-')                   // never read
    assert.equal(h.stats().reading, 1)
    t += 1000
    h.sweep()
    assert.equal(h.stats().open, 0)
    assert.equal(h.stats().reading, 0)
    assert.equal(h.stats().abandoned, 1)
  })

  test('a piece being read slowly is never counted as dropped while it is read', async () => {
    let t = 0
    const A = bytes(42, 3_000_000)
    const s = song(A)
    const h = hold({ now: () => t, idleMs: 15 * 60_000, pieceStaleMs: 2 * 60_000 })
    const r = await request(h, s, s.url, 'bytes=0-')
    const reader = r.body!.getReader()
    const got: Uint8Array[] = []
    for (;;) {
      t += 60_000                                            // a pull a minute: slow, never stale
      h.sweep()
      const { done, value } = await reader.read()
      if (done) break
      got.push(value)
    }
    assert.deepEqual(Buffer.concat(got), A)
    assert.equal(h.stats().abandoned, 0)
    assert.equal(h.stats().ended, 1)
  })

  test('the queue\'s view: a song whose pieces were dropped is written once the hold has gone idle', async () => {
    let t = 0
    const s = song(bytes(43, 50_000))
    const h = hold({ now: () => t })
    for (let i = 0; i < 5; i++) await request(h, s, s.url, i ? `bytes=${i * 100}-` : 'bytes=0-')
    t += 16 * 60_000
    assert.equal(h.holdsSource(s.source), false)
  })
})

describe('review of #425: only a real byte change is refused', () => {
  test('after a long pause, a date-only change (touch) is served, not refused', async () => {
    let t = 0
    const A = bytes(44, 200_000)
    const s = song(A)
    const h = hold({ now: () => t, idleMs: 1000 })
    await body(await request(h, s, s.url, 'bytes=0-'))
    t += 5000; h.sweep()
    const later = new Date(Date.now() + 60_000)
    await utimes(s.path, later, later)
    const r = await request(h, s, s.url, 'bytes=100000-109999')
    assert.equal(r.status, 206)
    assert.deepEqual(await body(r), A.subarray(100000, 110000))
    assert.equal(h.stats().sameBytes, 1)
    assert.equal(h.stats().refused, 0)
  })

  test('the same bytes written again (a copy renamed over it) are served', async () => {
    let t = 0
    const A = bytes(45, 200_000)
    const s = song(A)
    const h = hold({ now: () => t, idleMs: 1000 })
    await body(await request(h, s, s.url, 'bytes=0-'))
    t += 5000; h.sweep()
    await rewriteUnder(s.path, Buffer.from(A))
    assert.equal((await request(h, s, s.url, 'bytes=5000-5999')).status, 206)
  })

  test('a same-size tag change at the start, or at the end, is refused', async () => {
    for (const where of ['start', 'end'] as const) {
      let t = 0
      const A = bytes(46, 200_000)
      const s = song(A)
      const h = hold({ now: () => t, idleMs: 1000 })
      await body(await request(h, s, s.url, 'bytes=0-'))
      t += 5000; h.sweep()
      const B = Buffer.from(A)
      B[where === 'start' ? 100 : B.length - 100] ^= 0xff
      await rewriteUnder(s.path, B)
      assert.equal((await request(h, s, s.url, 'bytes=5000-5999')).status, 409, where)
    }
  })

  test('contentSignature: an MP4 whose audio moved differs even with equal edges and size; a date does not count', async () => {
    const atom = (type: string, len: number): Buffer => { const b = Buffer.alloc(len); b.writeUInt32BE(len, 0); b.write(type, 4, 'latin1'); return b }
    const tail = Buffer.alloc(70_000, 7)
    const mk = (moov: number, free: number): Buffer => Buffer.concat([atom('ftyp', 24), atom('moov', moov), atom('free', free), atom('mdat', 200_000), tail])
    const same1 = song(mk(100_000, 1000)), same2 = song(mk(100_000, 1000))
    // The same size, the same first and last 64 KB, but the audio starts 1,000 bytes earlier:
    const moved = song(Buffer.concat([atom('ftyp', 24), atom('moov', 100_000), atom('mdat', 200_000), atom('free', 1000), tail]))
    const sig = async (p: string): Promise<string> => { const fh = await open(p, 'r'); try { return await contentSignature(fh, (await fh.stat()).size) } finally { await fh.close() } }
    assert.equal(await sig(same1.path), await sig(same2.path))
    assert.match(await sig(same1.path), /^\d+:101024:/, 'the audio offset is read from the atoms')
    assert.notEqual(await sig(same1.path), await sig(moved.path))
    assert.match(await sig(song(bytes(47, 1000)).path), /^1000:null:/, 'not an MP4: size and edges only')
  })
})

describe('the ipod-audio:// handler is wired to the hold', () => {
  const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const start = index.indexOf("protocol.handle('ipod-audio'")
  const handler = index.slice(start, index.indexOf('const menu = Menu.buildFromTemplate(menuTemplate)', start))

  test('the path never carries the marker, and a piece of a held load is answered from the hold first', () => {
    assert.match(handler, /const audioUrl = splitAudioUrl\(request\.url\)\s*\n\s*const rawPath = decodeURIComponent\(audioUrl\.base\.replace\('ipod-audio:\/\/', ''\)\)/)
    const early = handler.indexOf('audioLoadHold.continue(holdKey(audioUrl.base, audioUrl.version)')
    assert.ok(early > 0, 'no early answer from the hold')
    assert.ok(early < handler.indexOf('isHomeminiPlaybackClientCached()'), 'the hold is asked before anything re-picks the source')
  })

  test('both local serves go through the hold; nothing in the handler opens the file by path any more', () => {
    assert.equal(handler.match(/return serveLocal\(filePath, ext, '(local|local-cache)'\)/g)?.length, 2)
    assert.doesNotMatch(handler, /createReadStream\(filePath/)
    assert.match(index, /const audioLoadHold = createLoadHold\(\{ open: \(p\) => open\(p, 'r'\)/)
  })
})
