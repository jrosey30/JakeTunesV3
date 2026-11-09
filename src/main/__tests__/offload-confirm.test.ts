/**
 * The gate before a local file becomes a link: homemini's own hash, nothing
 * downloaded to check (2026-11-09).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmHomeminiHoldsFile, localFileKey, sameRefusal, type HoldsFile } from '../offload-confirm.ts'
import { identityKey, type HomeminiIdentity, type OneIdentity } from '../audio-identity.ts'
import type { HomeminiPrefixProbe, RawOpen } from '../offload-audio.ts'

const WINDOW = 256 * 1024
const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex')
const fpOf = (b: Buffer): string => `sha1:${sha1(b.subarray(0, WINDOW)).slice(0, 16)}|1000`
// Same size, same audio, other tags at the front: the 203 "homemini stale" songs.
const mine = Buffer.concat([Buffer.alloc(WINDOW, 1), Buffer.alloc(200_000, 9)])
const retagged = Buffer.concat([Buffer.alloc(WINDOW, 2), Buffer.alloc(200_000, 9)])
// Same first 256 KB, another tail.
const otherTail = Buffer.concat([Buffer.alloc(WINDOW, 1), Buffer.alloc(200_000, 8)])
const identityOf = (b: Buffer, etag = '"v1"'): HomeminiIdentity => ({ size: b.length, sha1: sha1(b), etag })

describe('confirmHomeminiHoldsFile', () => {
  let dir = ''
  let file = ''
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jt-confirm-'))
    file = join(dir, 'song.m4a')
    await writeFile(file, mine)
  })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  /** A homemini that serves `served`; counts what was asked of it. */
  const hub = (served: Buffer | null, etag = '"v1"') => {
    const seen = { prefix: 0, whole: 0, wholeBytesRead: 0 }
    const fetchPrefix = async (): Promise<HomeminiPrefixProbe> => {
      seen.prefix++
      if (!served) return { transportError: false, status: 404, body: null }
      return { transportError: false, status: 206, body: served.subarray(0, WINDOW), etag, total: served.length }
    }
    const openRaw = async (): Promise<RawOpen> => {
      seen.whole++
      if (!served) return { ok: false, transportError: false, status: 404 }
      const stream = new ReadableStream<Uint8Array>({
        pull(c) { seen.wholeBytesRead += served.length; c.enqueue(served); c.close() },
      })
      return { ok: true, status: 200, contentLength: served.length, stream }
    }
    return { seen, fetchPrefix, openRaw }
  }
  const confirm = (identity: OneIdentity, h: ReturnType<typeof hub>, extra: Partial<Parameters<typeof confirmHomeminiHoldsFile>[0]> = {}): Promise<HoldsFile> =>
    confirmHomeminiHoldsFile({ id: 7, localAbs: file, audioBase: 'http://homemini:3000/audio', identity, allowWholeFile: false, fetchPrefix: h.fetchPrefix, openRaw: h.openRaw, ...extra })

  it('the same size and whole-file sha1, served now: replace, and nothing was downloaded whole', async () => {
    const h = hub(mine)
    const r = await confirm(identityOf(mine), h)
    assert.deepEqual(r, { ok: true, fullSha1: sha1(mine), bytes: mine.length, via: 'identity' })
    assert.deepEqual(h.seen, { prefix: 1, whole: 0, wholeBytesRead: 0 })
  })

  it('other tags at the same size (homemini stale): refused on the hash, remembered, nothing fetched at all', async () => {
    const h = hub(retagged)
    const r = await confirm(identityOf(retagged), h)
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, 'different')
    const st = await stat(file)
    assert.deepEqual(!r.ok && r.refused, { local: localFileKey(st), remote: identityKey(identityOf(retagged)) })
    assert.deepEqual(h.seen, { prefix: 0, whole: 0, wholeBytesRead: 0 })
  })

  it('the same refusal again: held without hashing this Mac’s file or asking for a byte', async () => {
    const h = hub(retagged)
    const first = await confirm(identityOf(retagged), h)
    let hashed = 0
    const r = await confirm(identityOf(retagged), h, { remembered: !first.ok ? first.refused : undefined, hashLocal: async () => { hashed++; throw new Error('not reached') } })
    assert.equal(!r.ok && r.reason, 'held')
    assert.equal(hashed, 0)
    assert.equal(h.seen.prefix + h.seen.whole, 0)
  })

  it('homemini’s copy changed since the refusal: checked again, and converts', async () => {
    const stale = await confirm(identityOf(retagged), hub(retagged))
    const h = hub(mine, '"v2"')
    const r = await confirm(identityOf(mine, '"v2"'), h, { remembered: !stale.ok ? stale.refused : undefined })
    assert.equal(r.ok, true)
  })

  it('this Mac’s file changed since the refusal: checked again', async () => {
    const stale = await confirm(identityOf(retagged), hub(retagged))
    const st = await stat(file)
    await utimes(file, st.atime, new Date(st.mtimeMs + 5000))
    let hashed = 0
    const r = await confirm(identityOf(retagged), hub(retagged), { remembered: !stale.ok ? stale.refused : undefined, hashLocal: async () => { hashed++; return { sha1: sha1(mine), bytes: mine.length } } })
    assert.equal(!r.ok && r.reason, 'different')
    assert.equal(hashed, 1, 'a new look, not the remembered answer')
    await utimes(file, st.atime, st.mtime)
  })

  it('another size is refused before this Mac’s file is even hashed', async () => {
    let hashed = 0
    const r = await confirm({ ...identityOf(mine), size: mine.length + 1 }, hub(mine), { hashLocal: async () => { hashed++; return { sha1: sha1(mine), bytes: mine.length } } })
    assert.equal(!r.ok && r.reason, 'different')
    assert.equal(hashed, 0)
  })

  it('a hash homemini took of a file it has since replaced can’t pass: the bytes it serves now are looked at', async () => {
    // homemini's answer says "your file", but what it serves has other tags at the front.
    const r = await confirm(identityOf(mine), hub(retagged))
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, 'different')
    // ...or says another size
    const grown = Buffer.concat([mine, Buffer.alloc(10)])
    const g = await confirm(identityOf(mine), hub(grown))
    assert.equal(!g.ok && g.reason, 'unreachable')
    // ...or doesn't say the size at all
    const h = hub(mine)
    const silent = await confirm(identityOf(mine), h, { fetchPrefix: async () => ({ transportError: false, status: 206, body: mine.subarray(0, WINDOW) }) })
    assert.equal(silent.ok, false)
  })

  it('a shared first 256 KB with another tail never replaces: the whole-file sha1 decides', async () => {
    const r = await confirm(identityOf(otherTail), hub(otherTail))
    assert.equal(!r.ok && r.reason, 'different')
  })

  it('this Mac’s file changing while it is hashed replaces nothing', async () => {
    let n = 0
    const st = await stat(file)
    const r = await confirm(identityOf(mine), hub(mine), { statLocal: async () => ({ size: st.size, mtimeMs: st.mtimeMs + (n++ ? 1000 : 0) }) })
    assert.equal(!r.ok && r.reason, 'unreachable')
  })

  it('no file on homemini, no answer, no bytes: none of them replaces', async () => {
    assert.equal(((await confirm(null, hub(mine))) as { reason?: string }).reason, 'missing')
    assert.equal(((await confirm('unreachable', hub(mine))) as { reason?: string }).reason, 'unreachable')
    assert.equal(((await confirm(identityOf(mine), hub(null))) as { reason?: string }).reason, 'missing')
    const down = await confirm(identityOf(mine), hub(mine), { fetchPrefix: async () => { throw new Error('down') } })
    assert.equal(!down.ok && down.reason, 'unreachable')
    const transcode = await confirmHomeminiHoldsFile({ id: 7, localAbs: file, audioBase: 'http://h/audio?fmt=flac', identity: identityOf(mine), allowWholeFile: true })
    assert.equal(!transcode.ok && transcode.reason, 'transcode')
  })

  it('a file homemini hasn’t hashed yet replaces nothing, whatever its size and date say', async () => {
    const h = hub(mine)
    const r = await confirm({ pending: true, size: mine.length, etag: '"v1"' }, h)
    assert.deepEqual(r, { ok: false, reason: 'pending' })
    assert.deepEqual(h.seen, { prefix: 0, whole: 0, wholeBytesRead: 0 })
  })

  // The gate that deletes local audio. It must be the whole file's sha1, taken on both sides.
  it('size alone never replaces: same size, same date, same first 256 KB served, another sha1', async () => {
    // homemini holds a file of this Mac's exact size whose audio differs past the first 256 KB.
    const h = hub(otherTail)
    const r = await confirm(identityOf(otherTail), h)
    assert.equal(r.ok, false, 'equal sizes and an equal front are not the file')
    // and an answer with the right size and a sha1 that is not a sha1 proves nothing
    for (const bad of ['', 'a'.repeat(39), sha1(mine).slice(0, 16), 'z'.repeat(40)]) {
      const x = await confirm({ size: mine.length, sha1: bad, etag: '"v1"' }, hub(mine))
      assert.equal(x.ok, false, `sha1 "${bad}" must not pass`)
    }
    // this Mac's own hash failing is not a match either
    const unread = await confirm(identityOf(mine), hub(mine), { hashLocal: async () => { throw new Error('EIO') } })
    assert.equal(unread.ok, false)
    const lying = await confirm(identityOf(mine), hub(mine), { hashLocal: async () => ({ sha1: sha1(retagged), bytes: mine.length }) })
    assert.equal(!lying.ok && lying.reason, 'different', 'it is this Mac’s hash against homemini’s, nothing else')
  })

  it('asked here when the caller didn’t: the one id, and a throw is no answer', async () => {
    const asked: Array<string | number> = []
    const r = await confirm(undefined as unknown as OneIdentity, hub(mine), { identity: undefined, askIdentity: async (id) => { asked.push(id); return identityOf(mine) } })
    assert.equal(r.ok, true)
    assert.deepEqual(asked, [7])
    const t = await confirm(undefined as unknown as OneIdentity, hub(mine), { identity: undefined, askIdentity: async () => { throw new Error('x') } })
    assert.equal(!t.ok && t.reason, 'unreachable')
  })

  describe('an older backend (no identity route): the old whole-file compare', () => {
    it('never runs when whole-file checks are off (away from home)', async () => {
      const h = hub(mine)
      const r = await confirm('unsupported', h, { allowWholeFile: false, libraryFingerprint: fpOf(mine) })
      assert.equal(!r.ok && r.reason, 'away')
      assert.deepEqual(h.seen, { prefix: 0, whole: 0, wholeBytesRead: 0 })
    })
    it('at home: prefix, then the whole body, and a match replaces', async () => {
      const h = hub(mine)
      const r = await confirm('unsupported', h, { allowWholeFile: true, libraryFingerprint: fpOf(mine) })
      assert.deepEqual(r, { ok: true, fullSha1: sha1(mine), bytes: mine.length, via: 'whole-file' })
      assert.deepEqual(h.seen, { prefix: 1, whole: 1, wholeBytesRead: mine.length })
    })
    it('the library’s fingerprint NOW is the pre-filter: a stale one stops before the whole file', async () => {
      const h = hub(mine)
      const r = await confirm('unsupported', h, { allowWholeFile: true, libraryFingerprint: fpOf(retagged) })
      assert.equal(!r.ok && r.reason, 'different')
      assert.equal(h.seen.whole, 0)
    })
    it('a whole-file refusal is remembered by homemini’s ETag and not downloaded again until it moves', async () => {
      const h = hub(otherTail)
      const first = await confirm('unsupported', h, { allowWholeFile: true, libraryFingerprint: fpOf(mine) })
      assert.equal(!first.ok && first.reason, 'different')
      assert.equal(h.seen.whole, 1)
      const memo = !first.ok ? first.refused : undefined
      assert.equal(memo?.remote, 'etag:"v1"')
      const again = await confirm('unsupported', h, { allowWholeFile: true, libraryFingerprint: fpOf(mine), remembered: memo })
      assert.equal(!again.ok && again.reason, 'held')
      assert.equal(h.seen.whole, 1, 'not downloaded a second time')
      const moved = hub(mine, '"v2"')
      const after = await confirm('unsupported', moved, { allowWholeFile: true, libraryFingerprint: fpOf(mine), remembered: memo })
      assert.equal(after.ok, true)
    })
  })

  it('sameRefusal needs both sides', () => {
    assert.equal(sameRefusal(undefined, { local: 'a', remote: 'b' }), false)
    assert.equal(sameRefusal({ local: 'a', remote: 'b' }, { local: 'a', remote: 'b' }), true)
    assert.equal(sameRefusal({ local: 'a', remote: 'c' }, { local: 'a', remote: 'b' }), false)
    assert.equal(sameRefusal({ local: 'x', remote: 'b' }, { local: 'a', remote: 'b' }), false)
  })
})

describe('the old whole-file compare reads no body it can already rule out', () => {
  it('a Content-Length that isn’t this Mac’s size: different, and the body is never pulled', async () => {
    const { compareOpened, totalFromHeaders } = await import('../offload-audio.ts')
    let pulled = 0
    let cancelled = 0
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(10)); c.close() }, cancel() { cancelled++ } }, { highWaterMark: 0 })
    const r = await compareOpened('http://h/audio/1', '/x', async () => ({ ok: true, status: 200, contentLength: 11, stream }), async () => ({ sha1: 'a'.repeat(40), bytes: 10 }))
    assert.deepEqual(r, { ok: false, reason: 'different' })
    assert.deepEqual([pulled, cancelled], [0, 1])
    // the same size is still read and hashed
    const body = Buffer.alloc(10, 4)
    const same = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(body); c.close() } })
    const ok = await compareOpened('http://h/audio/1', '/x', async () => ({ ok: true, status: 200, contentLength: 10, stream: same }), async () => ({ sha1: sha1(body), bytes: 10 }))
    assert.deepEqual(ok, { ok: true, fullSha1: sha1(body), bytes: 10 })
    assert.equal(totalFromHeaders(206, 'bytes 0-262143/11124599', '262144'), 11124599)
    assert.equal(totalFromHeaders(200, null, '500'), 500)
    assert.equal(totalFromHeaders(206, 'bytes 0-9/*', '10'), null)
    assert.equal(totalFromHeaders(404, null, '9'), null)
  })
})
